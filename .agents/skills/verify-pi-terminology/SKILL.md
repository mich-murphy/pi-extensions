---
name: verify-pi-terminology
description: Verify pi-terminology /terminology and /terminology-* commands and the experimental preview through an isolated real tmux TUI of the checkout's pinned Pi, with fake auth, zero provider/fetch calls, and hard-fail evidence checks. Use after changing commands, UI, or preview policy.
---

# Verify pi-terminology

Read [the feature map](features/README.md) first.

## Run

From any cwd (the wrapper resolves the checkout from its own location):

```sh
.agents/skills/verify-pi-terminology/scripts/verify.py doctor
.agents/skills/verify-pi-terminology/scripts/verify.py drive --feature all
.agents/skills/verify-pi-terminology/scripts/verify.py drive --feature commands
.agents/skills/verify-pi-terminology/scripts/verify.py drive --feature preview [--synthetic-ui-fixture]
```

Requires Python 3, Node, tmux, and installed dependencies (pinned Pi 1.3.0 from
`node_modules`; a global `pi` is never run). `doctor` checks the pin, tools,
that both scripts compile, and that they invoke the canonical command family.
The live SDK registry must contain all eight `/terminology*` commands and no
legacy `/term`, `/terms`, `/term-*` or `/terms-*` aliases.

The wrapper launches only `packages/pi-terminology/scripts/verify-tui.py` and
`verify-preview-tui.py`, which use a scratch HOME, `PI_CODING_AGENT_DIR`, and
private tmux socket under `/tmp`, with no real keys and no network.

## What the wrapper asserts (fails hard otherwise)

- Child exit 0, `result.json` result is exactly `passed`, no `failure.txt`,
  `scratchRemoved` true. Exit 2 / `waiting-for-parent-artifact` / a missing file
  is a FAILURE, never inferred as a pass.
- The public SDK command registry contains exactly the eight canonical commands.
  Completion capture for `/terminology-` also shows the renamed commands;
  every recorded command matches the terminology allowlist; 60x28 was exercised;
  metadata has viewports and warnings.
- Preview: `native` explicitly false; artifact source matches mode and exists;
  realProviderRequests, fetchCalls, slashClassifierCalls all 0; exactly 2 allowed
  intercepted fake classify calls and 3 synthetic inputs; confirm/cancel, finite
  allowance 2->1->0, exhaustion, off/restart, mutation fail-closed, and no
  primary-context change are in the passed list with captures present.

Default preview uses the actual bundled artifact. `--synthetic-ui-fixture` is a
scratch-only fake and is never native or paid evidence. Neither verifies native inference.

The command-only journey also installs a throwing fetch/model-registry guard;
its counters must show no classifier calls, model inputs or network calls.
Both journeys use only their owned tmux server and remove the disposable profile.

Evidence directories (`/tmp/pi-terminology-evidence-*`, `/tmp/pi-preview-evidence-*`)
are printed and retained. Do not run `drive` until runtime rebinding is confirmed.
On failure inspect `failure.txt` and the pane captures.
