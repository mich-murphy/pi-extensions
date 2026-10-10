# Handover: bring claude-sdk-provider and pi-web-tools up to Effect standards

This document is for a fresh Pi session. It describes the remaining Effect work in
`packages/claude-sdk-provider` and `packages/pi-web-tools`, how to split it across subagents,
and how to measure code quality before and after.

The user expects that following Effect's own standards improves code quality. Treat that as a
hypothesis to test, not a result to produce. Report every metric honestly, including the ones
that get worse, and explain why.

## Read first

1. `/Users/mm/.agents/skills/typescript/SKILL.md`: the repository's TypeScript standards. Load it
   before editing any `.ts` file, and tell every subagent to load it.
2. `node_modules/effect/AGENTS.md` and the examples it links under `node_modules/effect/ai-docs/src/`.
   These are the authoritative Effect 4.0.2 docs. Do not use web docs or Effect 3 material: the
   APIs differ (`Context.Service`, `Effect.catch`, `Result` instead of `Either`).
3. `README.md`: the `npm run check` gate, Fallow rules (no `fallow-ignore`, no raised thresholds),
   and Oxlint rules (suppress only on one line, with a reason).

Useful Effect references:

| Topic | File under `node_modules/effect/ai-docs/src/` |
| --- | --- |
| `Effect.fn` / `fnUntraced` | `01_effect/01_basics/02_effect-fn.ts` |
| Schema basics | `01_effect/02_schema/10_schema-basics.ts` |
| Services | `01_effect/03_services/01_service.ts`, `20_layer-composition.ts` |
| Errors | `01_effect/04_errors/*.ts` |
| Resources | `01_effect/05_resources/10_acquire-release.ts` |
| Non-Effect hosts | `04_integration/10_managed-runtime.ts` |
| Streams | `03_stream/*.ts` |
| Testing | `09_testing/10_effect-tests.ts`, `20_layer-tests.ts` |

For anything the docs do not cover, read the source in `node_modules/effect/src/` (for example
`Schema.ts`, `Stream.ts`, `ManagedRuntime.ts`).

## Starting state

- Branch `refactor/effect-test-review`, off `main` at `bab8231`. Commit `a0a132d` holds the
  previous session's work: a test review (low-value tests removed, rendering tests rewritten) and
  small Effect fixes (`Effect.fnUntraced`, `Effect.catchTags`, `Predicate` guards, unique error
  tags). The next commit adds this folder.
- The baseline below was measured at `a0a132d`. Work on this branch, or on a branch cut from it,
  so the comparison stays valid. Nothing has been pushed.
- `npm run check` passes: 777 tests, 94.8% statements, 89.7% branches, Fallow clean.
- The other three packages (`no-sleep`, `pi-skill-toggle`, `pi-vim`) do not depend on Effect and
  are out of scope.

## Measuring quality

`docs/effect-standards/quality-snapshot.sh` runs the tests with coverage and Fallow health, then
prints a Markdown table of repository and per-package metrics. `baseline.json` in this folder is
the "before" snapshot.

```sh
# After each phase, and at the end:
bash docs/effect-standards/quality-snapshot.sh phase-1 docs/effect-standards/baseline.json
```

With a baseline argument it prints Before, After, Delta and a verdict per metric. Each metric has
a direction (for example fewer `throw` statements is better). Neutral metrics show `changed`.

### Baseline

| Metric | claude-sdk-provider | pi-web-tools |
| --- | --- | --- |
| Production LOC | 2480 | 5411 |
| Statement / branch coverage % | 92.0 / 88.8 | 94.9 / 88.6 |
| Avg / min maintainability index | 92.3 / 85.1 (`sdk/runner.ts`) | 90.8 / 86.1 (`search.ts`) |
| Avg cyclomatic / cognitive per function | 2.43 / 1.16 | 2.69 / 1.83 |
| Max CRAP | 20 | 18 |
| Functions over 60 LOC | 0 | 5 |
| zod imports | 5 | 5 |
| `Data.TaggedError` classes | 12 | 30 |
| `Context.Service` / `Layer` | 0 / 0 | 0 / 0 |
| Async generators | 4 | 0 |
| `try` blocks / `throw` statements | 4 / 1 | 8 / 15 |
| Type casts / hand-written `"x" in` guards | 4 / 0 | 7 / 4 |

