---
name: verify-pi-skill-toggle
description: Verify pi-skill-toggle end to end with the checkout's pinned Pi devDependency - menu usability, keyboard changes, persistence, restart, and repository-wide worktree policy through an isolated real terminal UI, plus prompt caching, toggle notes, the read guard, and subagents following the parent through RPC with an offline recorder model. Use after changing toggle UI, discovery, state, prompt-filter, guard, or cache behavior; no provider calls unless live mode is explicitly confirmed.
---

# Verify pi-skill-toggle

Read [the feature map](features/README.md) before driving. This skill controls
**real Pi**, not a mocked component. Only drive instances this helper creates.
All paths below are relative to this skill directory unless shown from the
checkout root.

## Launch

From the checkout root, with the documented development dependencies installed
(`npm install`), run:

```sh
.agents/skills/verify-pi-skill-toggle/scripts/verify.py doctor
.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature all
```

The helper is executable and resolves the checkout from its own location. It
requires Python 3 (stdlib only), Node, Git, tmux, and the checkout's installed
pinned Pi devDependency (`node_modules/@earendil-works/pi-coding-agent`). The
expected version is read from the root `package.json` `devDependencies` entry for
`@earendil-works/pi-coding-agent`, which must be an exact version; a dependency
bump needs no helper edit.
The helper runs that package's declared `bin` entry with Node. It never executes
a global `pi` on PATH, which may be a different version (the doctor reports it as
`globalPiOnPathNotUsed`). This keeps the verified Pi identical to the version the
package is type-checked and tested against. No build is needed: Pi loads the
package's TypeScript entry point directly.

Each drive creates a private tmux socket, HOME, `PI_CODING_AGENT_DIR`, temporary
directory, two disposable Git repositories, and a linked worktree under
`/tmp/pi-skill-toggle-state-*`. No shared developer Pi or tmux session is used.
It seeds global instructions and a global skill, root and tracked nested project
instructions, an ordinary project skill, and a source-authored manual-only skill.
These synthetic files are verification scaffolding, not project changes.

Each TUI process runs the following argv, recorded exactly in `launch.json`:

```text
node <checkout>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
  --no-extensions -e <checkout>/packages/pi-skill-toggle/index.ts
  --no-mcp --no-prompt-templates --no-themes --approve --offline
  --no-session --verbose --tui-mode regular
```

Pi permits explicit `-e` with `--no-extensions` (verified on 1.1.0). Skill and context discovery
remain enabled because they are the surface under test. The helper rejects
unexpected ancestor instruction files instead of silently loading them.
`--approve` trusts only the disposable fixture for this process; settings default
to never trusting other projects. No trust decision is saved.

Pi and tmux run with an allowlisted environment: scratch paths, PATH, TERM,
`SHELL=/bin/sh`, disabled Node compile caching, and offline/version-check/telemetry
controls. There are no inherited provider keys, real user settings, configured
packages, or MCP servers. Git ignores host/system configuration and hooks.
Ready means the live terminal lists this extension without an extension error,
then `/skill-toggle` opens a usable list. An unauthenticated `No models available`
warning is expected and does not prevent menu verification.

Launch, drive, and teardown are one command, with `finally` cleanup on failures.

## Doctor

```sh
.agents/skills/verify-pi-skill-toggle/scripts/verify.py doctor
```

This standalone doctor is **read-only**: check dependency executables, that the
installed Pi package and its CLI `--version` both match exactly the root
`package.json` devDependency pin (reported as `pinnedVersion`), the extension entry
point, and the installed TUI dependency; print JSON including `piCommand`. It creates no fixture,
starts no session, installs nothing, and never reads or updates user settings.
It uses `/var/empty` as HOME for the Pi `--version` check.

Each launched instance also gets a read-only doctor: capture its owned pane PID,
command and live/dead status, verify startup extension identity, and compare the
actual toggle-state bytes before and after. Inspect `verify*-doctor.json` and
`dependency-doctor.json` when anything looks wrong. Doctor failure means stop;
never compensate by driving a user's session.

## Drive

```sh
.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature menu
.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature changes
.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature scope
```

