---
name: verify-pi-claude-sdk
description: Verify the pi-claude-sdk provider through real Pi CLI model listing, isolated RPC slash commands, and live subscription text/deferred-tool journeys. Use before merging provider or SDK changes; distinguishes passed evidence from rate-limit blockers.
---

# Verify Pi Claude SDK

Read [the feature map](features/README.md) first. **Do not merge the PR until
this skill's complete `all` run passes.** Partial, filtered, mocked, and blocked
runs do not satisfy the user's merge requirement. Never claim live success from
unit tests, metadata, an old attestation, or a command's acceptance response.

## Launch

Prerequisites: this checkout's existing `node_modules`, Node >=22, Python 3,
`pi` on PATH (proved with CLI 1.3.0), and `claude` on PATH. TypeScript loads via
Pi's extension loader; no build/install/package modification is needed. Stop and
report missing dependencies rather than silently installing or changing files.
Existing Claude subscription authentication is required for usage/live checks.
Do not log in, read credentials, copy auth files, or print the environment.

From the repository root, run:

```sh
H="$PWD/.agents/skills/verify-pi-claude-sdk/scripts/verify.py"
E="$(mktemp -d /tmp/pi-claude-sdk-proof-XXXXXX)"
"$H" launch --evidence "$E"
"$H" doctor --evidence "$E"
"$H" catalog --evidence "$E"
```

`launch` creates an empty isolated `PI_CODING_AGENT_DIR` and workspace, recording
ownership in `$E/state.json`. There is no persistent server: each drive starts
and closes its own Pi process. Ready means doctor AND catalog pass, not merely
that launch created directories. Always clean up even after a failed command.

The helper uses real `pi` with these documented options (absolute extension path
is resolved automatically):

```text
--no-session --no-extensions --extension <repo>/packages/pi-claude-sdk/index.ts
--no-skills --no-prompt-templates --no-themes --no-context-files
--no-mcp --no-approve --offline
```

Explicit extensions still load with `--no-extensions`. CLI working directory is
the owned scratch workspace, not this project. The helper sets `PI_OFFLINE=1`,
`PI_SKIP_VERSION_CHECK=1`, and `PI_TELEMETRY=0`, and passes only basic host
variables, not API keys/cloud routing. `HOME` stays unchanged so Claude Code can
use its existing subscription authentication without credential copying.
`--offline` suppresses Pi background network activity; it **does not** disable
SDK metadata/usage requests or model prompts.

## Doctor

```sh
"$H" doctor --evidence "$E"
```

This read-only inspection records Pi and Claude versions, checks installed SDK
metadata exists, checks scratch ownership and checkout identity. It does NOT
assert authentication or remaining allowance. Use `commands` for those observable
user-facing usage results. Missing authentication is a blocker: do not repair it
by logging in during verification. Repeat doctor whenever anything looks wrong.

## Drive

```sh
"$H" catalog --evidence "$E"
"$H" commands --evidence "$E"
"$H" metadata --evidence "$E"
"$H" usage-limit --evidence "$E"
"$H" live --evidence "$E" --approve-recovery-live
"$H" cache --evidence "$E"
"$H" recovery --evidence "$E" --approve-recovery-live
```

- `catalog`: actual `pi --list-models claude-sdk`; all five advertised IDs required.
- `commands`: actual Pi RPC client, `get_state`, `get_commands`, then prompts
  `/claude-sdk-status` and `/claude-sdk-usage`. Captures real `notify` UI messages.
  RPC has `ctx.hasUI=true`; print/JSON commands would silently skip these handlers.
  No fake registration, notification stubs, or internal status formatters.
- `metadata`: existing live test's **metadata-only** selector, real SDK
  `supportedModels()` with an idle input iterator. No model prompt. Requires one
  test passed; four skipped tests are explicitly NOT live verification.
- `live`: refreshes real usage immediately before any prompt and refuses to run
  while any reported allowance is exhausted. It requires paid extra usage
  disabled and positive reported allowances, drives Pi text and `read`
  journeys, then runs the existing **unfiltered** `npm run test:claude-sdk-upgrade`.
  The gate covers streaming text, deferred `contract_probe`, coding `read`, and
  every advertised model's actual resolution/limits. It must pass in full.
- `recovery`: reviewed, bounded actual SDK + Pi durable-loop acceptance. See
  [recovery](features/recovery.md). Requires explicit `--approve-recovery-live`
  after source review and refreshes allowance before prompting. A deterministic
  public-hook missing-arguments injection is labeled separately from the required
  OFFLINE synthetic Messages transport with the actual SDK/CLI parser; **both**
  must pass. Natural live malformed generation is not claimed. The separate
  `offline-recovery` action runs only that credential-free parser fixture. Forced
  output truncation was unsuitable and is not repeated. API/protocol errors fail.
  `live` includes this action after the baseline gate, so `all` cannot pass
  without it; `live`/`all`/`recovery` without approval block up front before any
  generation (including the later all/cache branch).
