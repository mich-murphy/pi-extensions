# Runner API

Extension authors can run the provider's SDK runner directly. The extension itself uses this API.

## `createClaudeAgentSdkRunner`

```ts
createClaudeAgentSdkRunner(options?: RunnerOptions): AgentSdkRun
```

The runner is in `sdk/runner.ts`. All options are optional.

| Option | Effect |
| --- | --- |
| `claudeExecutable` | Claude Code executable to run. Defaults to the installed one. |
| `validationRecovery` | `"pi-tool-loop"` opts in to validation recovery. See below. |
| `sdkEnvironment` | Environment for the subprocess. |
| `cacheDiagnostics` | Cache diagnostics tracker. |
| `modelObserver` | Receives the concrete model, context window and output limit seen on a terminal result. |
| `usageLimitObserver` | Receives `{ resetsAt }` (epoch milliseconds). A throw is ignored. |
| `runSdkQuery`, `createMcpServer` | Injection points for tests. |

## Validation recovery

By default the runner fails with `tool-contract` when a tool call has invalid input. Valid calls work without any option.

Set `validationRecovery: "pi-tool-loop"` only when all of these hold:

- You register the exported `validationRecoveryTool` from `validation-recovery.ts`.
- You install `blockValidationRecovery` as an unconditional `tool_call` guard before any executor.
- You feed results back through Pi's normal tool-result loop, or an equivalent durable loop.

Without the guard, the runner could return a synthetic call that executes. The extension installs both itself.

## `onPayload`

Pi calls `onPayload` once, awaited, before the runner opens `query()`. It receives a copy of the prompt data:

```ts
{ promptBlocks: [{ text, images: [{ data, mediaType }] }], cacheBreakpoints: number[] }
```

- Return a replacement object of exactly this shape, or `undefined` to keep the inspected object, including in-place edits.
- `cacheBreakpoints` is ascending, unique, zero-based and has at most four entries. `[]` sends none.
- Limits: 1 to 4,096 blocks, at most 100 images per block, media types up to 256 characters, and at most 16 Mi characters per text or image-data string.
- Unknown fields, malformed replacements and out-of-range indexes fail the turn before the query starts.
- The bridge prompt, tool catalog, hooks, model routing, environment and abort controller are not payload fields and cannot be replaced.

## `onProviderStreamEvent`

The runner awaits this callback in arrival order for every object the SDK yields, before validation. That includes ignored, malformed and terminal objects. It stops after the first terminal result.

- The objects are the earliest observable SDK boundary, not HTTP bytes.
- Treat them as read-only. They can hold private prompt, model and error data. The provider never copies them into errors or diagnostics.

## Callback failures

A rejection in either callback ends the turn with a value-free instrumentation failure. Cancellation interrupts the wait, and the runner aborts the SDK iterator. The runner cannot stop work your callback started, so honor the turn's abort signal. No failed turn releases tool calls.

## `onResponse`

`onResponse` is unsupported and never called. The Agent SDK exposes parsed messages, not the HTTP status or headers it needs.
