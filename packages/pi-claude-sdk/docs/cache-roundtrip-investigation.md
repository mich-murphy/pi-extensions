# Cache and internal-round-trip investigation

## Scope

This follows the historical investigation session and its
2026-10-21 handover. The merged skill-toggle change is not the SDK defect:
its preserved diagnostics show unchanged system/tool fingerprints and an
appended transcript across the toggle.

The historical session contains private local skill information. It remains
local evidence, not a fixture to commit or publish. No credentials were read,
copied, changed, or used outside the official SDK subscription path.

## Result

- Reproduced amplification is caused by rejected gateway inputs followed by
  SDK-internal recovery: malformed JSON before the hook, and missing
  `arguments` objects denied by the hook. Cache-prefix loss was not observed.
- Cache thresholds, retry bounds, fallback handling, error precedence, usage
  splits and diagnostics have been hardened with regression coverage.
- Option 2's durable Pi handoff passed final compositional acceptance: live
  subscription missing-arguments fault injection and an offline real SDK/CLI
  malformed-JSON parser journey. Fresh complete verification passed on the final
  functional snapshot. This validates the targeted correction, not natural live
  malformed generation or blanket production readiness.

## Option 2 implementation and final acceptance

The bridge now moves validation recovery into Pi's durable outer loop:

1. `PreToolUse` defers both valid and invalid calls, never returning a retrying
   deny for invalid input. Invalid calls target a reserved Pi-owned error tool
   with a fixed reason enum, not coerced arguments to a real tool.
2. The official pinned `PostToolBatch` hook receives structured tool calls after
   all tools resolve and before the next model request. It captures pre-hook
   validation failures and returns `continue: false`. It does not inspect SDK
   error prose, `tool_response` content or undocumented marker names.
3. Only an actual clean terminal result (`tool_deferred`, or `hook_stopped`
   after our own batch stop, with a non-length stop) releases captured calls.
   Uncaptured batch entries are always nonexecuting rejections, even when
   structurally valid; only actual PreToolUse-deferred calls can execute.
   Empty stopped batches fail closed. Captured siblings keep arrival order;
   uncaptured entries append in batch order. Real failures, EOF without result, cancellation
   and fallback-handler execution still discard the entire failed query.
4. Pi's reserved helper and unconditional name guard create a native failed
   tool result; normal Pi continuation asks for the correction in a new query.
   The helper is hidden from model declarations and filtered from SDK tools.
   The guard also blocks a later same-name executor; native schema validation
   occurs before this guard and itself prevents execution on bad arguments.
   An inactive helper remains safe through Pi's unknown-tool error path, but
   yields generic rather than targeted correction text.
5. Raw runner callers must explicitly opt into `validationRecovery:
   "pi-tool-loop"` after installing equivalent helper/guard/history semantics.
   Otherwise invalid input fails closed rather than emitting a possibly
   executable synthetic call.

Offline regressions use the exact public hook types and pinned Pi `runAgentLoop`
with `SessionManager` disk persistence/reopen. They establish durable rejected
assistant calls/error results, a later corrected real tool, no invalid or
colliding executor invocation, inactive-helper safety, failure precedence and
preserved authoritative usage. Those regression SDK event sequences are
simulations; the separate final offline parser journey below exercises the real
CLI malformed-JSON path.

Diagnostics now distinguish raw SDK `numTurns` from `modelRequests`, which counts
unique main-loop streaming `message_start` IDs in query-local memory. IDs never
enter diagnostics. Internal user/tool-result messages can increment `numTurns`
without a second model request. A successful query with multiple observed model
starts becomes a protocol failure and releases no calls, while retaining terminal
cumulative spend. This is a detection/fail-closed backstop, not prevention of
already-started requests; the batch hook is the intended prevention boundary.

A reviewer-authorized real pinned-SDK pure-tool boundary probe established
`PreToolUse` deny -> `PostToolBatch` `continue:false` -> clean `hook_stopped`,
`stop_reason: tool_use`, `numTurns: 2`, **one** model request, no fallback.
This supports the strict terminal whitelist, not malformed-JSON acceptance.
The local host marker plus this terminal reason is required; arbitrary completed,
unknown, length or context outcomes cannot release calls. `is_error` still wins.