- `usage-limit`: credential-free **OFFLINE synthetic SDK-message fixture**, using
  the unchanged production extension/parser/runner/bridge and pinned Pi session
  event bus. Proves reset conversion, notice-before-failure, absent notices and
  observer isolation. See [usage-limit](features/usage-limit.md); not live quota
  or real SDK/CLI rate-limit-message generation proof. Required by `all`.
- `cache`: same allowance pre-check, then `scripts/cache-probe.ts` (via jiti)
  drives real multi-turn sessions through the production runner in the owned
  package snapshot and asserts cache read shares, suffix-only writes, no hidden
  side requests, cross-session preamble and fan-out reuse. See
  [cache](features/cache.md). When a check fails, re-run the probe with
  `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1` or
  `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE=<path>` to see breakpoints and miss causes.

For the actual merge proof, use a **fresh** evidence directory and run:

```sh
E="$(mktemp -d /tmp/pi-claude-sdk-proof-XXXXXX)"
"$H" launch --evidence "$E"
"$H" all --evidence "$E" --approve-recovery-live
RESULT=$?
"$H" cleanup --evidence "$E"
printf 'verification exit=%s; evidence=%s\n' "$RESULT" "$E"
```

Run without shell `set -e`, or use a cleanup trap so a nonzero result cannot skip
cleanup. Exit 0 means requested journeys passed; 2 means blocked; 1 means failed.
Only `all` exit 0 with **doctor, catalog, status, usage, metadata, usage-limit, live, recovery, cache all passed**
satisfies the merge gate. A single feature's exit 0 is only that feature's proof.
Unexpected API/schema/protocol errors remain failures, not automatic skips.

## Evidence

Proof lives outside the repository under `$E` with mode 0700. Commands, cwd,
stdout, stderr, exit codes, RPC sent actions and received state/notifications, and
per-action `*-results.json` survive cleanup. Evidence can include subscription
allowances and local paths: review before sharing; never publish auth data.
Only controlled prompts and an owned fixture are used. No credential reads,
logins, arbitrary model prompts, or raw SDK event capture are needed.

Recovery uses the pinned Pi SDK agent loop and owned on-disk sessions, not the
CLI RPC client, to observe the public SDK hook boundary without raw logging.
It does not attest the CLI approval UI.

User path proof requires both action and resulting state: catalog IDs; slash
command plus notification; text prompt plus exact response; model-issued `read`
plus successful execution event, final answer, and unchanged fixture SHA-256.
Tests alone are insufficient. The live gate provides complementary protocol and
all-model coverage, not a replacement for the CLI journeys.

The existing gate writes `sdk-release-contract.json` on complete success.
Therefore the helper copies this package and gate configuration to owned `/tmp`
state and symlinks the **existing** node_modules read-only by convention (no
install commands). The gate's attestation is copied to evidence, never back into
the checkout. This is not a mock: same source snapshot, SDK, CLI, subscription,
and gate command; only cwd/state/attestation destination differ. This verifies
explicit CLI extension loading, not package installation or a user's existing
TUI configuration. Do not claim the `/model` picker, keyboard UI, installation,
images, cancellation, or cache diagnostics output were covered by this seed map
(`cache` proves live cache reuse, not the diagnostics).

Before/after driving, compare `git status --short` against the starting state;
this checkout may already have unrelated changes. No runtime, tests, package
files, or tracked attestation may change during this skill. Metadata checks only
skip the model prompts at the production SDK boundary; no mocks are introduced.
Subscription prompts consume included allowance. Disabled extra usage and
subscription-only routing are required; a concurrent account user can still
exhaust allowance, in which case stop and report the blocker, never enable billing.

## Cleanup

```sh
"$H" cleanup --evidence "$E"
test -s "$E/catalog.stdout"
test -s "$E/cleanup.json"
```

Every subprocess is closed via stdin EOF and waited for; only the owned process
group is signalled on a deadline. Never kill by name. Cleanup removes only the
owned scratch directory (including copied gate and fixtures), not evidence or
host Claude/Pi state. Repeat after failures too. An interrupted helper may need
manual termination of its recorded, owned child PID/process group before cleanup;
never terminate a shared Pi or Claude process. Do not delete `$E` in cleanup.

## Helpers

Executable: `scripts/verify.py`. Invocation is shown above; run `"$H" --help` for
all actions. Read `features/*.md` for required outcomes and blockers. Keep the
feature map updated when model IDs or user entry points change. Preserve evidence
of a blocked run, then start a fresh full run after the rate limit resets.
