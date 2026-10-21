# Chat and use Pi tools

A user selects a Claude SDK model, gets a normal answer, and asks Pi to read a
file. Pi, not the SDK subprocess, executes the deferred tool and returns its
result to the conversation. The upgrade gate verifies all advertised selectors.

## Sub-features

- `metadata`: actual SDK supportedModels resolves selectors/effort without a prompt.
- `live-text`: real Pi print prompt returns the exact requested text.
- `live-read`: model requests Pi read, Pi executes it, final answer uses its result.
- `live-gate`: full upgrade gate verifies streaming text, deferred tool, coding
  read, Haiku 4.5 escaped bash arguments, every selector's model/context/output
  limits, and writes attestation. Each successful controlled runner probe must
  finish with SDK `num_turns == 1`; a same-model retry is not a clean pass.

## How to get to it (user POV)

Choose the provider with `--model claude-sdk/claude-5.1-fable`; use `--print` for
text and `--mode json --tools read` for observable tool execution. Maintainers
run `npm run test:claude-sdk-upgrade` when validating the SDK/provider release.

## Driving it with verify.py

Preconditions: Launch/Doctor/Catalog passed. Metadata needs existing installed
SDK; live generation also requires existing subscription auth, positive reported
allowances and disabled paid extra usage.

- **Metadata:** run `"$H" metadata --evidence "$E"`. Existing metadata-only test
  invokes the real SDK supportedModels API with idle input. Require one passed
  test. Preserve command/output/exit; four skipped tests are not live success.
- **Text:** run `"$H" live --evidence "$E" --approve-recovery-live`. It refreshes actual usage and either
  returns blocked (exit 2, with no prompt sent) or sends
  `Reply with exactly CLAUDE_SDK_TEXT_OK.` to actual Pi print mode.
  `live-text.stdout` must equal the marker; stderr and exit are retained.
- **Read:** same action seeds owned `probe.txt` with `CLAUDE_SDK_READ_OK`, allows
  only `read`, and asks Pi to read it and answer with its contents. JSON evidence
  must show successful `tool_execution_end` for `read` and a clean final assistant
  message with the exact marker, not printed tool markup. Fixture SHA-256 must
  remain unchanged (`live-read-side-effect.json`).
- **Gate:** same action runs unfiltered `npm run test:claude-sdk-upgrade` in the
  disposable package copy. Require all live contracts AND pin test pass; retain
  `upgrade-gate.*` and the newly written evidence `sdk-release-contract.json`.
  The original checkout attestation must remain untouched.
- **Full proof:** use a fresh `launch`, then `all`; require all feature results
  passed and exit 0, then cleanup. Anything less leaves PR merge blocked.

## Gotchas

- Controlled probes are not an autonomous-workflow cost guarantee. The original
  Haiku 4.5 `toggle-mid` journey reproduced internal error/denial recovery rounds
  even after this gate passed. See
  [the investigation](../../../../packages/pi-claude-sdk/docs/cache-roundtrip-investigation.md)
  before calling the provider production-ready.
- Exhausted allowance is a blocker, not a reason to mock generation, weaken
  assertions, retry until billed, or report live success.
- Gate runs in a copied package with shared installed dependencies; no install,
  tracked file mutation, login or credential copying is permitted.
- A successful JSON process exit is not proof of model success; inspect final
  stop reason and actual tool execution. The helper does both.
- Failed or filtered gates cannot attest. Do not hand-edit any attestation or
  copy the temporary one back during this verification-only task.
- Other account activity may exhaust allowance mid-run. Keep the failed output,
  report the rate limit precisely and rerun fresh after reset. Never silently
  treat unavailable usage, timeouts or missing tool execution as a pass.

## Option 2 validation-recovery acceptance

The new provider-owned error handoff requires the [recovery journey](recovery.md)
in addition to the baseline gate. `live` and therefore `all` now run it, requiring
explicit reviewed `--approve-recovery-live`. Offline hook simulations do not prove
the bundled CLI's malformed-JSON control flow; old `all` evidence is not acceptance.

Required controlled evidence:

1. A rejected gateway call (missing `arguments`) yields a durable assistant call
   to the reserved validation-error helper and a real Pi `isError` tool result.
   The invalid input executes nothing. The helper is absent from model tools.
2. A later, separate Pi turn issues the corrected real tool call, which executes
   exactly once through Pi's normal validation/approval hooks. Persist/reopen
   the Pi session to establish durability, not only transient UI events.
3. Exercise an actual SDK/CLI pre-hook malformed-JSON failure under the approved
   **offline synthetic Messages SSE fixture**, and establish that its
   public `PostToolBatch` callback occurs before a second model request. Record
   only reviewed fixed-enum/count summaries, not raw SDK inputs/error prose.
   This composes with live recovery; it does not claim natural live malformed generation.
4. The host `continue: false` stop produces clean `hook_stopped` with a non-length
   stop and the actual local batch marker. If the SDK
   reports `is_error: true`, missing result or bypasses the batch hook, report a
   blocker; never reinterpret arbitrary failures as a successful handoff.
5. Each Pi turn has exactly one distinct main-loop `message_start` in the safe
   `query.modelRequests` diagnostic, with per-model usage cross-checks. Preserve
   raw `numTurns` too: internal user/tool-result messages can increment it even
   without a second model request. Do not weaken the current `numTurns == 1`
   controlled baseline gate without explicit evidence and reviewer approval.

A deterministic first-query public-hook fault injection can prove the missing-
arguments journey, but must be labeled fault-injected. It cannot stand in for
actual pre-hook malformed JSON. Parent's forced-truncation probe reached a separate
output-retry pipeline, not PostToolBatch; do not repeat ceiling variants as the
malformed-JSON strategy. The approved alternative is the separately isolated real
SDK/CLI parser fixture, clearly labeled offline synthetic transport. A blocked or
unobserved malformed path is **unverified**, not a passing Option 2 acceptance.
