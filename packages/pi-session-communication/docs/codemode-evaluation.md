# Codemode evaluation

## Decision

Distinguish **codemode available alongside direct tools (`on`)** from **codemode-only presentation (`only`)**. Enabling `on` is a reasonable default availability policy; requiring every communication call to go through a script is not justified by this evaluation. This revises the initial blanket recommendation to keep direct tools as the default interface. It is a policy judgment, not proof that `on` is the most efficient setting for every workload. Native codemode remains an orchestration layer, not a replacement for the gateway, adapter or delivery semantics.

The scripted offline comparison demonstrates achievable scheduling/context savings. A subsequent live GPT comparison completed twelve tasks correctly, but did **not** reproduce the scripted reduction in model requests. Codemode generated less output and had lower observed elapsed times, while using more input tokens. Two repeats per task/interface do not establish general performance or monetary savings. The earlier Sonnet attempt remains blocked and is not comparative evidence.

No production communication or provider implementation was changed for this evaluation. The tools retain their current JSON-text results; scripts use `JSON.parse`, not an assumed structured-output interface.

## Controlled offline comparison

The harness in [`../test/codemode/`](../test/codemode/README.md) runs the checkout's pinned Pi 1.5.0 SDK, native codemode and production communication adapter. A simulated Unix-socket gateway supplies synthetic publications through the production framing/schema boundary. It is **not** a native-gateway or cross-host verification.

Both arms receive the same natural-language task, synthetic corpus and required answer. The deterministic recorder derives its answer from actual tool results. The direct arm batches independent calls: six publication lists in one assistant turn, then four selected reads in another. It is not an artificially serialized baseline. The codemode arm performs the same eleven underlying operations inside one script, with only the selected answer returned to the model.

Three trials per arm and task were executed. All twelve answers and exact read traces passed. Each trial uses an isolated profile and process; at most two trial processes run concurrently. Recorder usage counters are zero/dummy and are never interpreted as provider usage.

| Task / interface | Model turns | Model-issued tool calls | Underlying operations | Tool-result text bytes | Cumulative request bytes, median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Multi-peer aggregation / direct | 4 | 11 | 11 | 12,145 | 113,976 |
| Multi-peer aggregation / codemode | 2 | 1 | 11 | 352 | 48,281 |
| One exact publication read / direct | 2 | 1 | 1 | 2,336 | 41,134 |
| One exact publication read / codemode | 2 | 1 | 1 | 65 | 42,132 |

“Model turns” includes the final answer. “Cumulative request bytes” sums UTF-8 JSON bytes of the transcript supplied to the recorder on every turn, including system instructions and tool declarations. It is neither a tokenizer measurement nor an HTTP-wire byte count. Small changes in timing strings can alter the totals slightly.

- Aggregation: **50% fewer model turns**, approximately **57.6% less cumulative request data**, and **97.1% less tool-result text** for this corpus, with the same underlying operations.
- Single read: **no turn reduction** and approximately **2.4% more cumulative request data**. Codemode's additional instructions outweigh the smaller result in this case.
- Offline elapsed times measure local execution, not live end-to-end performance. The corpus deliberately contains irrelevant synthetic publication text, so filtering has room to help. These percentages are not a general workload forecast.

Reproduce from the repository root:

```sh
RAYON_NUM_THREADS=2 UV_THREADPOOL_SIZE=2 GOMAXPROCS=2 OMP_NUM_THREADS=2 \
  node --import jiti/register \
  packages/pi-session-communication/test/codemode/run.ts \
  /tmp/session-codemode-results.json 3

npm test -- packages/pi-session-communication/test/codemode --maxWorkers=2
```

The test gate does not rewrite the result artifact. It checks correctness, exact active tools, exact selected reads/revisions, operation counts and the expected scheduling/context tradeoff.

## Live Sonnet attempt: not comparative evidence

The planned comparison used `claude-sdk/claude-5.5-sonnet`, medium effort, two tasks, two arms and two repeats, with counterbalanced arm order. Both arms retained the direct tools; treatment added native codemode in `on` mode, so actual codemode adoption—not merely availability—was to be recorded. Profiles and working directories were isolated, context discovery and built-in tools disabled, and only synthetic data was supplied. No credentials were copied or printed; the existing official subscription authentication path was used without opting into Extra Usage.

Six attempts reached the provider. Each produced eight completed `pi_claude_sdk_validation_error` results with `invalid_tool_input`, zero communication tool executions and no task answer. The runner began a ninth turn before its external cancellation took effect. Two later scheduled rows failed during fixture startup before a provider call. The fixture was still being refined during that attempt, so it was not a frozen-source live benchmark.