**Acceptance is compositional, not natural-live malformed generation.** The
parent approved a separate, credential-free synthetic Messages SSE fixture using
the actual installed SDK and bundled CLI. A complete tool-use response supplies
syntactically invalid JSON (not max_tokens), so the CLI itself creates the parse
failure, skips PreToolUse and reaches the production PostToolBatch hook. It stops
cleanly with `isError: false`, `hook_stopped`/`tool_use`, raw `numTurns: 2`
and `modelRequests: 1`. Its first query records zero PreToolUse hooks, one batch,
one uncaptured entry and one SDK JSON-parse error. The actual Pi
loop writes/reopens the reserved assistant call/error result before query2,
executes the corrected pure tool exactly once and finishes on query3. All three
queries have one model start and matching main-loop/query-pipeline prompt totals;
the local fixture receives exactly three requests and no unexpected route/auth.
This offline real-parser proof passed; it is not a mock hook sequence, but the
model transport is synthetic and explicitly labeled. It never receives real
auth: separate empty HOME, dummy key, loopback only, no external fallback.

The final real-subscription missing-arguments journey also passed: public
PreToolUse fault injection produced a saved Pi rejection before query 2, the
corrected pure executor ran exactly once, and query 3 returned final text. All
three SDK queries observed `modelRequests: 1` and raw `numTurns: 1`. This is
fault-injected live acceptance, not naturally generated malformed input.

Fresh verification-skill `all` passed on the final functional snapshot (evidence
and repository checks below). Parent approval is scoped to targeted Option 2
validation/correction; experimental status and other SDK retry limitations
remain. No arbitrary SDK `is_error` result is converted into success, and the
eight-turn cap is not proof of prevention.

A reviewer-authorized output-ceiling experiment did not reach JSON parsing or
`PostToolBatch`: it produced four model starts, zero tool hooks/results, and typed
`max_output_tokens` failure (256 output tokens total) despite `maxTurns: 2`.
This is a distinct SDK output-retry pipeline, not validation-batch proof. Forced
truncation is removed from the recovery harness; do not repeat ceiling variants.
Both final recovery journeys passed through the verification skill: the live
public-hook missing-arguments fault injection and the separately isolated offline
synthetic Messages transport exercising the real SDK/CLI parser. The truncation
experiment did **not** pass malformed-input proof. Natural live malformed
generation is not claimed. `live`/`all` include the recovery gate so old valid-only
passes cannot imply Option 2 acceptance.

## Established findings

### Cumulative usage explains the apparent cache drops

The SDK's terminal `result.usage` reports the main agent loop's usage for the
whole SDK turn. Streamed usage initially describes the current model call.
The adapter correctly replaces streamed counts with terminal totals rather
than adding those reports together. A query with internal continuations can
therefore report substantially more tokens than the visible Pi transcript.

The earlier handover's requests 4, 5 and 8 are consistent with such internal
continuations. They do not demonstrate that the next query lost its cache.
However, the preserved evidence lacks SDK `num_turns`, internal tool results,
and hook-denial records. **The exact historical trigger cannot be recovered
conclusively from that evidence.** Do not call it a proved schema, toggle,
parallel-tool, or upstream cache bug.

The SDK's `modelUsage` includes query-pipeline auxiliary calls as well as the
main loop. Comparing its totals with `result.usage` helps detect side requests.
Neither this comparison nor `num_turns` proves the absence of every HTTP call:
some SDK helper requests are outside that accounting, and the bundled engine's
turn indicator is affected by internal user/tool-result messages.

### Escaped bash strings are accepted

An offline test connects the real installed SDK MCP server to an MCP client
through an in-memory transport. It lists the actual gateway schema and calls
it with escaped shell strings and nested JSON. Valid input reaches the
fail-closed handler unchanged; array arguments are rejected.

The listed schema uses recursive JSON references, but this alone is not a
failure. There is no evidence supporting schema loosening as the historical
fix. The live gate additionally requests an escaped `find` command through
Haiku 4.5 and requires a clean first-round defer without executing the command.