Repository: Fallow health 78.4 (B); penalties are hotspots 10.0 and unit size 10.0; average
maintainability 91.6; duplication 1.1%.

### What counts as improvement

Decide this before the work starts, so the result cannot be argued into the conclusion.

**Primary metrics, per package:** average and minimum maintainability index, average cyclomatic
and cognitive complexity per function, max CRAP, functions over 60 LOC, and the counts of `try`,
`throw`, casts and hand-written guards. Coverage must not fall.

**Structural goals, checked by reading the code:**

- Every known failure is a typed error in an Effect's error channel, from the adapter to the
  tool or provider boundary.
- Dependencies are explicit services provided by layers, not constructor arguments threaded by
  hand.
- Untrusted input is parsed with Effect `Schema` at the boundary.
- Tests swap layers instead of building fakes by hand.

**Known confounders.** Report these, do not hide them:

- Fallow's hotspot penalty is based on churn. The migration itself adds commits to these files, so
  the penalty will probably rise whatever the code looks like. Report the health score both with
  and without that penalty.
- `Schema` and `Layer` add declarations, so production LOC may rise. More lines is not worse
  quality on its own; say whether the added lines carry behaviour or boilerplate.
- Do not game the numbers. Do not delete tests to raise coverage, split functions only to get under
  60 lines, or move logic into tests or config to shrink a file.

## Work plan

Six phases. Run them in order: later phases build on earlier ones. Within a phase the two packages
share no source files, so one implementer subagent per package can run in parallel.

After every phase, the coordinator:

1. Reviews the diff and runs `npm run check`. Every phase must leave it green.
2. Runs the quality snapshot with the phase label and keeps the output for the final report.
3. Commits the phase on its own, if the user has allowed commits.

### Phase 1: Schema-backed tagged errors

Replace `Data.TaggedError` with `Schema.TaggedError` (42 classes). Locations:

- pi-web-tools: `network.ts` (12), `provider-types.ts` (6), `webfetch.ts`, `search.ts`,
  `domain-policy.ts`, `html-conversion.ts` (2 each), `settings.ts`, `temp.ts`, `websearch.ts`,
  `fetch-page.ts` (1 each).
- claude-sdk-provider: `sdk/errors.ts` (7), `sdk-version-status.ts` (3), `sdk-usage.ts` (2).

Rules:

- Fields become schemas. Unclassified causes are `cause: Schema.Defect()`, as the docs do.
- Keep every `_tag` and every user-facing message exactly as it is. Tests assert these messages,
  and they are the safe text shown to users. First confirm in `Schema.ts` that a `message` getter
  can still be overridden on a `Schema.TaggedError` class. If it cannot, decide one pattern for
  safe messages and apply it everywhere.
- `SdkQueryFailureReason` (in `sdk/errors.ts`) and `ParsePublicHttpUrlError` (in `types.ts`) are
  hand-written tagged unions. Model them as Schema tagged unions if that keeps exhaustive `switch`
  handling working.
- Classes whose name does not match the tag (`InvalidFetchUrlInput`, `EmptySearchQueryInput`) keep
  their current, unique tags.

### Phase 2: Parse untrusted input with Effect Schema

Replace zod with `Schema` everywhere it parses data, then remove `zod` from `pi-web-tools`'s
`dependencies`. Fallow will report an unused dependency if one is left.

- pi-web-tools: `provider-types.ts` (`lenientArray`, `optionalTextSchema`, `publicHttpUrlSchema`),
  `provider-exa.ts`, `provider-brave.ts`, `provider-parallel.ts`, `mcp.ts`.
- claude-sdk-provider: `sdk/messages.ts`, `sdk-usage.ts`, `sdk-version-status.ts`,
  `sdk/errors.ts` (`sdkRejectionSchema`).