The batch's fail-fast and turn-limit handling were inadequate. Parent review stopped further live work; subsequent local runner revisions remain **experimental and not accepted for live reuse** because process/event-based stopping still raced fast offline model turns. No latency, token-efficiency, correctness-rate or monetary comparison is inferred from these failed runs. Their usage counters describe failed validation loops, not the requested tasks.

The rejection's root cause remains unresolved. Standalone and actual-Pi-loader offline diagnostics successfully pass valid peer discovery, publication reads and inbox arguments through the production SDK catalog/capture path. Degraded schemas include parameter JSON in their descriptions; schema-degradation warnings alone do not prove that the model lacked field names. The live substituted error results do not retain the original rejected arguments, so neither a provider bug nor a specific model mistake is established.

Before repeating the Claude SDK comparison, require diagnostics that distinguish malformed model inputs from bridge failures using synthetic data only. The subsequent GPT evaluation below used a separate native provider route, a frozen fixture, an in-process pre-inference budget guard, validation-failure stopping and verified cleanup. Its success does not resolve the Claude SDK rejection.

## Live GPT comparison: actual model behavior

Two `openai/gpt-6.1-sol`, medium-effort workers implemented and independently audited the temporary evaluation. The task model was also **`openai/gpt-6.1-sol`, medium**, through Pi's native OpenAI Responses provider. The comparison used the pinned Pi SDK, production communication adapter and the same synthetic Unix-socket fixture—not the native gateway or a cross-host deployment.

Three presentations were compared across aggregation and single-read tasks, with two repeats each and reversed arm order between repeats:

- **Direct:** six communication tools declared to the model.
- **On:** the same six tools plus native codemode; the model chooses how to call them.
- **Only:** only codemode declared to the model, with the communication tools callable inside scripts. All six names were available inline; no tool-introspection calls were needed.

The natural-language tasks and common JSON-string parsing note were identical. No authored solution or instruction to fuse the workflow into one script was supplied. Both codemode arms used `createCodemodeExtension({mode, models:false})`, intentionally excluding non-chat model helpers from this tool-orchestration comparison. Profiles/context/session state were isolated; existing supported authentication was used without copying credentials.

### Results

All **12/12 answers were correct**. **11/12 operation traces were exact**: aggregate/only repeat1 discovered peers twice, rather than once, but listed all six peers and read all four required revision-pinned publications exactly once. Every receipt succeeded. That row remains in the results and medians; it was not retried or replaced.

The following are medians of **two observations per row**, not population estimates:

| Task / presentation | Model requests | Input tokens, including cache | Output tokens | Task elapsed, seconds | Exact traces |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aggregation / direct | 4 | 18,198 | 693 | 25.041 | 2/2 |
| Aggregation / on | 4 | 20,408.5 | 450 | 19.782 | 2/2 |
| Aggregation / only | 4 | 20,433 | 300 | 19.054 | 1/2 |
| Single read / direct | 2 | 6,885 | 73 | 7.904 | 2/2 |
| Single read / on | 2 | 7,899 | 73 | 6.232 | 2/2 |
| Single read / only | 2 | 8,067.5 | 82.5 | 6.668 | 2/2 |

Input totals include cached tokens **once**. Raw provider `input_tokens` reconciled with Pi's uncached-input plus cache-read/cache-write fields on every request; output and total counters also reconciled. Cache state was not controlled, and catalog cost estimates are not billed charges. No general price or latency advantage is claimed.

Actual behavior explains the difference from the offline result:

- The direct model fairly batched the independent lists and reads; it did not make eleven inference requests.
- In `on`, the model chose codemode for both aggregation tasks and direct calls for both single reads.
- Both codemode presentations split aggregation into discovery, listing and reading stages across **three tool-producing model responses**, followed by the answer. They returned full intermediate results rather than just the selected tickets. The duplicate discovery occurred when a later script fetched peers again instead of reusing the first script's result.
- Consequently, all aggregation arms needed **four model requests**, not the authored offline script's two. Codemode's ability to combine dependent operations was not automatically used by this model/task/prompt combination.
- Codemode still reduced aggregate output tokens: approximately **35% for on** and **57% for only**. Observed elapsed-time medians were approximately 21% and 24% lower, respectively. These are useful small-sample observations, not a reliable performance forecast.
- Aggregate input tokens were approximately 12% higher with either codemode presentation. Single-read input was approximately 15% higher for on and 17% higher for only, with no request-count benefit.
- There was no live intermediate-text compression: aggregation tool-result text was 12,145 bytes for direct, versus median 13,279 for on and 13,355.5 for only. These are raw top-level text bytes, not JSON-serialized content-array bytes; nested execution events are excluded.

This is why availability and mandatory use should not be conflated. `On` offers the model a useful orchestration choice and retained direct calls for simple tasks. But the large offline savings depend on the script strategy, not merely on turning codemode on. Keeping direct-only as a conservative choice is also defensible for a small toolset or input-sensitive workload; this sample does not establish a universally optimal default.

