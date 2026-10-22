#!/usr/bin/env python3
"""Drive pi-skill-toggle's model-facing behaviour through the checkout's pinned Pi CLI (RPC mode).

An offline recorder provider stands in for the model: prompt caching, toggle notes, the read
guard, and subagents following the parent. Exit codes: 0 pass, 1 fail, 2 blocked.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify import pi_command  # noqa: E402 - the TUI helper owns the pinned-Pi lookup

ROOT = Path(__file__).resolve().parents[4]
RECORDER = Path(__file__).resolve().parent / 'recorder-provider.ts'
# A/B runs: point PI_SKILL_TOGGLE_EXTENSION at another build's index.ts, at launch and drive.
TOGGLE = Path(os.environ.get('PI_SKILL_TOGGLE_EXTENSION') or ROOT / 'packages/pi-skill-toggle/index.ts')
CLAUDE_SDK = ROOT / 'packages/pi-claude-sdk/index.ts'
SCENARIOS = ['steady', 'toggle-mid', 'toggle-back', 'toggle-twice', 'instruction-off', 'guard', 'subagent']
# Scenarios whose prompts script tool calls; live mode never sends them to a real model.
SCRIPTED = {'guard', 'subagent'}
# pi-subagents runs children in-process; override with PI_SKILL_TOGGLE_SUBAGENTS_EXTENSION.
SUBAGENTS = Path(os.environ.get('PI_SKILL_TOGGLE_SUBAGENTS_EXTENSION')
                 or Path.home() / '.pi/agent/npm/node_modules/@gotgenes/pi-subagents/src/index.ts')
SKILL_FILES = {'proj-review': 'work/.claude/skills/proj-review/SKILL.md',
               'legacy-notes': 'agent/skills/legacy-notes/SKILL.md',
               'proj-deploy': 'work/.agents/skills/proj-deploy/SKILL.md',
               'research': 'agent/skills/research/SKILL.md'}
# Tool outcomes each scripted journey expects, in call order: (label, tool, skill, allowed).
# The subagent journey checks the child's calls; the guard journey checks the main session's.
EXPECTED_CALLS = {
    'guard': [('read legacy-notes (disabled)', 'read', 'legacy-notes', False),
              ('read proj-deploy (project skill, default off)', 'read', 'proj-deploy', False),
              ('read research (enabled)', 'read', 'research', True),
              ('read proj-review after /skill:proj-review', 'read', 'proj-review', True),
              ('main-session bash cat legacy-notes (bash is not guarded)', 'bash', 'legacy-notes', True),
              ('read research after it is disabled mid-session', 'read', 'research', False)],
    'subagent': [('child read proj-review (the parent invoked it)', 'read', 'proj-review', True),
                 ('child read legacy-notes (disabled)', 'read', 'legacy-notes', False),
                 ('child read proj-deploy (project skill, default off)', 'read', 'proj-deploy', False),
                 ('child bash cat legacy-notes (subagent shell guard)', 'bash', 'legacy-notes', False)],
}
TOOL_MARKERS = ('READ-FILES: ', 'RUN-BASH: ', 'SPAWN-CHILD')
NOTE_HEADER = 'The user changed /skill-toggle.'
DEBUG_ENV = 'PI_SKILL_TOGGLE_CACHE_DEBUG'
MODELS = ['codex-like', 'collapse-like']
PROMPTS = ['Summarise the project in one sentence.', 'Which skills could help with a release?',
           'List three risks in this repository.', 'Suggest a commit message for a typo fix.',
           'Reply with a short closing remark.']
GLOBAL_SKILLS = {
    'research': 'Investigate unfamiliar libraries, APIs, and error messages with primary sources before changing code.',
    'code-review': 'Review a diff for correctness, security, and maintainability; report findings by severity.',
    'git-workflow': 'Create branches, write conventional commit messages, and prepare pull requests safely.',
    'testing': 'Design focused unit and integration tests, choose fixtures, and diagnose flaky tests.',
    'docs-writer': 'Write and restructure README, CHANGELOG, and reference documentation in plain English.',
    'legacy-notes': 'Consult archived migration notes for the retired v1 deployment pipeline.',
}
PROJECT_SKILLS = {
    '.agents/skills/proj-deploy': 'Deploy this project to the staging cluster using the release checklist.',
    '.claude/skills/proj-review': 'Apply this project\'s house review checklist to pending changes.',
}
# Mutations applied immediately before the prompt with this 0-based index.
PLANS = {
    'steady': {},
    'toggle-mid': {2: [('agent/skills/research/SKILL.md', 'disabled'), ('work/.agents/skills/proj-deploy/SKILL.md', 'enabled')]},
    'toggle-back': {2: [('agent/skills/research/SKILL.md', 'disabled'), ('work/.agents/skills/proj-deploy/SKILL.md', 'enabled')],
                    4: [('agent/skills/research/SKILL.md', None), ('work/.agents/skills/proj-deploy/SKILL.md', None)]},
    'toggle-twice': {2: [('agent/skills/research/SKILL.md', 'disabled')],
                     3: [('agent/skills/code-review/SKILL.md', 'disabled')]},
    'instruction-off': {2: [('agent/AGENTS.md', 'disabled')]},
    'guard': {4: [('agent/skills/research/SKILL.md', 'disabled')]},
    'subagent': {},
}


def prompts_for(scenario, scratch):
    """Prompts per scenario. Recorder markers script tool calls (see recorder-provider.ts)."""
    def path(name):
        return str(scratch / SKILL_FILES[name])
    if scenario == 'guard':
        return [f"READ-FILES: {path('legacy-notes')}|{path('proj-deploy')}|{path('research')}",
                '/skill:proj-review Check the pending change.',
                f"READ-FILES: {path('proj-review')}",
                f"RUN-BASH: cat {path('legacy-notes')}",
                f"READ-FILES: {path('research')}"]
    if scenario == 'subagent':
        reads = '|'.join(path(n) for n in ('proj-review', 'legacy-notes', 'proj-deploy'))
        return ['/skill:proj-review Check the pending change.',
                f"SPAWN-CHILD\nREAD-FILES: {reads}\nRUN-BASH: cat {path('legacy-notes')}",
                'Reply with a short closing remark.']
    return PROMPTS


def expected_requests(prompts):
    """One request per prompt, plus one follow-up for each prompt that makes tool calls."""
    return len(prompts) + sum(1 for p in prompts if any(m in p for m in TOOL_MARKERS))


def tool_outcomes(requests):
    """Each read and bash call in the session's last request, in order, with whether it ran."""
    if not requests:
        return []
    msgs = requests[-1]['messages']
    results = {m.get('toolCallId'): m for m in msgs if m.get('role') == 'toolResult'}
    outcomes = []
    for m in msgs:
        if m.get('role') != 'assistant':
            continue
        for b in m.get('content') or []:
            if not (isinstance(b, dict) and b.get('type') == 'toolCall' and b.get('name') in ('read', 'bash')):
                continue
            args, result = b.get('arguments') or {}, results.get(b.get('id'))
            outcomes.append({'tool': b['name'], 'target': args.get('path') or args.get('command') or '',
                             'allowed': None if result is None else not result.get('isError'),
                             'text': '' if result is None else any_text(result.get('content', ''))[:200]})
    return outcomes
