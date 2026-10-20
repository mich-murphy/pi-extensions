#!/usr/bin/env python3
"""Real Pi CLI/RPC journeys; isolated state and durable, private evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[4]
IDS = ['claude-5.5-sonnet', 'claude-5.5-opus', 'claude-5.1-fable',
       'claude-5.5-haiku', 'claude-4.5-haiku']


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


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('action', choices=['launch', 'doctor', 'catalog', 'commands', 'metadata', 'live', 'cache', 'all', 'cleanup'])
    ap.add_argument('--evidence', required=True, type=Path)
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
        scratch = Path(tempfile.mkdtemp(prefix='pi-claude-sdk-state-', dir='/tmp'))
        (scratch / 'agent').mkdir()
        (scratch / 'work').mkdir()
        # No saved provider configuration, sessions, package discovery, or credentials.
        (scratch / 'agent/settings.json').write_text(json.dumps({'quietStartup': True, 'retry': {'enabled': False}}))
        statefile.write_text(json.dumps({'scratch': str(scratch), 'root': str(ROOT), 'pi': shutil.which('pi')}, indent=2))
        print(f'LAUNCHED isolated state: {scratch}; evidence: {evidence}')
        return 0
    state = json.loads(statefile.read_text())
    assert state['root'] == str(ROOT), 'wrong checkout'
    scratch = Path(state['scratch'])
    assert scratch.parent == Path('/tmp') and scratch.name.startswith('pi-claude-sdk-state-')
    if a.action == 'cleanup':
        shutil.rmtree(scratch, ignore_errors=True)
        (evidence / 'cleanup.json').write_text(json.dumps({'scratchRemoved': not scratch.exists(), 'evidenceRetained': True}))
        print(f'CLEANED {scratch}; evidence retained at {evidence}')
        return 0
    assert scratch.exists(), 'run launch with a new evidence directory'
    # Explicit allowlist: never inherit API/cloud routing or credential variables.
    env = {k: os.environ[k] for k in ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME'] if k in os.environ}
    env.update(PI_CODING_AGENT_DIR=str(scratch / 'agent'), PI_OFFLINE='1',
               PI_SKIP_VERSION_CHECK='1', PI_TELEMETRY='0')
    base = [state['pi'], '--no-session', '--no-extensions', '--extension',
            str(ROOT / 'packages/pi-claude-sdk/index.ts'), '--no-skills',
            '--no-prompt-templates', '--no-themes', '--no-context-files',
            '--no-mcp', '--no-approve', '--offline']
    results = {}

    def record(name, status, reason=''):
        results[name] = {'status': status, 'reason': reason}
        (evidence / f'{a.action}-results.json').write_text(json.dumps(results, indent=2))
        print(f'{status.upper()} {name}: {reason}')

    def run(name, cmd, cwd=None, timeout=180):
        (evidence / f'{name}.command.json').write_text(json.dumps({'argv': cmd, 'cwd': str(cwd or scratch / 'work'), 'isolatedAgentDir': env['PI_CODING_AGENT_DIR']}, indent=2))
        with (evidence / f'{name}.stdout').open('wb') as out, (evidence / f'{name}.stderr').open('wb') as err:
            p = subprocess.Popen(cmd, cwd=cwd or scratch / 'work', env=env, stdout=out, stderr=err, start_new_session=True)
            (evidence / f'{name}.pid').write_text(str(p.pid))
            try:
                rc = p.wait(timeout=timeout)
            finally:
                stop(p)
        (evidence / f'{name}.exit').write_text(str(rc))
        assert rc == 0, f'{name} exit {rc}; inspect evidence'
        return (evidence / f'{name}.stdout').read_text()

    def rpc_commands():
        cmd = base + ['--mode', 'rpc', '--model', 'claude-sdk/claude-5.5-sonnet', '--no-tools']
        (evidence / 'commands.command.json').write_text(json.dumps({'argv': cmd, 'cwd': str(scratch / 'work')}, indent=2))
        q = queue.Queue()
        with (evidence / 'commands.stderr').open('wb') as err, (evidence / 'commands.jsonl').open('w') as log:
            p = subprocess.Popen(cmd, cwd=scratch / 'work', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, start_new_session=True)
            (evidence / 'commands.pid').write_text(str(p.pid))
            def reader():
                for line in p.stdout:
                    q.put(line)
                q.put(None)
            threading.Thread(target=reader, daemon=True).start()
            def request(kind, **fields):
                rid = str(time.monotonic_ns())
                obj = dict(id=rid, type=kind, **fields)
                log.write(json.dumps({'direction': 'send', 'record': obj}) + '\n'); log.flush()
                p.stdin.write(json.dumps(obj).encode() + b'\n'); p.stdin.flush()
                notices = []
                deadline = time.monotonic() + 45
                while True:
                    line = q.get(timeout=max(0.1, deadline - time.monotonic()))
                    assert line is not None, 'Pi exited before response'
                    obj = json.loads(line)
                    log.write(json.dumps({'direction': 'receive', 'record': obj}) + '\n'); log.flush()
                    if obj.get('type') == 'extension_ui_request' and obj.get('method') == 'notify':
                        notices.append(obj)
                    # Slash handlers emit notify before the prompt response.
                    if obj.get('type') == 'response' and obj.get('id') == rid:
                        assert obj['success'], obj
                        return obj.get('data', {}), notices
                    assert time.monotonic() < deadline, 'RPC deadline'
            try:
                data, _ = request('get_state')
                assert data['model']['provider'] == 'claude-sdk'
                assert not data.get('sessionFile'), 'session unexpectedly persisted'
                data, _ = request('get_commands')
                names = {x['name'] for x in data['commands']}
                assert {'claude-sdk-status', 'claude-sdk-usage'} <= names
                _, notices = request('prompt', message='/claude-sdk-status')
                text = '\n'.join(x['message'] for x in notices)
                assert all(s in text for s in ['Agent SDK:', 'Bundled Claude Code:', 'Installed Claude Code:'] + IDS), text
                record('status', 'passed', 'real slash command emitted version and model mapping notification')
                _, notices = request('prompt', message='/claude-sdk-usage')
                text = '\n'.join(x['message'] for x in notices)
                (evidence / 'usage-notification.txt').write_text(text)
                assert 'remaining' in text and 'resets' in text, 'usage unavailable: ' + text
                record('usage', 'passed', 'real slash command displayed allowance and reset time (no model prompt)')
            finally:
                stop(p)
                (evidence / 'commands.exit').write_text(str(p.returncode))
        assert not list((scratch / 'agent').glob('sessions/**/*.jsonl'))

    def copy_gate():
        dest = scratch / 'gate'
        if not dest.exists():
            dest.mkdir()
            for name in ['package.json', 'package-lock.json', 'vitest.live.config.ts', 'vitest.config.ts', 'tsconfig.json']:
                shutil.copy2(ROOT / name, dest / name)
            shutil.copytree(ROOT / 'packages/pi-claude-sdk', dest / 'packages/pi-claude-sdk')
            (dest / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        return dest

    def allowance_ok():
        rpc_commands()  # Refresh allowance immediately before any prompt.
        usage = (evidence / 'usage-notification.txt').read_text()
        allowances = [float(x) for x in re.findall(r': ([0-9.]+)% remaining', usage)]
        return 'Extra usage: disabled' in usage and bool(allowances) and min(allowances) > 0

    actions = ['doctor', 'catalog', 'commands', 'metadata', 'live', 'cache'] if a.action == 'all' else [a.action]
    for action in actions:
        try:
            if action == 'doctor':
                version = run('doctor-version', [state['pi'], '--version']).strip()
                assert (ROOT / 'node_modules/@anthropic-ai/claude-agent-sdk/package.json').exists()
                run('doctor-claude-version', ['claude', '--version'])
                record('doctor', 'passed', f'Pi {version}; installed SDK and Claude executable; scratch state exists; auth not asserted')
            elif action == 'catalog':
                text = run('catalog', base + ['--list-models', 'claude-sdk'])
                assert all(x in text for x in IDS), text
                rows = {parts[1]: parts[2:] for line in text.splitlines()
                        if len(parts := line.split()) >= 6 and parts[0] == 'claude-sdk'}
                expected = {model: ['1M', '128K', 'yes', 'yes'] for model in IDS}
                expected['claude-5.1-fable'] = ['1M', '64K', 'yes', 'yes']
                expected['claude-4.5-haiku'] = ['200K', '32K', 'yes', 'yes']
                assert rows == expected, f'unexpected catalog values: {rows}'
                record('catalog', 'passed', 'real CLI listed all five models with SDK context/output limits, thinking and images')
            elif action == 'commands':
                rpc_commands()
            elif action == 'metadata':
                output = run('metadata', ['npm', 'run', 'test:live', '--', 'packages/pi-claude-sdk/test/sdk-live-contract.live.ts', '-t', 'model metadata resolves'], cwd=copy_gate())
                assert re.search(r'Tests\s+1 passed', output), 'metadata test did not run'
                record('metadata', 'passed', 'real SDK supportedModels metadata only; filtered run does NOT attest live gate')
            elif action == 'live':
                if not allowance_ok():
                    record('live', 'blocked', 'require current usage evidence with extra usage disabled and available allowance')
                    continue
                # User path beyond protocol tests: actual Pi text response, then read-only tool execution.
                text = run('live-text', base + ['--model', 'claude-sdk/claude-5.1-fable', '--no-tools', '--print', 'Reply with exactly CLAUDE_SDK_TEXT_OK.'])
                assert text.strip() == 'CLAUDE_SDK_TEXT_OK', text
                fixture = scratch / 'work/probe.txt'
                fixture.write_text('CLAUDE_SDK_READ_OK\n')
                before = hashlib.sha256(fixture.read_bytes()).hexdigest()
                stream = run('live-read', base + ['--model', 'claude-sdk/claude-5.1-fable', '--tools', 'read', '--mode', 'json', 'Use the read tool to read probe.txt. After receiving the tool result, reply with ONLY the file contents, verbatim. Do not add a filename, introduction, quotation marks, code fences, or any other text.'])
                events = [json.loads(x) for x in stream.splitlines() if x]
                assert any(x.get('type') == 'tool_execution_end' and x.get('toolName') == 'read' and not x.get('isError') for x in events), 'no successful Pi read execution in live-read.stdout'
                messages = [x['message'] for x in events if x.get('type') == 'message_end']
                assert any(x.get('role') == 'assistant' and x.get('stopReason') == 'stop' and any(c.get('text', '').strip() == 'CLAUDE_SDK_READ_OK' for c in x.get('content', [])) for x in messages), 'no clean final answer containing only the fixture marker in live-read.stdout'
                assert before == hashlib.sha256(fixture.read_bytes()).hexdigest()
                (evidence / 'live-read-side-effect.json').write_text(json.dumps({'unchangedSha256': before}))
                gate = copy_gate()
                run('upgrade-gate', ['npm', 'run', 'test:claude-sdk-upgrade'], cwd=gate, timeout=1200)
                shutil.copy2(gate / 'packages/pi-claude-sdk/sdk-release-contract.json', evidence / 'sdk-release-contract.json')
                record('live', 'passed', 'Pi text/read journeys and complete unfiltered upgrade gate passed in disposable copy')
            elif action == 'cache':
                if not allowance_ok():
                    record('cache', 'blocked', 'require current usage evidence with extra usage disabled and available allowance')
                    continue
                # Same owned source snapshot as the gate; production runner, default env, no proxy.
                gate = copy_gate()
                probe = [str(ROOT / 'node_modules/.bin/jiti'), str(Path(__file__).resolve().parent / 'cache-probe.ts'),
                         '--package', str(gate / 'packages/pi-claude-sdk')]
                try:
                    run('cache-probe', probe, cwd=gate, timeout=900)
                except AssertionError:
                    if (evidence / 'cache-probe.exit').read_text().strip() != '2':
                        raise
                    record('cache', 'blocked', 'probe hit auth/usage limit; see cache-probe.stdout')
                    continue
                report = json.loads((evidence / 'cache-probe.stdout').read_text())
                assert report.get('status') == 'passed', report.get('error') or report.get('checks')
                record('cache', 'passed', 'live cache checks passed: ' + ', '.join(report['checks']))
        except Exception as exc:
            record(action, 'failed', str(exc))
    return 1 if any(x['status'] == 'failed' for x in results.values()) else (2 if any(x['status'] == 'blocked' for x in results.values()) else 0)


if __name__ == '__main__':
    raise SystemExit(main())