`all` executes these three journeys. Each invocation starts fresh. `scope` also
executes `changes` to create its preconditions through the menu, never by writing
policy directly. The helper sends only allowlisted slash commands and keyboard
input to an owned PTY: `/skill-toggle`, its invalid-argument case, `/reload`, and
`/quit`. Escape dismisses completion before submitting commands.

Enter opens one of the four categories. Search within it by fixture name or
repository-relative instruction path, not a fixed resource row number. Enter
toggles a filtered row; Space toggles an **unfiltered** selected row (the helper
finds its visible marker with arrow navigation). Space in a nonempty query is a
search character. Escape clears a query, backs out to Context, then closes.
Closing never undoes changes already saved. The driver routes resource searches
through their category and verifies the clear step independently of backing out.

The menu journey repeats at **120×45** and resized **60×28**. Plain captured cells
must show four named categories, a main-menu-only auto-save explanation,
Always on global instructions, On / Off / Manual only states, repository-relative
instruction paths and quoted source metadata on each resource row. Project
submenus show all worktrees once in the heading. Enabled global instructions
remain unchanged after Enter and Space. Search match, no matches, Escape clearing,
back/close and invalid arguments are checked without state writes. Exactly one
accurate hint appears: Enter open / Esc close at the root; Type to search /
Enter toggle / Esc back in a category; Enter toggle / Esc clear with a query.
Row assertions exclude Pi's startup resource listing.

The changes and scope journeys verify actual v7 state, reload and fresh-process
restart, linked-worktree changes propagating back to the main checkout, unrelated
repository isolation, and global choices applying across repositories. A reset
to the default must remove the repository choice, not leave a worktree override.

## Evidence

The helper prints `/tmp/pi-skill-toggle-evidence-<unique>/` **before** it drives.
This directory is outside scratch and remains after cleanup, even on failure.

- `launch.json`, `fixture.json`, `source.json`: exact launches/environment,
  disposable preconditions, and SHA-256 fingerprints of the helper/core source.
- `actions.json`: timestamped literal inputs, key events, resizes, and sessions.
- `*.txt`, `*.ansi.txt`: plain and styled **current-pane** captures, not stale
  scrollback. `verify*.terminal.log` additionally retains raw PTY output after
  startup. These are text/ANSI logs, not binary screenshots.
- `*.svg`: monochrome screen images rendered from those actual captured cells;
  portable evidence of layout, **not OS screenshots** or independent rendering.
- `*.state.json`: read-only snapshots of the actual state file while the menu is
  still open and after restart/reset. State is never seeded by the driver.
- `side-effects.json`, `storage-metadata.json`: unchanged instruction/skill
  hashes, empty/absent credentials, absent saved trust, and scratch file metadata.
- `result.json`, `failure.txt` if needed: feature-by-feature outcomes, unmet
  expectation, owned processes, and cleanup status.

Proof requires user action **and** resulting screen **and** file side effects.
A final screen alone, mocked component callback, or helper-written state does not
prove persistence. Require `status: passed`, successful cleanup booleans, and no
cleanup errors. Report every feature marked `not executed`; never infer it from
a convenient neighboring journey.

No model prompt, manual `/skill:name` invocation, provider request, or model tool
call occurs in `verify.py`. `--offline` suppresses automatic Pi network activity;
it is **not a firewall**. The command allowlist and absent credentials keep this
journey from asking a provider to do anything. `verify.py` therefore marks
`guard` **not executed** and points at `model.py`, which drives the
[guard](features/guard.md), [caching](features/cache.md), and
[subagent](features/subagent.md) journeys. This skill does not establish strict
context isolation or claim the best-effort shell guard blocks all reading forms.

## Model journeys

`scripts/model.py` drives the model-facing behaviour through the same pinned Pi
(it imports `pi_command` from `verify.py`) in RPC mode. An offline recorder
provider, `scripts/recorder-provider.ts`, stands in for the model: it registers
`recorder/codex-like` (mid-conversation system messages kept in place, like
Codex) and `recorder/collapse-like` (folded into the head, like `pi-claude-sdk`),
logs every request's full context and `sessionId` to `runs/<run>/requests.jsonl`,
and replies with canned text or scripted tool calls from prompt markers
(`READ-FILES: a|b`, `RUN-BASH: cmd`, `SPAWN-CHILD`). Pi executes those calls
through the real extension hooks.