INITIAL = [('agent/skills/legacy-notes/SKILL.md', 'disabled')]


def stop(p):
    if p.poll() is None:
        try:
            p.stdin.close() if p.stdin else None
            p.wait(timeout=10)
        except (subprocess.TimeoutExpired, BrokenPipeError):
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()


def skill_md(name, description):
    return f'---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n\n{description}\n\n1. Read the task.\n2. Apply the steps.\n'


def write_state(scratch, changes, overrides=None):
    """Apply override changes; keys are written for both the /tmp and realpath forms."""
    overrides = dict(overrides or {})
    for rel, value in changes:
        for key in {str(scratch / rel), os.path.realpath(scratch / rel)}:
            if value is None:
                overrides.pop(key, None)
            else:
                overrides[key] = value
    path = scratch / 'agent/pi-skill-toggle.json'
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps({'version': 6, 'overrides': overrides}, indent=2))
    os.replace(tmp, path)
    return overrides


# ---- pi-ai transcript semantics (utils/text.js, utils/transcript.js) reproduced ----
def content_text(content):
    if isinstance(content, str):
        return content
    return '\n'.join(b.get('text', '') for b in content or [] if b.get('type') == 'text')


def any_text(content):
    if isinstance(content, str):
        return content
    return '\n'.join(b['text'] if b.get('type') == 'text' else json.dumps(b, sort_keys=True) for b in content or [])


