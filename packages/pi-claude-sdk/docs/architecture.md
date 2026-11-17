# Architecture

This page explains how `pi-claude-sdk` turns Pi model calls into Claude Agent SDK queries. For setup, see the [README](../README.md).

## How a turn works

Pi stays the coding harness. It owns the conversation, tools, approvals and cancellation. For each model turn the provider:

1. Replays Pi's transcript into one prompt, with one content block per entry.
2. Opens an SDK `query()` with a short bridge system prompt, Pi's working instructions and Pi's tool catalog.
3. Reads messages until the first `result`, then aborts the query.
4. Returns either text or the tool calls Claude requested.

The SDK keeps no session, so each turn is stateless. A query has an eight-turn safety cap, and reaching it fails the turn with a typed error.

```mermaid
sequenceDiagram
    participant Pi
    participant Provider
    participant SDK as SDK query()
    participant Model
    Pi->>Provider: stream(transcript, tools)
    Provider->>SDK: query(prompt, MCP catalog)
    SDK->>Model: request
    Model-->>SDK: tool_use
    SDK->>Provider: PreToolUse hook
    Provider-->>SDK: defer
    alt valid input
        Provider-->>Pi: tool calls
        Pi->>Pi: run tool
    else invalid input
        Provider-->>Pi: reserved validation tool call
        Pi->>Pi: error result
    end
    Pi->>Provider: next turn with replayed transcript
```

## Tool bridge

The provider advertises each Pi tool through an in-process MCP server with its real input schema. Only the tools Pi currently declares appear. A tool whose JSON Schema uses an unsupported keyword gets a permissive schema, and Pi still validates its arguments.

- **`PreToolUse` defer.** The hook validates input with Pi's validator and returns `permissionDecision: "defer"`. The query ends with a deferred result, and the provider hands the calls to Pi. The MCP handlers are only a fallback: if one runs, the turn fails with `tool-contract`.
- **`PostToolBatch`.** The hook catches tool calls that resolved without deferral. It turns them into non-executing corrections and stops the query before another model request. Genuine failures, cancellation and a missing result fail the whole turn and release no calls.
- **Validation recovery.** Invalid input, unexpected tools and tool calls printed as text become calls to the reserved tool `pi_claude_sdk_validation_error`. It never runs real code. Pi records an error result with fixed correction text and asks the model again. An unconditional `tool_call` guard blocks the reserved name. A supported `message_end` transform normalizes known Pi rejection text only when it correlates with the latest Claude provider synthetic call and a known value-free reason. It retains `isError`, call identity and execution metadata; cancelled, successful and unrelated results stay unchanged. This also works when an explicit child allowlist excludes the helper, since unknown tools skip `tool_call` and `tool_result`. No capability is added.

Later turns collapse a reserved call and its result into one fixed text note. Replaying the call verbatim would teach the model to call an undeclared tool.

SDK tool names are `mcp__pi__<name>`, or `mcp__pi__pi_<hash>` for names the SDK cannot carry.

## Isolation from host config

Each query sets `settingSources: []`, `tools: []`, `strictMcpConfig: true` and `skills: []`. Claude Code reads no settings, `CLAUDE.md`, hooks, built-in tools, user MCP servers or skills. It runs with `permissionMode: "dontAsk"` and allows only `mcp__pi__*`. Hooks use `onFailure: "block"`, so a failing hook stops the turn. The provider also sets Claude Code options that leave memory, compaction and tool search to Pi, and removes API-key and cloud-provider variables.

## Replay format

Each transcript entry becomes a tagged block: `<user>`, `<assistant>` with `<call>` tags, and one `<results>` block holding a `<result>` per call. Bodies are not JSON-escaped. Structural tag names inside content are rewritten so content cannot forge a boundary. Errored and aborted assistant messages are skipped, and a call with no result gets an error result. Calls to tools missing from the current catalog render as `past-call` and `past-result`. Pi only appends, so earlier entries render identically on every turn.

## Prompt caching and breakpoints

The provider places up to four `cache_control` breakpoints, never on the closing "Continue" block:

- on the preamble (tools, bridge prompt and Pi instructions);
- on the previous request's tail, where the last turn wrote;
- on the newest entry;
- on an intermediate entry when more than 20 blocks separate two breakpoints, because Anthropic searches only 20 blocks back.

