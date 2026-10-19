# Chat and use Pi tools

A user selects a Claude SDK model, gets a normal answer, and asks Pi to read a
file. Pi, not the SDK subprocess, executes the deferred tool and returns its
result to the conversation. The upgrade gate verifies all advertised selectors.

## Sub-features

- `metadata`: actual SDK supportedModels resolves selectors/effort without a prompt.
- `live-text`: real Pi print prompt returns the exact requested text.
- `live-read`: model requests Pi read, Pi executes it, final answer uses its result.
- `live-gate`: full existing upgrade gate verifies streaming text, deferred tool,
  coding read, every selector's model/context/output limits, and writes attestation.

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
- **Text:** run `"$H" live --evidence "$E"`. It refreshes actual usage and either
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