def system_text(m):
    parts = [content_text(m.get('content', ''))] + [v for v in (m.get('sections') or {}).values() if v is not None]
    return '\n\n'.join(p for p in parts if p)


def update_text(m):
    parts = [t] if (t := content_text(m.get('content', ''))) else []
    for name, value in (m.get('sections') or {}).items():
        parts.append(f'Removed system prompt section "{name}".' if value is None
                     else f'Updated system prompt section "{name}":\n\n{value}')
    return '\n\n'.join(parts)


def current_system(messages):
    content, sections, seen = [], {}, False
    for m in messages:
        if m.get('role') != 'system':
            continue
        seen = True
        if t := content_text(m.get('content', '')):
            content.append(t)
        for name, value in (m.get('sections') or {}).items():
            if value is None:
                sections.pop(name, None)
            else:
                sections[name] = value
    return {'role': 'system', 'content': '\n\n'.join(content), 'sections': sections} if seen else None


def render(messages, mid):
    if not mid:
        head = current_system(messages)
        messages = ([head] if head else []) + [m for m in messages if m.get('role') != 'system']
    out = []
    for i, m in enumerate(messages):
        role = m.get('role')
        if role == 'system':
            out.append('<system>\n' + (system_text(m) if i == 0 else update_text(m)))
        else:
            out.append(f'<{role}>\n' + any_text(m.get('content', '')))
    return '\n</>\n'.join(out)


def notes(messages):
    """Toggle notes as the provider sees them: Pi converts the custom message to a user message."""
    texts = (any_text(m.get('content', '')) for m in messages if m.get('role') in ('user', 'custom'))
    return [t for t in texts if t.startswith(NOTE_HEADER)]


DISABLED_SKILL_PREFIXES = ('Disabled skills (do not load unless the user invokes /skill:<name>): ',
                           'Disabled skills (do not load or use): ')


def latest_note(messages):
    """Each note states every difference from the system prompt, so only the latest one counts."""
    found = notes(messages)
    return found[-1] if found else None


def visible_skills(messages):
    """Skills the model may use: the system prompt's list, overridden by the latest toggle note."""
    names = list(GLOBAL_SKILLS) + [Path(rel).name for rel in PROJECT_SKILLS]
    section = (current_system(messages) or {}).get('sections', {}).get('skills') or ''
    visible = {s for s in names if f'<name>{s}</name>' in section}
    text = latest_note(messages)
    if text is None:
        return sorted(visible)
    for line in text.splitlines():
        prefix = next((p for p in DISABLED_SKILL_PREFIXES if line.startswith(p)), None)
        if prefix:
            visible -= set(line[len(prefix):].split(', '))
    enabled = text.split('Enabled skills:', 1)
    if len(enabled) == 2:
        block = enabled[1].split('</available_skills>', 1)[0]
        visible |= {s for s in names if f'<name>{s}</name>' in block}
    return sorted(visible)


def instruction_visible(messages, path_suffix):
    """Whether an instruction file ending in path_suffix is still in force for the model."""
    context = (current_system(messages) or {}).get('sections', {}).get('project_context') or ''
    visible = any(seg.split('">', 1)[0].endswith(path_suffix) for seg in context.split('<project_instructions path="')[1:])
    text = latest_note(messages)
    if text is None:
        return visible
    for line in text.splitlines():
        if line.startswith('Disabled instructions (disregard): ') and any(
                p.endswith(path_suffix) for p in line.split(': ', 1)[1].split(', ')):
            visible = False
    if any(seg.split('">', 1)[0].endswith(path_suffix) for seg in text.split('<project_instructions path="')[1:]):
        visible = True
    return visible


def debug_summary(path):
    records = [json.loads(x) for x in path.read_text().splitlines() if x]
    epochs, usage = {}, {'input': 0, 'cacheRead': 0, 'cacheWrite': 0, 'output': 0}
    for r in records:
        if r.get('type') == 'run':
            epochs[r.get('epoch')] = epochs.get(r.get('epoch'), 0) + 1
        if r.get('type') == 'usage':
            for k in usage:
                usage[k] += r.get(k) or 0
    runs = [r for r in records if r.get('type') == 'run']
    return {'records': len(records), 'epochs': epochs,
            'notes': sum(1 for r in runs if r.get('note')),
            'stateLoadFailures': sum(1 for r in runs if r.get('stateLoad') != 'ok'),
            'skillsFingerprints': len({r.get('skillsFingerprint') for r in runs}),
            'contextFingerprints': len({r.get('contextFingerprint') for r in runs}),
            'usage': usage}