### Deferral needs defense in depth

The installed CLI contains a path that ignores a hook's `defer` decision when
one SDK assistant message contains sibling `tool_use` blocks. Its fallback
handler previously returned an error, allowing a hidden model continuation.

This is not equivalent to saying every parallel Pi call fails. A controlled
live Haiku 4.5 probe successfully returned two calls with `num_turns == 1`:
the SDK delivered separate assistant messages, each containing one tool use.
Thus two visible Pi calls do not establish that the rejection branch ran.

Hardening:

- Bridge instructions request one gateway invocation per assistant response.
- If the SDK invokes the gateway handler despite deferral, the runner aborts
  immediately with a typed tool-contract failure. Captured calls are not
  released, even if the SDK later yields a clean result or normal EOF.
- **Historical hardening, superseded by Option 2:** invalid gateway requests
  and unexpected top-level tool requests shared a three-denial retry budget. Previously unexpected top-level tools
  could be denied indefinitely without reaching that budget.
- Under Option 2 no hook denial budget remains: invalid calls defer to Pi.
  Fallback failures still outrank SDK cancellation caused by our own abort.
- SDK `maxTurns` is capped at eight as a last-resort bound for recovery errors
  that happen before the permission hook. The three-denial hook budget alone
  cannot bound those paths. This is not a one-turn cap, which can reject a clean
  deferral; ordinary controlled probes still require `num_turns == 1`.

These close concrete continuation paths; they do not prove which path caused
the old session's extra usage.

### Historical pre-Option 2 replay still amplified usage

A single replay of the original `toggle-mid` journey on Haiku 4.5, reasoning
medium, reproduced the issue on the historical hardened runtime before Option 2. Its five prompts produced
11 SDK queries and 16 SDK turn indicators, with 95,105 aggregate prompt tokens.
Private evidence: `/tmp/pi-handover-toggle-mid-proof-nosntyzw/` (mode 0700).

| Query | SDK turns | Internal tool errors | Invalid gateway denials | Fallback calls |
| --- | ---: | ---: | ---: | ---: |
| 5 | 2 | 1 | 0 | 0 |
| 6 | 2 | 1 | 0 | 0 |
| 7 | 3 | 2 | 2 | 0 |
| 8 | 2 | 1 | 1 | 0 |

Every other query reported one SDK turn. All request prefix classifications were
`first`/`appended`, and system/tool fingerprints were constant. The two pre-hook
error/recovery queries cannot be attributed to a hook denial. The later queries
confirm that invalid gateway denials are one real amplification mechanism. No
unexpected-top-level-tool hook calls or fallback-handler executions occurred.

The initial Haiku request had 3,951 prompt tokens, no cache writes and the now
correct 4,096 minimum. The replay therefore independently confirms the threshold
fix, but **does not pass a no-amplification release criterion**. A successful Pi
journey and a passing controlled `all` gate do not establish cost stability for
autonomous multi-step work. The exact rejected shapes required the further private snapshot investigation
below; do not interpret this successful drive as a no-amplification pass.

### Historical instrumented replay establishes the rejected shapes

One further pre-Option 2 replay used an owned, private source snapshot with a bounded
fixed-enum observer; the main checkout was not patched with raw event logging.
Its reviewed logger passed a sentinel test before live use. Evidence:
`/tmp/pi-owned-toggle-shapes-9qqpu441/`, including `safe-event-order.json` and
`safe-rejected-shapes.json`.

Five prompts produced 12 SDK queries and 19 SDK turn indicators. Event order
established two distinct mechanisms:

1. Queries 5 and 9 emitted a gateway call carrying the SDK's unparsed-input
   marker. A matching JSON-parse error tool result followed **without a capture
   hook invocation**, then another model round produced a valid deferred call.
   The classifier reported other JSON syntax, not an escape-specific error.
2. Queries 6, 7 and 8 emitted gateway calls targeting valid `read`/`bash` names
   but **missing the required `arguments` object**. Each reached the hook,
   received a denial and matching validation error, then retried internally.
   There were five such denials across these queries before valid calls deferred.

