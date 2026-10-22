---
name: verify-pi-web-tools
description: Verify pi-web-tools native login/logout, registration, model catalog, reload, and invalid configuration in an isolated real terminal UI of the checkout's pinned Pi devDependency without real credentials or provider calls.
---

# Verify pi-web-tools

Read [the feature map](features/README.md) first. This skill verifies baseline
behavior and [native authentication](features/native-auth.md) with synthetic
credentials only. Require successful evidence before reporting acceptance.

## Launch

From the checkout root, with dependencies already installed (`npm install` is
the documented development setup), run:

```sh
.agents/skills/verify-pi-web-tools/scripts/verify.py startup
```

Requires Python 3, Node, tmux, and the checkout's installed dependencies. Pi is
**the checkout's pinned Pi devDependency**: the helper reads the expected
version of `@earendil-works/pi-coding-agent` from the root `package.json`,
requires `node_modules/@earendil-works/pi-coding-agent/package.json` to match it,
runs that package's `bin.pi` entry with `node`, and imports the SDK from the
package's own entry. A Renovate bump therefore needs no script edit. A global
`pi` on PATH is noted in the doctor output but never run. The executable
resolves the checkout from its own location, so it also works from another cwd.
It creates a private tmux socket, scratch HOME, `PI_CODING_AGENT_DIR`, temporary
directory, and empty cwd under `/tmp`. Concurrent runs do not share state.

The exact Pi argv is saved in `launch.json`. It uses `env -i` with only scratch
paths, PATH, TERM, offline/version-check/telemetry controls, and:

```text
node <checkout>/node_modules/@earendil-works/pi-coding-agent/<bin.pi>
  --no-extensions -e <checkout>/packages/pi-web-tools/index.ts
  --no-mcp --no-skills --no-prompt-templates --no-context-files --no-themes
  --no-approve --offline --no-session --verbose --tui-mode regular
```

Pi explicitly permits `-e` with `--no-extensions`; the latter disables
discovered, configured, and built-in extensions. Empty scratch settings declare
no packages and disable cache warming. No real user settings, credentials,
context, global MCP, skills, or prompts are loaded. Ready means the real
terminal header lists only the explicitly loaded package and exposes the editor,
not merely that a process exists.

## Doctor

The helper checks the version against the pinned devDependency, startup
extension identity/errors, and the owned tmux pane. `doctor.txt` (also printed)
records the version, the exact Pi command, the SDK entry, and any global `pi`
that was noted but not run. A read-only public SDK second view loads the **same sole
extension** with discovery disabled, enumerates all operation models and tool
descriptions, and records zero skills/prompts/context in `catalog-doctor.json`.
It never calls `prompt()`, reads real provider secrets, or executes a tool. This
supplements, not replaces, interactive evidence.

If a check fails, inspect the printed evidence directory. Do not drive a
developer's existing Pi/tmux session to compensate.

## Drive

The helper types real `/model`, Escape, `/reload`, and `/quit` through the owned
terminal PTY, recording actions and current-pane screens (not stale scrollback).
It dismisses command completion before submission and rejects extension errors
or authentication-registration failure notifications at startup and reload. It proves tool registration through
public SDK introspection, not an internal setter. Run the mapped negative
configuration journey with:

```sh
.agents/skills/verify-pi-web-tools/scripts/verify.py invalid-config
```

This adds only `PI_WEB_TOOLS_PROVIDERS=verification-unknown-provider` to the
clean environment and requires a visible configuration notification and
unavailable tool descriptions. It does not issue a provider call.

## Evidence

Every run prints `/tmp/pi-web-tools-evidence-<unique>/`. Artifacts include
`launch.json`, `actions.json`, `startup.txt`, `model-picker.txt`, `reload.txt`,
`doctor.txt`, `catalog-doctor.json`, sanitized auth presence, and `result.json`.
Negative runs also capture `invalid-config.txt`. Text captures include action
results, not only a final blank editor.

Proof requires actual user actions, visible results, registration/catalog state,
and cleanup status. Empty `/model` alone does not prove no dummy models:
unauthenticated models are hidden there, hence the all-operation catalog doctor.
Native runs additionally save and remove synthetic credentials through real
`/login` and `/logout`, test Escape cancellation and two reloads, and require
environment fallback to remain configured after logout. Run:

```sh
.agents/skills/verify-pi-web-tools/scripts/verify.py native-auth
```

[Subagent child](features/subagent-child.md) runs are SDK-only: no terminal
is launched. They replay parent providers onto pi-subagents-style child
sessions and also run a pinned pre-fix copy that must collide. Run:

```sh
.agents/skills/verify-pi-web-tools/scripts/verify.py subagent-child
```

They retain `subagent-child-*.json`, the probe, and `subagent-child-summary.json`.

`storage-metadata.json` records isolated file paths, sizes, and permission bits;
auth summaries retain only type and synthetic-value equality.
No live calls, paid calls, browser login, or tool executions occur. `--offline`
suppresses automatic Pi network activity; it is **not** a firewall and would not
prevent an explicitly requested web tool/provider call. Never send ordinary
prompts in this harness.

Baseline evidence cannot establish search routing, credential precedence,
command-key handling, redaction, or request-time changes. Those need
deterministic transport tests separately from these native interactive journeys.

## Cleanup

`finally` snapshots the owned pane PID and descendants, stops only the dedicated
tmux server at its unique socket, waits for those processes to exit (escalating
signals only to those PIDs if needed), and retries scratch removal. Pi explicitly
enables Node compile caching, so the clean environment also sets
`NODE_DISABLE_COMPILE_CACHE=1` to avoid exit-time cache writes racing cleanup. It does not kill by process name or
touch the default tmux server. `result.json` records `serverStopped`, `ownedProcessesStopped`,
`scratchRemoved`, and `cleanupErrors`; require all booleans true and no errors.
Cleanup failures write a failed result and exit nonzero. Evidence is outside scratch and survives
cleanup. Retain evidence, never real home auth. A killed harness cannot execute
`finally`; use the socket named in its launch scratch path to stop only that
server before removing that scratch directory.

## Helpers

`./scripts/verify.py startup` runs launch → doctor → model/reload → evidence →
cleanup. `./scripts/verify.py invalid-config` runs the negative configuration
variant. `./scripts/verify.py native-auth` runs the synthetic native auth lifecycle.
`./scripts/verify.py subagent-child` runs the replayed child-session journey
and its pre-fix negative.
All modes exit nonzero on unmet assertions, print the retained evidence
location, and leave failure evidence intact. Resolve these paths relative to
this skill directory when not at the repo root.