def common_prefix(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def analyse_run(run_dir, steady_min, strict=False):
    recorded = [json.loads(x) for x in (run_dir / 'requests.jsonl').read_text().splitlines() if x]
    meta = json.loads((run_dir / 'run.json').read_text())
    # Subagent requests share the recorder file; the first request is always the parent's.
    parent_id = recorded[0].get('sessionId') if recorded else None
    lines = [r for r in recorded if r.get('sessionId') == parent_id]
    children = [r for r in recorded if r.get('sessionId') != parent_id]
    rows = request_rows(lines)
    child_rows = [r for sid in dict.fromkeys(c.get('sessionId') for c in children)
                  for r in request_rows([c for c in children if c.get('sessionId') == sid])]
    checks = []
    later = [r for r in rows[1:]]
    if meta['scenario'] == 'steady':
        ok = all(r['reusePercent'] is not None and r['reusePercent'] >= steady_min for r in later) and all(r['systemPatchMessages'] == 0 for r in rows)
        checks.append({'name': f'steady reuse >= {steady_min}% after request 1, no patches', 'passed': ok})
    if rows:
        checks.append({'name': 'legacy-notes hidden from request 1', 'passed': 'legacy-notes' not in rows[0]['skillsVisible']})
    if meta['scenario'] in ('toggle-mid', 'toggle-back') and len(rows) >= 3:
        checks.append({'name': 'research disabled and proj-deploy enabled for the model (request 3)',
                       'passed': 'research' not in rows[2]['skillsVisible'] and 'proj-deploy' in rows[2]['skillsVisible']})
    if meta['scenario'] == 'toggle-back' and len(rows) >= 5:
        checks.append({'name': 'research enabled and proj-deploy disabled again (request 5)',
                       'passed': 'research' in rows[4]['skillsVisible'] and 'proj-deploy' not in rows[4]['skillsVisible']})
    if meta['scenario'] == 'toggle-twice' and len(rows) >= 4:
        checks.append({'name': 'research and code-review both disabled (request 4)',
                       'passed': not {'research', 'code-review'} & set(rows[3]['skillsVisible'])})
    if meta['scenario'] == 'instruction-off' and len(rows) >= 3:
        checks.append({'name': 'global AGENTS.md in force before, disregarded after (requests 2, 3)',
                       'passed': rows[1]['globalInstructionsVisible'] and not rows[2]['globalInstructionsVisible']})
    if strict:
        checks.append({'name': 'strict: no system patch after request 1',
                       'passed': all(r['systemPatchMessages'] == 0 for r in rows + child_rows)})
    outcomes = []
    if meta['scenario'] in EXPECTED_CALLS:
        outcomes = tool_outcomes(children if meta['scenario'] == 'subagent' else lines)
        for i, (label, tool, skill, allowed) in enumerate(EXPECTED_CALLS[meta['scenario']]):
            o = outcomes[i] if i < len(outcomes) else {}
            checks.append({'name': f"{label}: {'allowed' if allowed else 'blocked'}",
                           'passed': o.get('tool') == tool and o.get('target', '').endswith(SKILL_FILES[skill])
                           and o.get('allowed') == allowed
                           and (allowed or 'do not retry' in o.get('text', ''))})
    if meta['scenario'] == 'subagent':
        checks.append({'name': 'child requests recorded', 'passed': len(children) >= 2})
        checks.append({'name': f'child reuse >= {steady_min}% after its request 1',
                       'passed': all(r['reusePercent'] is not None and r['reusePercent'] >= steady_min
                                     for r in child_rows if r['request'] > 1)})
    want = expected_requests(meta.get('prompts') or PROMPTS)
    checks.append({'name': f'{want} requests recorded', 'passed': len(rows) == want})
    summary = rows_summary(rows)
    if child_rows:
        summary['child'] = {**rows_summary(child_rows), 'firstRequestChars': child_rows[0]['renderedChars'],
                            'skillsVisible': child_rows[0]['skillsVisible']}
    return {**meta, 'requests': rows, 'childRequestRows': child_rows, 'summary': summary, 'checks': checks,
            'childRequests': len(children), 'toolOutcomes': outcomes,
            'status': 'passed' if all(c['passed'] for c in checks) else 'failed'}


def rows_summary(rows):
    later = rows[1:]
    total_prev = sum(r['previousChars'] for r in later)
    return {'requests': len(rows), 'totalRenderedChars': sum(r['renderedChars'] for r in rows),
            'totalUnreusedCharsAfterFirst': sum(r['unreusedChars'] for r in later),
            'weightedReusePercentAfterFirst': round(100 * sum(r['commonPrefixChars'] for r in later) / total_prev, 2) if total_prev else None,
            'minReusePercent': min((r['reusePercent'] for r in later if r['reusePercent'] is not None), default=None),
            'finalSystemPatchMessages': rows[-1]['systemPatchMessages'] if rows else 0,
            'finalNoteMessages': rows[-1]['noteMessages'] if rows else 0,
            'finalNoteChars': rows[-1]['noteChars'] if rows else 0}


def request_rows(lines):
    """Per-request rendering metrics for one session's requests, in order."""
    rows, prev = [], None
    for n, req in enumerate(lines, 1):
        msgs = req['messages']
        mid = bool((req.get('compat') or {}).get('supportsMidConvoSystemMessages'))
        text = render(msgs, mid)
        prefix = common_prefix(prev, text) if prev is not None else 0
        patches = [{'messageIndex': i, 'sections': {k: (None if v is None else len(v)) for k, v in (m.get('sections') or {}).items()},
                    'next': msgs[i + 1].get('role') if i + 1 < len(msgs) else None,
                    'previous': msgs[i - 1].get('role') if i else None}
                   for i, m in enumerate(msgs) if m.get('role') == 'system' and i > 0]
        found = notes(msgs)
        rows.append({'request': n, 'rendering': 'mid-convo' if mid else 'collapsed', 'renderedChars': len(text),
                     'commonPrefixChars': prefix, 'previousChars': len(prev) if prev is not None else 0,
                     'unreusedChars': len(text) - prefix,
                     'reusePercent': round(100 * prefix / len(prev), 2) if prev else None,
                     'systemPatchMessages': len(patches), 'patches': patches,
                     'roles': [m.get('role') + (f":{m.get('customType')}" if m.get('customType') else '') for m in msgs],
                     'noteMessages': len(found), 'noteChars': sum(len(t) for t in found),
                     'skillsVisible': visible_skills(msgs),
                     'globalInstructionsVisible': instruction_visible(msgs, '/agent/AGENTS.md')})
        prev = text
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('action', choices=['launch', 'doctor', 'drive', 'report', 'compare', 'cleanup'])
    ap.add_argument('--evidence', required=True, type=Path)
    ap.add_argument('--scenario', choices=SCENARIOS + ['all'], default='all')
    ap.add_argument('--model', choices=MODELS + ['all'], default='all')
    ap.add_argument('--live', choices=['claude-sdk'], help='use the real claude-sdk provider (subscription allowance)')
    ap.add_argument('--live-model', default='claude-sdk/claude-4.5-haiku')
    ap.add_argument('--confirm-subscription-usage', action='store_true', help='required with --live')
    ap.add_argument('--steady-min-reuse', type=float, default=100.0)
    ap.add_argument('--strict', action='store_true', help='also fail any system prompt patch after request 1')
    ap.add_argument('--baseline', type=Path, help='compare: an earlier report.json')
    a = ap.parse_args()
    evidence = a.evidence.resolve()
    if evidence.is_relative_to(ROOT) or not str(evidence).startswith(('/tmp/', '/private/tmp/')):
        ap.error('evidence must be outside the checkout under /tmp')
    evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(evidence, 0o700)
    statefile = evidence / 'state.json'
    if a.action == 'launch':
        if statefile.exists():
            ap.error('use a fresh evidence directory per run')
        scratch = Path(tempfile.mkdtemp(prefix='pi-skill-toggle-model-', dir='/tmp'))
        agent, work = scratch / 'agent', scratch / 'work'
        for name, desc in GLOBAL_SKILLS.items():
            (agent / 'skills' / name).mkdir(parents=True)
            (agent / 'skills' / name / 'SKILL.md').write_text(skill_md(name, desc))
        (agent / 'AGENTS.md').write_text('# Global instructions\n\nPrefer small, reviewed changes. Explain trade-offs briefly.\n')
        # The parent ignores these (--no-extensions plus explicit -e); subagent children build
        # their own resource loader from settings, so this is how they load the extensions.
        child_exts = [str(TOGGLE), str(RECORDER)] + ([str(SUBAGENTS)] if SUBAGENTS.is_file() else [])
        child_exts += ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search']
        (agent / 'settings.json').write_text(json.dumps({'quietStartup': True, 'retry': {'enabled': False},
                                                         'compaction': {'enabled': False},
                                                         'extensions': child_exts}, indent=2))
        work.mkdir()
        (work / 'AGENTS.md').write_text('# Project instructions\n\nThis is a fixture service. Run `npm test` before committing.\n')
        for rel, desc in PROJECT_SKILLS.items():
            (work / rel).mkdir(parents=True)
            (work / rel / 'SKILL.md').write_text(skill_md(Path(rel).name, desc))
        (work / 'README.md').write_text('# Fixture service\n')
        subprocess.run(['git', 'init', '-q'], cwd=work, check=True)
        subprocess.run(['git', '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', '-A'], cwd=work, check=True)
        subprocess.run(['git', '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture'], cwd=work, check=True)
        (scratch / 'home').mkdir()
        write_state(scratch, INITIAL)
        command, version = pi_command()
        statefile.write_text(json.dumps({'scratch': str(scratch), 'root': str(ROOT), 'piCommand': command,
                                         'piVersion': version}, indent=2))
        print(f'LAUNCHED isolated state: {scratch}; evidence: {evidence}')
        return 0
    if not statefile.exists():
        print('BLOCKED: run launch first')
        return 2
    state = json.loads(statefile.read_text())
    assert state['root'] == str(ROOT), 'wrong checkout'
    scratch = Path(state['scratch'])
    assert scratch.parent == Path('/tmp') and scratch.name.startswith('pi-skill-toggle-model-')
    if a.action == 'cleanup':
        shutil.rmtree(scratch, ignore_errors=True)
        (evidence / 'cleanup.json').write_text(json.dumps({'scratchRemoved': not scratch.exists(), 'evidenceRetained': True}))
        print(f'CLEANED {scratch}; evidence retained at {evidence}')
        return 0
    if a.action == 'compare':
        return compare(evidence, a.baseline)
    if a.action == 'report':
        runs = sorted(p.parent for p in (evidence / 'runs').glob('*/requests.jsonl')) if (evidence / 'runs').exists() else []
        if not runs:
            print('BLOCKED: no recorded runs')
            return 2
        report = {'criteria': {'steadyMinReusePercent': a.steady_min_reuse, 'strict': a.strict}, 'runs': {}}
        for run_dir in runs:
            result = analyse_run(run_dir, a.steady_min_reuse, a.strict)
            if (run_dir / 'cache-debug.jsonl').exists():
                result['cacheDebug'] = debug_summary(run_dir / 'cache-debug.jsonl')
            diag = run_dir / 'pi.stderr'
            if diag.exists():
                result['claudeSdkCache'] = [json.loads(x.split(' ', 1)[1]) for x in diag.read_text().splitlines() if x.startswith('[claude-sdk-cache] ')]
            report['runs'][run_dir.name] = result
        report['status'] = 'passed' if all(r['status'] == 'passed' for r in report['runs'].values()) else 'failed'
        (evidence / 'report.json').write_text(json.dumps(report, indent=2))
        table = ['run | req | rendering | chars | prefix | unreused | reuse% | patches | notes | roles',
                 '--- | --- | --- | --- | --- | --- | --- | --- | --- | ---']
        for name, r in report['runs'].items():
            for q in r['requests']:
                table.append(f"{name} | {q['request']} | {q['rendering']} | {q['renderedChars']} | {q['commonPrefixChars']} | {q['unreusedChars']} | {q['reusePercent']} | {q['systemPatchMessages']} | {q['noteMessages']} | {','.join(q['roles'])}")
            if 'cacheDebug' in r:
                table.append(f"{name} | debug | {json.dumps(r['cacheDebug'])}")
            table.append(f"{name} | summary | {json.dumps(r['summary'])} | {r['status']} | {[c['name'] for c in r['checks'] if not c['passed']]}")
        (evidence / 'report.txt').write_text('\n'.join(table) + '\n')
        print('\n'.join(table))
        print(f"REPORT {report['status'].upper()}: {evidence / 'report.json'}")
        return 0 if report['status'] == 'passed' else 1

    env = {k: os.environ[k] for k in ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'] if k in os.environ}
    env.update(PI_CODING_AGENT_DIR=str(scratch / 'agent'), PI_OFFLINE='1', PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0')
    if not a.live:
        env['HOME'] = str(scratch / 'home')  # Offline: keep the user's ~/.agents and ~/.claude skills out.
    if 'PI_SKILL_TOGGLE_CACHE_DEBUG' in os.environ:
        env['PI_SKILL_TOGGLE_CACHE_DEBUG'] = os.environ['PI_SKILL_TOGGLE_CACHE_DEBUG']
    provider = CLAUDE_SDK if a.live else RECORDER
    pi = state['piCommand']
    base = [*pi, '--no-extensions', '--extension', str(TOGGLE), '--extension', str(provider),
            '--no-prompt-templates', '--no-themes', '--no-mcp', '--approve', '--offline']

    if a.action == 'doctor':
        version = subprocess.run([*pi, '--version'], capture_output=True, text=True, env=env, timeout=60)
        listing = subprocess.run(base + ['--list-models', 'recorder'], capture_output=True, text=True, env=env, cwd=scratch / 'work', timeout=120)
        (evidence / 'doctor.txt').write_text(f'{version.stdout}{version.stderr}\n---\n{listing.stdout}{listing.stderr}')
        ok = version.returncode == 0 and listing.returncode == 0 and all(m in listing.stdout for m in MODELS) and scratch.exists()
        print(f"{'PASSED' if ok else 'FAILED'} doctor: Pi {version.stdout.strip()}; recorder models listed={ok}; "
              f"pi-subagents={'found' if SUBAGENTS.is_file() else 'missing (subagent scenario blocked)'}")
        return 0 if ok else 1

    if a.live and not a.confirm_subscription_usage:
        print('BLOCKED: --live consumes subscription allowance; add --confirm-subscription-usage after checking allowance with verify-pi-claude-sdk commands')
        return 2
    scenarios = SCENARIOS if a.scenario == 'all' else [a.scenario]
    if a.live:
        # Scripted tool calls need the recorder; never send them to a real model.
        if a.scenario in SCRIPTED:
            print(f'BLOCKED: the {a.scenario} scenario scripts tool calls and needs the recorder (no --live)')
            return 2
        scenarios = [s for s in scenarios if s not in SCRIPTED]
    if not SUBAGENTS.is_file():
        if a.scenario == 'subagent':
            print(f'BLOCKED: subagent scenario needs {SUBAGENTS}')
            return 2
        scenarios = [s for s in scenarios if s != 'subagent']
    models = ([a.live_model] if a.live else (MODELS if a.model == 'all' else [a.model]))
    results = {}
    for scenario in scenarios:
        for model in models:
            label = f"{scenario}-{'live' if a.live else model}"
            try:
                drive_one(evidence, scratch, env, base, scenario, model if a.live else f'recorder/{model}', label, a.live)
                results[label] = 'passed'
            except Exception as exc:  # noqa: BLE001 - recorded as evidence
                results[label] = f'failed: {exc}'
            print(f'{label}: {results[label]}')
    (evidence / 'drive-results.json').write_text(json.dumps(results, indent=2))
    return 0 if all(v == 'passed' for v in results.values()) else 1


def drive_one(evidence, scratch, env, base, scenario, model, label, live):
    run_dir = evidence / 'runs' / label
    run_dir.mkdir(parents=True, exist_ok=False)
    sessions = scratch / 'sessions' / label
    sessions.mkdir(parents=True)
    env = dict(env, PI_SKILL_TOGGLE_RECORDER_FILE=str(run_dir / 'requests.jsonl'))
    if live:
        env['PI_CLAUDE_SDK_CACHE_DIAGNOSTICS'] = '1'
    if env.get(DEBUG_ENV) not in (None, '', '0'):
        # One debug file per run, so records never mix across scenarios.
        env[DEBUG_ENV] = str(run_dir / 'cache-debug.jsonl')
    overrides = write_state(scratch, INITIAL)
    extra = ['--extension', str(SUBAGENTS)] if scenario == 'subagent' else []
    cmd = base + extra + ['--mode', 'rpc', '--session-dir', str(sessions), '--model', model]
    prompts = prompts_for(scenario, scratch)
    (run_dir / 'run.json').write_text(json.dumps({'scenario': scenario, 'model': model, 'argv': cmd, 'cwd': str(scratch / 'work'),
                                                  'prompts': prompts,
                                                  'plan': {str(k): v for k, v in PLANS[scenario].items()}, 'initial': INITIAL}, indent=2))
    q = queue.Queue()
    with (run_dir / 'pi.stderr').open('wb') as err, (run_dir / 'rpc.jsonl').open('w') as log:
        p = subprocess.Popen(cmd, cwd=scratch / 'work', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, start_new_session=True)
        (run_dir / 'pi.pid').write_text(str(p.pid))

        def reader():
            for line in p.stdout:
                q.put(line)
            q.put(None)
        threading.Thread(target=reader, daemon=True).start()

        def send(obj):
            log.write(json.dumps({'direction': 'send', 'record': obj}) + '\n'); log.flush()
            p.stdin.write(json.dumps(obj).encode() + b'\n'); p.stdin.flush()

        def until(pred, seconds):
            deadline = time.monotonic() + seconds
            while True:
                line = q.get(timeout=max(0.1, deadline - time.monotonic()))
                assert line is not None, 'Pi exited early; see pi.stderr'
                obj = json.loads(line)
                log.write(json.dumps({'direction': 'receive', 'record': obj}) + '\n'); log.flush()
                if obj.get('type') == 'message_end' and obj.get('message', {}).get('stopReason') in ('error', 'aborted'):
                    raise AssertionError(f"assistant error: {obj['message'].get('errorMessage')}")
                if pred(obj):
                    return obj
                assert time.monotonic() < deadline, 'RPC deadline'
        try:
            send({'id': 'state', 'type': 'get_state'})
            until(lambda o: o.get('type') == 'response' and o.get('id') == 'state', 60)
            for i, prompt in enumerate(prompts):
                if i in PLANS[scenario]:
                    overrides = write_state(scratch, PLANS[scenario][i], overrides)
                    shutil.copy2(scratch / 'agent/pi-skill-toggle.json', run_dir / f'state-before-prompt-{i + 1}.json')
                send({'id': f'p{i + 1}', 'type': 'prompt', 'message': prompt})
                resp = until(lambda o: o.get('type') == 'response' and o.get('id') == f'p{i + 1}', 60)
                assert resp.get('success'), resp
                until(lambda o: o.get('type') == 'agent_settled', 300 if live else 60)
        finally:
            stop(p)
            (run_dir / 'pi.exit').write_text(str(p.returncode))
    for f in sessions.glob('**/*.jsonl'):
        shutil.copy2(f, run_dir / f'session-{f.name}')
    if live and not (run_dir / 'requests.jsonl').exists():
        # Live mode has no recorder; reconstruct requests from the session is out of scope.
        (run_dir / 'requests.jsonl').write_text('')


def compare(evidence, baseline):
    current_path = evidence / 'report.json'
    if baseline is None or not baseline.is_file() or not current_path.is_file():
        print('BLOCKED: compare needs report.json in the evidence directory and --baseline <report.json>')
        return 2
    old = json.loads(baseline.read_text())['runs']
    new = json.loads(current_path.read_text())['runs']
    rows = ['run | baseline reuse% | reuse% | delta | baseline unreused | unreused | delta | patches | notes',
            '--- | --- | --- | --- | --- | --- | --- | --- | ---']
    out = {}
    for name in sorted(new):
        n, o = new[name]['summary'], (old.get(name) or {}).get('summary', {})
        def delta(key):
            return None if o.get(key) is None or n.get(key) is None else round(n[key] - o[key], 2)
        out[name] = {'reuseDelta': delta('weightedReusePercentAfterFirst'),
                     'unreusedDelta': delta('totalUnreusedCharsAfterFirst')}
        rows.append(f"{name} | {o.get('weightedReusePercentAfterFirst')} | {n.get('weightedReusePercentAfterFirst')} | "
                    f"{out[name]['reuseDelta']} | {o.get('totalUnreusedCharsAfterFirst')} | {n.get('totalUnreusedCharsAfterFirst')} | "
                    f"{out[name]['unreusedDelta']} | {o.get('finalSystemPatchMessages')}->{n.get('finalSystemPatchMessages')} | "
                    f"{n.get('finalNoteMessages', 0)}")
    (evidence / 'compare.json').write_text(json.dumps({'baseline': str(baseline), 'runs': out}, indent=2))
    (evidence / 'compare.txt').write_text('\n'.join(rows) + '\n')
    print('\n'.join(rows))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
