# Recover invalid tool input in Pi

Option 2 requires Pi, not the SDK's internal model loop, to persist a rejected
assistant call and failed tool result, then make a separate model request for
correction. Acceptance is compositional: real subscription missing-arguments
recovery plus an **OFFLINE synthetic transport with the real SDK/CLI parser**.
Natural live malformed generation is explicitly not claimed.

## Review and drive

Read `scripts/recovery-probe.ts` and `scripts/parser-transport.ts` before authorizing
model prompts. The parent/user owns that authorization. From a fresh launch:

```sh
"$H" recovery --evidence "$E" --approve-recovery-live
```

`live` runs both subfeatures after its baseline upgrade gate; full
`all --approve-recovery-live` therefore also requires them. Missing approval for
all/live/recovery blocks up front before any subprocess, including later cache
prompts. The live recovery invocation refreshes actual usage through the existing
RPC slash command and requires positive allowance and extra usage disabled.
Standalone cache keeps its prior explicit-action allowance gate.

For a filtered live first journey or just the credential-free offline fixture:

```sh
"$H" recovery --evidence "$E" --approve-recovery-live --recovery-case missing-arguments
"$H" offline-recovery --evidence "$E"
```

A filtered recovery subfeature can pass, but aggregate recovery reports blocked;
it is not the full merge gate. Offline-recovery alone makes no subscription call
and needs no usage lookup. No installs, auth reads, logins or auth changes.

## Live public-hook fault injection

Haiku 4.5, reasoning disabled, at most three Pi queries, a 180-second deadline and
a pure `contract_probe` tool. No shell/file/model tools are exposed. Only the first
public `PreToolUse` gateway input is replaced with a missing-arguments object;
this is labeled **fault-injected**, not natural malformed-JSON evidence. The real
SDK still handles deferral and produces its own terminal result. Later SDK
messages and inputs pass unchanged; Pi executes only the corrected pure tool.

## Offline real-parser boundary

The helper launches a separate process with an EMPTY owned HOME, isolated Pi state,
only allowlisted basic host variables, a fixed dummy API key and nonessential
traffic/telemetry disabled. No real credential variables or HOME reach it.
Production `subscriptionEnvironment` is unchanged: only this test adapter overrides
runner `sdkEnvironment` with the loopback base and dummy key.

The HTTP fixture binds only `127.0.0.1` on a random port, accepts exactly three
Messages requests with the dummy key and no Authorization header, discards bounded
request bodies without logging/decoding them, and emits synthetic Messages SSE:

1. A complete `tool_use` response with syntactically INVALID `input_json_delta`,
   **not** a max_tokens stop or a truncated transport stream. The actual installed
   SDK/bundled CLI must generate its parse failure, skip `PreToolUse`, deliver the
   error batch to the production hook and honor `continue:false`.
2. A valid corrected gateway call, deferred by the real CLI's PreToolUse path.
3. A fixed final text marker after Pi's pure corrected executor runs exactly once.

No fake SDK messages, hook events or SDK/client event mutation are involved. The
synthetic model transport is explicit and never a fallback for real work. Exact
request counts, no unexpected routes/auth, a case deadline and owned-process
cleanup bound the fixture. Output budgets remain a normal 2048 throughout; no
forced truncation. A prior parent-authorized 64-token truncation experiment hit a
separate SDK output-retry pipeline (four starts, zero tool hooks, max_output_tokens
error despite maxTurns2). Do not repeat ceiling variants as malformed-JSON proof.

## Required observations

- Production snapshot bridge/runner, real pinned Pi `runAgentLoop`, normal tool
  validation and reserved-name guard. Available failure usage remains truthful.
- Invalid executor count zero. Corrected pure executor exactly one, fixed argument,
  only after disk persistence/reopen establishes Pi's reserved error result.
- `SessionManager` disk write/reopen **before query 2** establishes a durable
  reserved assistant call plus `isError` result. Final reopen also contains the
  successful corrected tool result, followed by the clean `RECOVERY_OK` answer.
- Exactly one main-loop message_start per Pi query, with raw SDK numTurns retained
  (2 may accompany just one start), one usage model, and main-loop prompt totals
  equal query-pipeline prompt totals. Hidden second starts fail; counts aren't dropped.
- Offline query 1 specifically: zero pre-hooks, one batch, one uncaptured entry,
  one actual CLI error tool result classified as JSON parsing; exactly one invalid
  fixture response and three requests overall, no unexpected requests.
- A controlled batch stop requires the local marker plus clean `hook_stopped` and
  non-length stop. Arbitrary completed/unknown/length/context outcomes cannot
  authorize real calls; `is_error` still wins. Observed SDK shape is tool_use,
  numTurns2, one model request. A future different shape needs reviewer evidence.

## Evidence and limits

`recovery-missing-arguments.stdout` and `recovery-offline-parser.stdout` are safe
JSON only: fixed labels, hook/request counts, terminal enums/booleans, token totals
and production allowlisted query diagnostics. No IDs, arguments, prompts, raw
SDK errors/events, request bodies or credentials are printed. The JSON parsing
classifier inspects text in memory for offline evidence only; production control
never uses prose.

Evidence stays outside the repository, mode 0700. Controlled Pi session files
necessarily contain the controlled transcript, but exist only in owned scratch;
cleanup removes them and retains safe summaries. Keep failed proof too.

This proves the real CLI parser/hook/stop boundary under synthetic transport and a
separate live subscription Pi correction. It does **not** claim natural Anthropic
malformed generation, arbitrary malformed JSON, interactive approval UI,
installation, images, compaction or cancellation. Only fresh full all exit0 on
the final snapshot satisfies the provider merge gate.
