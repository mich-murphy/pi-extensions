# Offline codemode vs direct tools evaluation

Scope: actual pinned Pi SDK, native `codemode` extension, production adapter, **simulated gateway** (synthetic
transport speaking real frames; not the native gateway) and a deterministic scripted recorder model. No external
provider calls or real credentials. This measures scheduling and context size only, not model quality, tokens or live latency.
See the [evaluation report](../../docs/codemode-evaluation.md) for executed offline results, the separate live GPT comparison and the unresolved Sonnet validation blocker. This retained harness remains a scripted offline evaluation, not the temporary live runner.

- `corpus.ts` tasks/expected outcomes; `gateway.ts` SimulatedGateway; `profile.ts` temp agent dir;
  `serve.ts` fixture CLI for live evaluators; `recorder.ts` scripted policy (direct arm batches independent calls per round);
  `trial.ts` one trial per process; `run.ts` runner (max 2 concurrent); `codemode.test.ts` fast wrapper (1 trial, temp only).

Fixture for live use (prints one JSON line: socketPath, agentDir, config, cwd, extension, task {id,prompt,expected}):

    node --import jiti/register packages/pi-session-communication/test/codemode/serve.ts --scenario aggregate [--codemode] [--receipts file]

Run with `PI_CODING_AGENT_DIR=<agentDir>` and `-e <extension>`; receipts are written when stdin closes.

Results artifact (explicit only; the test never writes it):

    node --import jiti/register packages/pi-session-communication/test/codemode/run.ts results.json 3

Metrics: `toolResultBytes` = UTF-8 bytes of tool-result text; `cumulativeRequestBytes` = summed JSON bytes of every
request transcript (includes tool declarations); rounds, tool calls, gateway ops, correctness vs expected JSON.
Recorder usage counters are dummy. Known limits: scenarios partial_failure/unknown_send/pending_cancel exist in the
fixture but have no scripted arm in this retained harness; no nested-hook or take-failure scenario. Teardown emits
session_shutdown before dispose, and the runner fails on unexpected stderr. Fallow registers the actual serve.ts,
run.ts and trial.ts CLI/subprocess entrypoints; Vitest discovers codemode.test.ts normally. Separate archived safety
journeys are described in the evaluation report and are not implied by the fixture fault definitions.