The provider sets `DISABLE_PROMPT_CACHING=1` so Claude Code adds no breakpoints of its own and the request stays within the four-breakpoint limit. `PI_CLAUDE_SDK_CLI_CACHE=1` restores Claude Code's policy. Retention follows `cacheRetention`, then `PI_CACHE_RETENTION`. A change to the system prompt or tool set costs one prefix rewrite. A fixed session title stops Claude Code sending an uncached titling request. Use [diagnostics](diagnostics.md) to tell a local prefix change from an upstream miss.

## Error-text privacy

The provider discards raw SDK `errors` and `result` prose. It does not redact or truncate it. Only allowlisted structured fields (terminal reasons, result subtypes, typed API errors) produce short synthetic messages. Explicit terminal categories outrank earlier generic API errors, except authentication, so `prompt_too_long` stays recognisable to Pi's context-overflow recovery. Unknown reasons become `unrecognized` in diagnostics, and unknown stop reasons fail with a value-free `protocol` error. A `rate_limit` error is a `usage-limit` only when the same query reported a rejected window.

## Model routing

Current models send a Claude Code moving alias (`sonnet`, `opus`, `haiku`). `claude-5.2-fable` sends the full ID `claude-fable-5-2`, because the `fable` alias still resolves to Fable 5.1 in Claude Code 2.1.319. `claude-4.5-haiku` sends the full ID `claude-haiku-4-5`. Any other ID passes through unchanged, so custom IDs keep working. Aliases can move without a code change.

Every turn records the concrete model from the SDK's `message_start`. `/claude-sdk-status` prints each advertised ID, its selector and the last observed model, and flags a model that differs from the expected one. The live upgrade gate checks the same resolutions, context windows and output limits. See [SDK upgrade](sdk-upgrade.md).

## Retry ownership

A retry is safe only until output has reached Pi. After that, only Pi can retry,
because only Pi can discard what it has already shown. Pi's own Anthropic
provider follows the same rule.

- **Before output.** Claude Code retries 429, 5xx and connection failures before
  any `message_start` reaches Pi. The runner sets `CLAUDE_CODE_MAX_RETRIES` from
  Pi's `retry.provider.maxRetries`, and to `0` when that is unset, so these
  retries do not multiply inside Pi's visible retry loop. Inherited retry,
  watchdog and overloaded-wait overrides are removed.
- **Commit point.** A main-loop request is open from its `message_start` until a
  `message_delta` reports a stop reason. A cut attempt ends with `message_stop`
  but no stop reason. While a request is open, a `system/api_retry` notice or a
  new `message_start` means Claude Code is resending it, so the runner ends the
  query at once with `SdkStreamInterruptedError` (diagnostic
  `stream-interrupted`). A mid-stream `overloaded` error resends without an
  `api_retry` notice, which is why a new request is checked too.
- **Untyped API error after output.** A failed `api_error` result with no typed
  API error, after a request started, is also an interruption (a mid-stream error
  event or an idle stream).
- **Refusal retry.** `CLAUDE_CODE_DISABLE_REFUSAL_RETRY=1` stops Claude Code from
  sending a hidden follow-up after a refusal; Pi surfaces the refusal.

An interruption releases no captured tool calls, and the resent request was the
same request, so Pi's automatic retry discards the partial output and starts the
turn again. The error text is worded to match Pi's retry rules. Pi decides what
to retry by matching error text, so `test/retry-ownership.test.ts` runs every
provider error message through Pi's installed classifier and fails if any result
differs from the intended one.

## Internal continuation safety boundary

A second distinct SDK `message_start` request after the first one completed is a
contract rejection (`SdkInternalContinuationError`, diagnostic
`internal-continuation`), not malformed result data. A second request while the
first is still open is an interruption instead; see
[retry ownership](#retry-ownership). The guard remains even for otherwise successful
terminal results, and releases no captured Pi tool calls. Earlier streamed text
may already be visible. A genuine failed terminal result keeps its original
category, including cancellation, usage limits and turn budgets.

There is deliberately no automatic replay for this category. Request counts do
not explain the extra request, attest to all SDK-internal effects, or establish
that replay is idempotent. The SDK MCP fallback fails closed, and Pi executes
only deferred calls after a successful handoff, but those protections are not
proof that arbitrary internal continuation is replay-safe. No broad malformed
result retry rule is added. The user reviews completed work and explicitly sends
`continue`; Pi replays its own transcript in a new stateless query. This is
user-controlled continuation, not rollback or an exactly-once execution promise.

The native scratchpad identity also changes with every query. Stable bridge
prompt guidance tells the model to reuse paths recorded in Pi history and not
move/delete files merely to match a new native ID. No directories are created,
renamed or removed by this guidance, and SDK persistence remains disabled.