Rejected native/unknown top-level names, self-referential `pi_call` names,
stringified arguments and array arguments were not observed. Valid escaped bash
strings remain accepted; bash escaping is not established as the JSON syntax
failure's cause. These are observations of the reproduced failure class, not a
claim to have recovered the unrecorded inputs of the historical session.

The observed root is therefore **invalid gateway input at the SDK boundary
plus the SDK's inner error-recovery loop**, not a rewritten Pi cache prefix.
The observer does not capture raw HTTP/tool-input bytes and cannot independently
rule out a lower-level SDK parsing defect. The hook budget
cannot stop failures that precede it. Gateway instructions now explicitly require
an `arguments` object, require target parameters inside it, and specify `{}` for
a parameterless tool. The SDK safety cap bounds pre-hook recovery too. These are
mitigations, not proof that the model can never emit malformed JSON or omit a
required field. No schema loosening or invented accounting correction was used.

### Cache minima differ by model

[Anthropic's cache limitations](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-limitations)
list a 512-token minimum for the registered current 5.x models and 4,096 for
Haiku 4.5. The previous universal 1,024-token diagnostic threshold incorrectly
classified the historical 3,961-token Haiku request as an ordinary first miss.

Minima now live beside model limits. Lookups support advertised IDs, selectors,
concrete IDs and dated snapshots. An observed concrete model takes precedence
over an alias; unknown models do not receive a guessed minimum. Existing cache
read/write activity also overrides a speculative `below-minimum` diagnosis.

Breakpoint placement is unchanged. Aggregate usage and character counts cannot
establish how many tokens precede an individual breakpoint, especially with
SDK-added content and images. Pruning from those estimates could remove a
valid cross-session prefix.

### Cache-write splits must match the accounting scope

Final review also reproduced a mixed-scope accounting defect: cumulative terminal
cache-write totals could inherit the last internal call's 1-hour/5-minute split
when the terminal report omitted that split. Pi could retain the stale 1-hour
field even after an updated usage event omitted it.

Terminal totals now retain only explicitly reported terminal splits, and the
Pi bridge clears an obsolete split. Streamed per-call reports still preserve
omitted fields within their existing incremental-report semantics. A two-call
regression covers the parser/runner, diagnostic record and final Pi message;
explicitly supplied cumulative splits remain authoritative.

### Cancellation and error precedence

Offline regressions also established and fixed two runner defects:

- Cancellation followed by normal EOF without a result was reported as a
  missing-result/protocol error instead of cancellation.
- An earlier rate-limit API error could mask a later typed authentication
  failure. Authentication now retains its documented precedence.

## New production evidence

Opt-in cache diagnostics include a bounded `query` summary:

- terminal outcome and SDK `numTurns` when present;
- sanitized per-model prompt counts, separate from main-loop usage;
- assistant tool-use totals and maximum per assistant message;
- internal error-tool-result count;
- invalid-gateway and unexpected-tool denial counts;
- fallback-handler calls and allowlisted typed API error.

Unknown model names become query-local `unknown-N` labels. At most eight model
entries are included, with an omitted-entry count. Arguments, tool names/IDs,
model prose, hook-denial prose, raw SDK messages and credentials are excluded.
Optional malformed diagnostic fields do not fail otherwise valid turns.
Failed queries retain available usage; a query with no usage gets a separate
`query` record, not invented zero tokens.

The cache probe now requires `num_turns == 1` in addition to its existing
single-model and usage-equality checks. Ordinary successful controlled runner
probes in the live release gate also require one SDK turn. Option 2's offline
parser recovery intentionally observes raw `numTurns: 2` but only one model
request in its first query. Same-model retries cannot pass merely because token
sums agree.

## Verification

### Historical investigation and hardened-runtime verification (before Option 2)

Local investigation evidence:
`/private/tmp/pi-claude-sdk-investigation-EfQpi3/`.

- Real CLI doctor, catalog, status and usage commands passed.
- Correctly isolated Haiku 5.5 solo and Haiku 4.5 solo/parallel probes completed
  with clean deferral and no internal tool errors.
- Early ad-hoc probes omitted basic host identity variables and failed
  authentication. Matching the verification helper's host-variable allowlist
  resolved that experimental setup error without credential access or login.
  Their process exit zero was not treated as model success.

Historical final validation on the pre-Option 2 hardened runtime:

- Fresh verification-skill `all`: **exit 0**, evidence at
  `/private/tmp/pi-claude-sdk-proof-77oBNZ/`. Doctor, catalog, status, usage,
  metadata, live and cache all passed; owned scratch cleanup succeeded.
- The live gate covered every advertised model and the escaped-bash regression.
  All seven cache-probe turns reported `numTurns: 1`. Steady-turn cache read
  shares were 96.7%, cross-session reuse 96.9%, and final fan-out reuse 78.5%.
- Package suite: **458 tests passed**. Repository suite: **1,797 passed,
  2 skipped**, with formatting, lint, typecheck, coverage, Fallow and Markdown
  checks passing when the existing private handover directory is excluded from
  formatting. Plain `npm run check` stops on pre-existing formatting in that
  directory's `run.json`; the evidence was deliberately left unchanged.
- The tracked release attestation and dependency pins were not changed. Live
  attestation was generated only in the verification helper's disposable copy.

### Final Option 2 verification

Parent-run final evidence: `/private/tmp/pi-sdk-option2-final-FV8UR2/`.

- `all.exit` is **0**. `all-results.json` reports doctor, catalog, status, usage,
  metadata, live, recovery-missing-arguments, recovery-offline-parser, recovery
  and cache all **passed**. `cleanup.json` records `scratchRemoved: true`.
- The complete upgrade gate covered all **five advertised models**. The live
  and offline recovery evidence has the distinct scopes described above; the
  independent actual-SDK contract probe also confirmed a clean hook stop.
- Parent-run repository coverage: **1,815 passed, 2 skipped across 83 files**.
  Lint, typecheck, Fallow, Markdown, modified-code formatting and
  `git diff --check` passed. Ordinary `npm run check` still stops on the baseline private
  handover `run.json` formatting; that evidence remains untouched.
- The root `@earendil-works/pi-agent-core` 1.3.0 devDependency declaration uses
  the already installed same version: no install or version-graph change. Production SDK
  and release pins and the tracked attestation remain unchanged.
- No functional source changed after this final `all`. This documentation
  correction records that snapshot's evidence, not a new runtime verification.

The fresh verification-skill `all` exit zero satisfies the targeted Option 2
live gate; partial probes and offline tests alone are not substitutes. It does
not attest full production readiness.

## Remaining boundaries

This is targeted hardening, not a blanket production-readiness attestation.

1. The rejected shapes and retry mechanisms are now established. Prompt
   clarification and an eight-turn cap do not prove elimination of malformed
   model input. Option 2 now makes the validated invalid-call recovery paths
   visible in Pi's durable transcript. Other SDK recovery pipelines, including
   the output-retry limitation above, still require explicit acceptance of their
   spend/context consequences or further redesign. The historical original
   complex journey did not meet a strict no-hidden-round-trips guarantee and
   was not rerun here as an Option 2 cost-stability proof. Do not claim the new
   guidance eliminates all overhead.
2. Main-loop cumulative usage is still preserved in Pi's single usage object.
   Internal retries can inflate context estimation and cause early compaction.
   Separating context occupancy from query spend needs an explicit accounting
   design, not silently discarding earlier model calls.
3. Long-context SDK auto-compaction and auxiliary requests need dedicated live
   coverage. Small controlled probes do not establish their absence.
4. Images, real-process cancellation, TTL expiry, and every feature-flagged SDK
   parallel path are not all covered by this focused live investigation.
5. Iterator cleanup relies on the pinned SDK's shutdown lifecycle. No production
   cleanup deadlock was established; a hostile injected iterator whose
   `return()` never resolves is not evidence of a current SDK deadlock.

Keep the provider's experimental warning until these broader release criteria
have explicit evidence. Never infer production readiness from passing unit
tests or suppress truthful cumulative usage to improve cache percentages.