```sh
M=.agents/skills/verify-pi-skill-toggle/scripts/model.py
E=$(mktemp -d /tmp/pi-skill-toggle-model-proof-XXXXXX)
export PI_SKILL_TOGGLE_CACHE_DEBUG=1   # optional: per-run cache-debug.jsonl
"$M" launch --evidence "$E"
"$M" doctor --evidence "$E"
"$M" drive --evidence "$E" --scenario all --model all
"$M" report --strict --evidence "$E"
"$M" compare --evidence "$E" --baseline <earlier report.json>   # optional
"$M" cleanup --evidence "$E"
```

Scenarios: `steady`, `toggle-mid`, `toggle-back`, `toggle-twice`,
`instruction-off` ([caching](features/cache.md)), `guard`
([guard](features/guard.md)), and `subagent` ([subagents](features/subagent.md)).
`launch` builds a scratch fixture under `/tmp/pi-skill-toggle-model-*` (six
global skills, two project skills, global and project `AGENTS.md`, a Git repo)
with `legacy-notes` disabled; evidence must be a fresh directory under `/tmp`.
Each run uses `--no-extensions` with explicit `-e` for the toggle and recorder,
`--approve --offline`, an allowlisted environment, and a scratch `HOME`. The
state file is reset before every run and rewritten atomically between prompts
per the scenario plan (`state-before-prompt-N.json`).

`report` writes `report.json` and `report.txt`: per request, rendered chars,
common prefix with the previous request, un-reused chars, reuse percent, system
patch and note counts, `skillsVisible`, and `toolOutcomes` for scripted calls.
`--strict` also fails any system patch after request 1. Exit 0 pass, 1 fail,
2 blocked; `report` exits nonzero if any check fails. `cleanup` removes only the
scratch directory; evidence stays (mode 0700). Run it after failures too.

Live mode (`--live claude-sdk --confirm-subscription-usage`) loads
`packages/pi-claude-sdk` instead of the recorder and spends the user's
subscription allowance: ask first, follow `verify-pi-claude-sdk`, run one short
caching scenario. Scripted scenarios (`guard`, `subagent`) never run live.

## Cleanup

The drive's `finally` records descendants of owned pane PIDs, stops only its
private tmux server, waits for those processes to exit, and escalates signals only
to those recorded PIDs if necessary. It never kills by process name or uses the
default tmux socket. After processes stop, it retries scratch removal. Disabling
Node compile caching avoids exit-time writes racing removal.

Require `serverStopped`, `ownedProcessesStopped`, and `scratchRemoved` all true,
and `cleanupErrors: []` in `result.json`. Cleanup failure exits nonzero. The
helper explicitly confirms `result.json` and `launch.json` still exist after
teardown. Keep the evidence directory; never include it in scratch removal.

If the harness is forcibly killed so `finally` cannot execute, inspect its
`launch.json`, verify ownership, then use **only its exact socket**:

```sh
tmux -S /private/tmp/pi-skill-toggle-state-<run>/tmux.sock list-panes -a -F '#{pane_pid} #{pane_current_command}'
tmux -S /private/tmp/pi-skill-toggle-state-<run>/tmux.sock kill-server
```

Wait for the recorded pane processes to exit before removing that exact scratch
path. Do not remove `/tmp/pi-skill-toggle-evidence-*`.

## Helpers

`./scripts/verify.py doctor` checks prerequisites without mutation.
`./scripts/verify.py drive --feature all` runs launch → instance doctor → all safe
mapped journeys → evidence → cleanup. The three feature-specific invocations
above allow focused reproduction. `./scripts/model.py` covers the model journeys
(see [Model journeys](#model-journeys)); a full verification runs both. Nonzero
exit means unmet expectations, not a reason to weaken the journey. No extra
Python package installation is needed.