### Budget, integrity and cleanup

Exactly **12 task starts and 36 logical/provider HTTP requests** occurred. Each run had a synchronous pre-inference limit of eight dispatches, bounded output, an approximately 180-second deadline, disabled retries/compaction/cache warming and a separate HTTP-dispatch backstop. Offline proofs independently exercised the cap, validation/domain-error stopping, declaration sets, scorer mutations and startup/shutdown cleanup failures. The parent reran the guard proof successfully before authorizing live execution.

The initial two-run checkpoint passed. A subsequent scheduler stopped on the duplicate-discovery trace mismatch; parent review classified it as an observed read-only efficiency failure and authorized only the five unconsumed scheduled rows. The failed trace was retained, with no retry. Phase ledgers, actual exit statuses and source snapshots are archived. Scheduler additions left the per-trial engine byte-identical; fresh offline proofs preceded each phase. All twelve live cleanup checks passed, and fixture/production-source manifests matched. No further live starts are authorized by this evaluation.

## Separate offline safety checks

A scripted provider also exercised the real Pi CLI in RPC mode with native codemode, the production adapter and the simulated gateway. Parent review independently checked the raw events and receipts:

- **Unknown send:** one nested `session_send`, one logical message ID and one send receipt. The model-visible script output retained `unknown` and the production no-resend warning. No replay occurred in this authored script.
- **RPC abort during a pending read:** the nested operation returned `cancelled`, codemode returned an aborted-script error, and the prompt settled. One read request was observed, with no replay.
- **Script deadline during a pending read:** a three-second native codemode deadline cancelled the nested operation and returned a timeout error. One read request was observed, with no replay.

All three Pi processes and fixture daemons exited0, and no process group remained at the recorded cleanup observation. These demonstrate mechanism behavior for the tested scripts, not that a live model will preserve uncertainty or avoid unsafe retries. They are archived temporary journeys, not additions to the retained comparison test. Hook-blocked sends, destructive-take failure and codemode TUI presentation were not exercised in this evaluation.

## Adoption boundaries

- Start with discovery, publication list/read and filtering. Keep full exact publisher identities and revisions where subsequent actions depend on them.
- Retain direct calls for simple reads, inbox retrieval and individual sends even when codemode is enabled by default. Their communication-specific rendering is clearer than codemode's generic nested-call rows; the live comparison did not evaluate TUI usability.
- Do not reconstruct `session_report` in a script: it already handles bounded fan-out and publication/notification partial outcomes.
- Never automatically rerun sends or reports after script failure. Each new send invocation creates a new logical message ID; script cancellation does not roll back effects.
- `session_take` consumes payloads. A later script failure or filtered output does not restore them; codemode storage is not a transaction with inbox consumption.
- Structured output schemas would improve script ergonomics, but are a separate change. Adding them must preserve provenance and make the resolve-versus-reject error contract deliberate.

## Evidence and verification

The original evaluation's local audit archive is named `session-communication-codemode-20261107`. It is retained outside the repository and is not a shipped or public CI artifact.

It includes source manifests, the independently executed offline result artifact, canonical-check logs, synthetic live failure traces and temporary diagnostic sources. The earlier Sonnet runner is retained for audit, not offered as a validated live-evaluation command.

The subsequent GPT evidence is retained separately in the local audit archive `session-communication-codemode-gpt-retry-20261107`, also outside the repository. The retained offline harness above is reproducible from the checkout; these private live-evaluation artifacts are not a substitute for checks runnable by reviewers.

It includes the bounded evaluator and all phase snapshots, offline guard proofs, twelve live result artifacts, raw per-request usage, source manifests, cleanup records, preserved exit statuses, worker summaries and independent parent analysis. The new evaluator was accepted for this finite study, not installed as production behavior or a general unattended benchmark. The successful GPT route does not validate the Claude SDK route. The follow-up changed documentation only in the repository; its fresh formatting/Markdown checks are separate from the earlier full code gate.

The final parent `npm run check` exited0: formatting, strict lint/typecheck, all locked Rust gates (56 tests), TypeScript coverage (2,083 passed, two existing skips), Fallow dead-code/duplicates/health and Markdown. Coverage remained95.43% statements,91.54% branches and95.40% lines. The first full attempt passed tests but failed two new evaluation-helper complexity thresholds; those helpers were refactored without suppressions or threshold changes, then the complete gate passed. Subsequent report-only edits received fresh formatting/Markdown checks.

The final three-trial comparison command also exited0. Source manifests before and after the final execution matched. The retained comparison test covers the two comparison tasks; the separately archived safety journeys and failed live attempts retain their narrower evidence boundaries.
