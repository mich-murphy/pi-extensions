# Reuse the prompt cache

A user's multi-turn Pi conversation through the provider reads the stable
prefix from Anthropic's prompt cache instead of paying for it again each turn,
and no hidden side request resends the transcript.

## Sub-features

- `steady-read-share`: session A turns 2-3 read >= 80% of prompt tokens from cache.
- `steady-suffix-write`: session A turns 2-3 write < 1500 cache tokens (suffix only).
- `no-side-requests`: every turn's `result.usage` prompt tokens equal the sum of
  `modelUsage` input + cache read + cache creation, with exactly one model key
  (catches the session-title request regression).
- `cross-session-preamble`: session B (new first message, same system prompt and
  tools) reads >= 70% on turn 1 (needs the preamble breakpoint).
- `fanout-read-share`: session C with 25 tool results per turn reads >= 60% on
  turn 3 (needs previous-tail/intermediate breakpoints within the 20-block lookback).
- `turns-completed`: every turn ends `done` with a usage event.

## How to get to it (user POV)

Any Pi conversation with a `claude-sdk/*` model. The probe drives the same
production path Pi uses: `normalizeContext` -> `buildAgentRequest` -> the real
runner with its default subscription environment and the real SDK `query`. No
proxy and no `ANTHROPIC_BASE_URL`; the query wrapper only observes `result`
messages and passes every message through unchanged.

## Driving it with verify.py

Preconditions: Launch/Doctor passed; subscription auth, positive allowance and
disabled extra usage (the same pre-check `live` uses runs first).

- **Run:** `"$H" cache --evidence "$E"`. It refreshes usage via RPC, copies the
  package to the owned gate snapshot, and runs
  `node_modules/.bin/jiti scripts/cache-probe.ts --package <snapshot>` (Sonnet,
  reasoning low; `--model` overrides when run by hand). About seven short turns.
- **Observe:** `cache-probe.stdout` is one JSON object: per-turn Pi usage
  (`input`, `output`, `cacheRead`, `cacheWrite`, optional `cacheWrite1h`), raw
  `result.usage`, `modelUsage` sums/keys, read shares, and every check with its
  value and threshold. `cache-probe.stderr` has a per-turn progress line.
- **Result:** probe exit 0 -> `passed`; 1 -> `failed`; 2 -> `blocked`
  (authentication/usage-limit). Recorded in `cache-results.json`.

A fresh random nonce starts the system prompt, so a run never reads a previous
run's cache; sessions in the same run share it, making cross-session reuse visible.

## Debugging a failed check

Re-run the probe by hand with `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1` (stderr) or
`PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE=<path>` (JSONL appended to a file) to see
breakpoints, TTL, prefix-change classification and likely miss cause per request.
Diagnostics never log prompt content.

## What it does NOT prove

- Cache behaviour for other models, images, compaction, mid-session system or
  tool changes, or TTL expiry; those belong to the synthetic simulator tests.
- Exact token counts: thresholds are shares, because server-side accounting and
  the CLI-injected environment message (~600 uncached tokens) vary.
- Diagnostics output itself, the TUI, or package installation.

## Gotchas

- Cache is account/org scoped and best effort; one failing run may be a server
  eviction. Re-run once fresh before concluding a regression, and report both.
- Allowance exhaustion mid-run is a blocker, never a pass.
- The probe sends real prompts; do not loop it.