- **Exception:** `claude-sdk-provider/sdk/deferred-tools.ts` passes a zod shape to the Agent SDK's
  `tool()`. Its type is `AnyZodRawShape`, so zod stays there. Keep that zod schema in this one
  adapter, and parse the hook input with Schema if that is cleaner. The test helpers in
  `test/release-contract.ts` can stay on zod or move with the rest; pick one and say why.

The provider parsers are deliberately lenient: one malformed record must never sink a response
(`.catch(undefined)` and `lenientArray`). Reproduce that with `Schema` equivalents such as
`Schema.catchDecoding` or `withDecodingDefault`. The "skips invalid items and falls back when a
field has the wrong type" tests in `provider-*.test.ts` pin this behaviour. Use
`Schema.decodeUnknownResult` where the caller is synchronous and returns a `Result`, and
`decodeUnknownEffect` inside effects.

`sdk/messages.ts` builds `SdkProtocolError` details from zod issue paths, and a test checks that
the detail names the offending field without echoing its value. Keep that guarantee with Schema's
issue formatter.

### Phase 3: Services and layers for pi-web-tools

Turn the outbound ports into `Context.Service` classes with layers:

- `PublicWebClient` (`network.ts`), with the DNS lookup and `fetch` as its own dependencies
- `ProviderHttpClient` (`provider-http.ts`)
- `McpClient` (`mcp.ts`), with one client per endpoint, since Exa and Parallel use different ones
- `ToolOutputStore` (`tool-output.ts`)
- The search provider chain and fetch-rescue chain (`search.ts`)
- `FetchPage` (`fetch-page.ts`)

Build service methods with `Effect.fn("Service.method")` closures. This also removes the
`Effect.gen` calls that capture `this` in `FetchPublicWebClient` and `McpHttpClient`. Use
`Effect.fn` for real tracing boundaries (service methods) and `Effect.fnUntraced` for internal
helpers.

In the same phase:

- **Settings:** parse them into a service at the composition root. `Config` and `ConfigProvider`
  are an option, but `parseSettings` must still return a typed `InvalidSetting` for the failing-tool
  path in `index.ts`. Wrap API keys in `Redacted` and unwrap them only in the outbound adapter that
  sends the header. Keep `redactSecrets` for output scrubbing.
- **Timeouts:** carry them as `Duration`, not raw millisecond numbers.
- **Entry point:** `index.ts` builds one `ManagedRuntime` from the app layer. `webfetch.ts` and
  `websearch.ts` run through it with `runtime.runPromiseExit(program, { signal })`. Keep the
  existing translation of exits into thrown `Error`s: Pi's tool contract requires a throw. Dispose
  the runtime on `session_shutdown`. Check Pi's extension docs
  (`docs/extensions.md` under the Pi docs path in the system prompt) for the lifecycle.
- **Tool factories:** the factories are the two functions over 60 LOC. Separating `execute`, the
  rendering and the parameter schema should be a natural result of the service split, not a
  forced one.

### Phase 4: Services and layers for claude-sdk-provider

- **Services:** `inspectClaudeSdkVersions` (`ClaudeSdkVersionSources`) and `inspectClaudeUsage`
  (`StartClaudeUsageQuery`) take injected functions with defaults. Make those dependencies services
  with a live layer and test layers.
- **Command boundary:** `index.ts` has a hand-written `runCommand` that turns an `Exit` into a
  `Result`. Replace it with a `ManagedRuntime` plus the same safe-failure rendering.
- **Cache diagnostics:** `cache-diagnostics.ts` and `cache-tracker.ts` read `process.env` and
  `Date.now()`. Move the environment read into configuration at the root, and use `Clock` or
  `DateTime` for time, so tests control time without real sleeps.
- **Bridge:** `bridge.ts` sets `timestamp: Date.now()`. Take the time from `Clock` where the bridge
  runs inside Effect; otherwise leave it and say why.

### Phase 5: Stream-based runner (claude-sdk-provider)

This is the highest-risk phase. Do it last, with the strongest model.

`sdk/runner.ts` turns the SDK's `AsyncIterable` into `BridgeEvent`s with async generators and
manual `try`/`finally`. `bridge.ts` consumes an `AsyncIterable<BridgeEvent>`. Move this to `Stream`:

- Wrap the SDK query with `Stream.fromAsyncIterable`. Manage the per-turn `AbortController` with
  `Effect.acquireRelease`, so the SDK subprocess is aborted however the stream ends.
- Express the fold in `advance` and `streamQuery` with `Stream.mapAccum` or similar, ending at the
  first `result`. Decide the terminal event with the existing pure `terminalEvent`.
- At the Pi boundary, either convert with `Stream.toAsyncIterable` or run the stream into the
  `AssistantMessageWriter`. Pi's stream must still always end with exactly one terminal event, and
  a defect must still become an `SdkProviderDefect` error event rather than a rejection.

These behaviours must be preserved. `runner.test.ts` and `bridge.test.ts` pin them. Change only
their harness, never their assertions:

- The turn ends at the result without waiting for the SDK to close its stream.
- The SDK query is aborted after every turn, including an abandoned one.
- Pi's abort signal is forwarded with its reason. A pre-aborted signal never starts a query.
- At the fourth invalid deferred call the query is aborted with the limit error as the abort
  reason, and the turn fails with that error.
- Cancellation is classified as `Cancelled`. Other iteration failures are classified from the
  SDK's own error fields.
- A failure while closing a finished query does not override a result already received.

### Phase 6: Effect-native tests

- Add `@effect/vitest` 4.0.2 as a root dev dependency, pinned exactly. Its peer range is
  `vitest >=5 <6`, which matches.
- Rewrite the Effect-heavy tests to use `it.effect` with test layers, in place of
  `Effect.runPromise(Effect.result(...))` and hand-built fakes in `pi-web-tools/test/fakes.ts`.
- Use `TestClock` in place of `vi.useFakeTimers` (`sdk-usage.test.ts`) and real timeouts
  (`webfetch` and `websearch` deadline tests, the MCP and provider-HTTP timeout tests). These tests
  should then run in milliseconds.
- Keep tests behavioural. The previous session removed tests that checked implementation details
  or restated constants; do not bring that kind back.

## Subagents

The coordinator (this session) owns the plan, reviews, `npm run check`, snapshots, commits, and the
final report. Delegate with the `subagent` tool; use `get_subagent_result` to collect output and
`steer_subagent` to correct course.

| Role | When | Instructions to include |
| --- | --- | --- |
| Researcher (read-only) | Before phases 1, 2 and 5 | Confirm the exact Effect 4.0.2 APIs needed from `node_modules/effect/src`: `Schema.TaggedError` message overrides, lenient decoding combinators, Schema issue formatting, `Stream.fromAsyncIterable` and `toAsyncIterable` interruption semantics. Return signatures and short examples, no edits. |
| Implementer, one per package | Each phase | Its package's file list from this document, the two skill and doc files above, "keep messages and `_tag`s unchanged", "do not edit tests' assertions except where this document allows", "run `npx tsc --noEmit`, `npx oxlint packages`, `npx oxfmt` and the package's tests before returning". |
| Reviewer (read-only) | After each implementer | A fresh agent, not the implementer. Review the diff against this document, the TypeScript skill and the Effect docs. Report findings with file and line, with no edits. |

Rules:

- Only one writer per file at a time. The two packages can run in parallel; two agents in the same
  package cannot.
- Make root-level changes yourself, between phases: `package.json`, `package-lock.json`,
  `.fallowrc.json`, `vitest.config.ts`.
- Phase 5 gets one implementer and the most careful review. Do not parallelise it.
- If a subagent cannot keep a pinned behaviour, it stops and reports. It does not weaken the test.

## Final report

Give the user:

1. The final snapshot table against `baseline.json`, plus one row per phase for the primary
   metrics, so the effect of each step is visible.
2. A verdict on the hypothesis, metric by metric. Name the metrics that got worse and explain why
   (churn, added declarations, or a real regression).
3. The structural goals: met, partly met, or not met, with an example of each.
4. Anything deliberately left undone, such as the zod boundary in `deferred-tools.ts`, and why.
5. Test count and runtime before and after.
