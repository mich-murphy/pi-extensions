# Pi Claude SDK

This Pi extension routes model turns through Anthropic's official Claude Agent SDK. Claude Code owns authentication; the extension does not read, copy, replay, or spoof OAuth tokens and does not call private Anthropic endpoints.

## Prerequisites

1. Install Claude Code and authenticate with the subscription account:

   ```sh
   claude auth login
   claude auth status --text
   ```

2. Install the extension package:

   ```sh
   pi install git:github.com/mich-murphy/pi-extensions
   ```

3. Restart Pi or run `/reload`.

## Use

Open `/model` and select one of:

- `claude-sdk/claude-5.5-sonnet`
- `claude-sdk/claude-5.5-opus`
- `claude-sdk/claude-5.1-fable` (Claude Fable 5.1)
- `claude-sdk/claude-5.5-haiku`
- `claude-sdk/claude-4.5-haiku`

Model IDs are version-aligned with Pi's other providers (`claude-<version>-<model>`, like `gpt-5.2-codex` or `glm-4.6`). Each version segment names the model the alias resolves to under the bundled Claude Code. Earlier releases exposed the bare aliases (`claude-sdk/sonnet` and friends). Later, Opus moved from `claude-sdk/claude-5-opus` to `claude-sdk/claude-5.5-opus`, and Sonnet moved from `claude-sdk/claude-5-sonnet` to `claude-sdk/claude-5.5-sonnet`. Update saved default models to the current IDs.

This provider is experimental. For cache-sensitive or API-billed work, select Pi's standard `anthropic/...` provider until the Agent SDK path has accumulated stable cache diagnostics.

Run `/claude-sdk-status` to compare the pinned Agent SDK, its bundled Claude Code, and the `claude` executable on `PATH`, and to show each model's advertised ID next to the canonical model it actually resolves to. Run `/claude-sdk-usage` to show the remaining subscription allowance and reset time for each rate-limit window reported by Claude. The usage command calls the Agent SDK's experimental structured usage API without sending a model prompt.

Failed turns include a stable category: `authentication`, `cancelled`, `defect` (a provider bug), `host-sleep`, `network`, `protocol`, `provider`, `timeout`, `tool-contract`, or `usage-limit`. When stderr is redirected, the provider also writes one `[claude-sdk-error]` JSON record with `schemaVersion`, `kind`, `errorTag`, and, when present, `operation` (`start` or `iterate`) and `terminalReason`. That record contains routing fields only. It excludes the provider message, prompt, credentials, and underlying cause. Diagnostic writes are suppressed when stderr is a terminal so they cannot corrupt Pi's editor or status bar; normal provider errors still appear through Pi's UI. To capture diagnostics during an interactive session, run `pi 2>claude-sdk-diagnostics.log`.

Error messages never echo raw SDK error text. Terminal `errors` and `result` prose is discarded, not redacted or truncated. Only allowlisted structured terminal reasons, result subtypes and assistant API errors produce synthetic bounded summaries (authentication, refusal, defer failure, usage/context/turn/budget/output limits, invalid requests, overload and cancellation). Explicit terminal categories take precedence over earlier API errors, including generic `unknown`/`invalid_request`; typed authentication failures retain precedence. Thus `prompt_too_long` keeps Pi's `context_length_exceeded` recovery marker unless authentication failed. Unknown terminal reasons become `unrecognized` in diagnostics; unknown stop reasons produce a value-free protocol error. Unstructured terminal prose cannot reliably supply a category and receives a generic retry/status message. Invalid-tool limit summaries and subprocess signal names are also bounded; callback failures never echo exceptions or payload validation values. Query failures are classified from the structured fields the Agent SDK attaches to its own errors (`errorClass`, `exitCode`, `signal`), and authentication failures from the typed `error` on assistant messages, so a missing executable, a crashed subprocess, or an expired login each produce a specific, actionable message.

The provider deliberately removes API-key and Bedrock, Vertex, and Foundry routing variables from the Agent SDK subprocess. This keeps the provider on Claude's first-party subscription authentication instead of silently falling back to separately billed API or cloud-provider usage.

## Architecture

- Pi remains the visible coding harness and owns its conversation, tools, approvals, and tool execution.
- Each Pi model turn is sent through the official `@anthropic-ai/claude-agent-sdk` `query()` API.
- Pi owns the outer tool loop and cancellation. Each SDK query has an eight-turn safety cap for internal recovery, including tool errors raised before the permission hook. Invalid inputs now defer to Pi rather than consuming an SDK denial/retry budget. A clean query should still use one model round-trip. The cap is deliberately not one: a one-turn SDK limit can fail before a deferred tool request returns to Pi. Reaching the safety cap produces a typed turn-limit failure rather than an unbounded hidden loop.
- Pi hands the provider a normalized transcript. The working instructions and the tool declarations travel inside the transcript's system messages (`content`, `sections`, `toolsAdded`/`toolsRemoved`), not as separate context fields, and a later system message can amend either one mid-conversation. Each turn replays them to their current state, because the Agent SDK takes one system prompt and one tool catalog per query. System messages are therefore carried by the prompt prefix and the gateway catalog, never repeated as JSONL transcript entries.
- A short custom system prompt identifies Pi and enforces the bridge protocol. Pi's longer working instructions are labeled in the stable prompt prefix because Claude Team subscription metering can reject large custom system prompts as extra usage even when it accepts the same content as prompt input. The extension does not impersonate Claude Code.
- Pi tools are advertised through one in-process MCP gateway tool, `pi_call`. The bridge tells the model to invoke the actual gateway rather than print `<invoke>` markup as an answer. A `PreToolUse` hook resolves every valid `pi_call` request with `permissionDecision: "defer"`, which ends the SDK's `query()` call cleanly (`terminal_reason: "tool_deferred"`) once every tool_use in that turn has been resolved — the SDK never executes the tool itself, and the caller does not need to race an `AbortController` against the SDK's own deny-handling to stop the turn. Unexpected top-level tool requests are handed back only as nonexecuting validation errors (`tools: []` and `settingSources: []` should already make that path unreachable).
- Invalid gateway calls and unexpected top-level tools are also deferred, but become calls to a reserved Pi-owned validation-error tool, never real tool executions. Pi records the assistant call and a native `isError` tool result with bounded correction guidance, then performs its normal next model turn. The helper is hidden from model declarations and explicitly excluded from the SDK catalog/allowlist. An unconditional `tool_call` guard blocks its reserved name even if another extension replaces its executor; its own executor also always throws. If the helper is inactive (for example `--tools read`), Pi's unknown-tool path still creates a durable error without executing anything, although the result then has generic missing-tool guidance.
- The pinned SDK exposes `PostToolBatch`, documented to run after all tool calls resolve and before the next model request. The bridge maps every previously uncaptured batch entry to a nonexecuting correction (even structurally valid input), preserves already PreToolUse-deferred valid siblings in arrival order, and returns `continue: false`. Only a clean `terminal_reason: "hook_stopped"` with a non-length stop plus this host-owned stop marker authorizes that handoff; SDK error text/tool-result prose is never interpreted as a control signal. Genuine failed results, cancellation, query rejection, missing terminal results and fallback executions still fail the entire query without releasing tools. **Acceptance composes an actual SDK/CLI malformed-parser fixture (offline synthetic Messages transport, empty HOME, dummy key) with separate live subscription missing-arguments recovery and the full live gate. This is not a claim of natural live malformed generation; see the verification skill.**
- The bridge requests one gateway invocation per assistant response. The hook still captures and deduplicates every valid deferred call the SDK delivers, but parallel deferral is not an unconditional SDK contract: the bundled CLI has a path that ignores `defer` for sibling tool uses in one assistant message. Multiple SDK assistant messages can still yield several cleanly deferred calls in one model round-trip.
- The `pi_call` MCP tool's own `handler` is a defensive fallback only — the hook resolves permission before it can run in normal operation. If the SDK ever invokes it anyway (the hook's `defer` decision was not honored), the runner aborts the query with a typed tool-contract failure. It never forwards a captured call from that failed turn or lets an error result silently trigger another model continuation.
- A `result` message that reports `is_error: true`, or `terminal_reason: "tool_deferred_unavailable"`, becomes a typed provider failure. A rejected SDK query also wins over captured calls. Pi receives captured calls only after a clean `terminal_reason: "tool_deferred"` result or a clean `terminal_reason: "hook_stopped"` (non-length stop) following its own batch-stop hook. A host stop marker never overrides `is_error`.
- The prompt is a single message, so the first `result` ends the turn. The runner stops reading there and aborts the SDK query whenever a turn ends, including a cancelled or abandoned one. It initiates SDK iterator cleanup rather than waiting for another message; subprocess shutdown follows the SDK's bounded cleanup lifecycle.
- The runner parses every SDK message once, against a table keyed by message, stream event, and delta type. It ignores any type missing from the table, so a new SDK message type cannot fail a turn. A listed type with the wrong shape is a `protocol` failure that names the field and never echoes its value.
- Pi executes the tool(s) normally. The next model turn includes the resulting Pi transcript.
- SDK session persistence is disabled because Pi is the durable conversation owner.
- The transcript is sent as one content block per JSONL entry (via the SDK's streaming-input `prompt: AsyncIterable<SDKUserMessage>` mode, not the plain-string `prompt` path, which always collapses everything into a single block). Pi only ever appends to the transcript, so entries the previous turn already sent are byte-identical this turn. The runner's environment sets `DISABLE_PROMPT_CACHING=1`, because the CLI otherwise spends breakpoints of its own on prefixes below the model's cache-creation minimum and Anthropic rejects requests with more than four `cache_control` blocks; the provider's breakpoints are the only ones on the wire. `PI_CLAUDE_SDK_CLI_CACHE=1` restores the CLI's native caching policy as an escape hatch.
- Up to four `cache_control` breakpoints are placed, never on the closing "Continue" block: on the preamble block, so a new or compacted session reads the tools, bridge system prompt and Pi working instructions from cache on its first turn; on the previous request's tail (the entry before the newest assistant entry), which is exactly where the previous turn wrote; and on the newest entry, written for the next turn. Anthropic only searches 20 content blocks backwards from a breakpoint, so when more than 20 wire blocks (each entry's text block plus one per image) separate two breakpoints, a remaining slot marks an intermediate entry, newest gap first. A wide parallel tool fan-out therefore still reads the earlier conversation instead of rewriting it.
- Pi's `cacheRetention` option picks the cache lifetime; when a request leaves it unset, Pi's `PI_CACHE_RETENTION` variable (`none`, `short` or `long`) applies instead. `none` sends no breakpoints (Pi's compaction requests use it), `short` or unset sends `{ type: "ephemeral" }` (Anthropic's standard 5-minute lifetime, Pi's own default), and `long` sends `{ type: "ephemeral", ttl: "1h" }` (writes cost more; use it when turns are often more than 5 minutes apart).
- The preamble's working instructions and the `pi_call` tool catalog always reflect Pi's current system prompt and tool set. They stay byte-identical while those are unchanged; a mid-session prompt-section or tool change deliberately costs one full prefix rewrite on that turn, after which caching resumes from the new prefix. Changes are never encoded as transcript entries, so the model always sees an accurate tool list and instructions in their authoritative position.
- Every `query()` sets a fixed session `title`. Without one, Claude Code sends a separate session-titling request that resends the whole transcript uncached on every stateless turn.
- Usage reports the 1-hour share of cache writes as Pi's `cacheWrite1h`. A terminal cumulative report without a cache-write split clears the earlier per-call split rather than misrepresenting it as a turn total.
- Supported user and tool-result images are forwarded as Anthropic image blocks. Their base64 is kept out of the JSONL text, and the breakpoint is placed after the final image in an entry. Anthropic documents that adding, removing, or changing images invalidates the affected cache prefix, so an image-introducing turn can legitimately create cache writes even when surrounding text is stable.
- Bash calls matching the executable-dump pattern (`cat $(which ...)`) are blocked. Binary-like and long base64-like bash results are replaced with a short quarantine notice before session persistence; the `context` hook also quarantines matching results from older sessions before any provider sees them.

### Programmatic runner integration

`createClaudeAgentSdkRunner()` fails closed with `tool-contract` on rejected
inputs unless its caller opts into `validationRecovery: "pi-tool-loop"`. That
option is a safety contract, not a convenience switch: install the exported
`validationRecoveryTool` and an unconditional `blockValidationRecovery` guard
before any executor, and use Pi's normal tool-result/history loop (or an
equivalent durable loop). Never blindly execute returned calls or opt in for a
consumer that lacks that guard. The extension installs these protections itself.
Valid calls still work without this opt-in.

## Request instrumentation

`onPayload` is awaited once before opening `query()`. Its SDK-adapted data payload is `{ promptBlocks: [{ text, images: [{ data, mediaType }] }], cacheBreakpoints }`, not HTTP JSON or SDK query options. `cacheBreakpoints` is an ascending array of at most four unique zero-based block indexes; `[]` sends no breakpoint. Return a replacement object of exactly this shape; returning `undefined` keeps the inspected object, including in-place edits. The validated applied payload drives both streaming input and cache diagnostics/fingerprints. Payloads require 1–4096 blocks, at most 100 images per block (media-type strings are limited to 256 characters; unsupported formats keep the existing text-note fallback), and at most 16 Mi characters per text/image-data string; breakpoint indexes must be in range. Unknown fields and malformed replacements fail before any SDK query with a value-free summary.

Fixed bridge system instructions, Pi's tool catalog/allowlist, MCP gateway, permission hooks, model routing, subscription-only environment, persistence and AbortController are not payload fields and cannot be replaced. The callback receives a copied prompt-data object, never live SDK control-plane options.

`onProviderStreamEvent` is awaited in arrival order for every SDK-yielded parsed object before provider validation/normalization, including ignored, malformed and terminal objects. No objects after the first terminal result are consumed. This is the earliest observable SDK boundary, not original HTTP bytes/SSE frames. Treat these privileged raw objects as read-only; they can contain private prompt/model/error data. Hooks are trusted extension code, not a redacted logging feed. Automatic Pi errors and diagnostics never copy them.

Payload/event callback rejection ends the turn with a safe instrumentation failure. Cancellation or runner abandonment interrupts the wait, observes late promise rejections, and aborts/closes an opened SDK iterator; the provider cannot stop arbitrary work started by a callback itself. Callbacks should cooperate with the turn signal. Existing local contract failures retain precedence, and no failed turn releases deferred tools.

`onResponse` is **unsupported and is not invoked**. Pi's callback requires real HTTP status and headers before consuming the body; the Agent SDK exposes only parsed messages, not the underlying response or its transport metadata. Query creation, SDK init and terminal results are not HTTP responses. The provider does not fabricate status/headers or use synthetic response callbacks.

## Cache diagnostics

Diagnostics are opt-in and contain only counts, breakpoint positions, usage, and truncated SHA-256 fingerprints—never prompt text or image bytes:

```sh
PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1 pi 2>claude-sdk-diagnostics.log
PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE=claude-sdk-cache.jsonl pi
```

With `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1`, each record is a `[claude-sdk-cache]` JSON line on redirected stderr; terminal stderr is deliberately silent. `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE=<path>` implies diagnostics and instead appends one plain JSON record per line to that file (created with mode `0600`) whether or not stderr is a terminal; write failures are ignored and never fail a turn.

Request records report `model`, `reasoning`, `ttl` (`none`, `5m` or `1h`), `breakpoints` (block indexes), `blocks`, character counts, `commonPrefixBlocks` and `commonPrefixCharacters` against the previous request, `contentFingerprint`, `systemFingerprint` (the preamble block), `toolsFingerprint` (the gateway catalog), `reusablePrefixFingerprint`, `msSincePreviousRequest`, and `prefixChange`: `first`, `appended`, `system-changed`, `tools-changed`, `history-rewritten`, `model-changed` or `reasoning-changed`. Usage records report the token counts (including `cacheWrite1h`/`cacheWrite5m` when the API splits them), `cacheReadPercent`, `expectedReusableCharacters`, `possibleCollapse` for a large turn below 50% reuse, and, below 50% reuse, a `likelyMissCause`: `caching-disabled`, `below-minimum`, `first`, `ttl-expired`, `prefix-changed` or `lookback` (no breakpoint within 20 blocks of the previous write). Use these records to distinguish local prefix divergence from an upstream cache miss.

The minimum cacheable prefix is model-specific: 512 tokens for the currently registered 5.x models and 4,096 for Haiku 4.5. Diagnostics report `minimumCacheableTokens` when known; an observed concrete model overrides the requested alias. Unknown models do not inherit a guessed threshold. `below-minimum` requires a positive prompt count below that threshold and no actual cache read/write evidence. Breakpoints are not pruned from character-count estimates: the minimum applies to the whole prefix through each breakpoint, including SDK-added content.

Final records also include a safe `query` summary: outcome, SDK `numTurns` when reported, `modelRequests` (distinct main-loop streamed `message_start` IDs), bounded per-model token totals, typed API error, assistant tool-use counts, internal error-tool-result count, hook-denial counts, and fallback-handler calls. Unknown model keys become query-local `unknown-N` labels rather than copying untrusted strings. Failed turns retain their available usage; failures without usage receive a separate `query` record instead of fabricated zero counts. These records never contain tool arguments, result text, denial prose, or raw SDK messages. `numTurns` can increment for internal tool-result messages too; it is not a model/HTTP-request counter. `modelRequests` counts distinct streamed main-loop starts (IDs are never logged), not auxiliary requests. A clean query with multiple observed model starts fails the handoff while preserving terminal cumulative usage; compare it with per-model totals and internal errors. See [the investigation notes](docs/cache-roundtrip-investigation.md) for evidence and remaining limits.

## Model routing

Each current advertised ID routes to a Claude Code moving alias (`sonnet`, `opus`, `fable`, `haiku`). Superseded models are pinned to their full model ID instead (`claude-4.5-haiku` → `claude-haiku-4-5`). `models.ts` records the concrete model each selector resolves to under the pinned Agent SDK. Two checks keep that table honest:

- Every turn observes the concrete model the main conversation ran on, taken from the SDK's `message_start` message. `/claude-sdk-status` prints the advertised ID, selector, and last observed model per family and flags any mismatch against the table.
- The live upgrade gate checks the SDK's model metadata (resolved IDs and native effort levels), then probes every advertised model and fails when the observed model, context window, or maximum output differs from the table. An alias can move without any pin change, and Claude Code's `ANTHROPIC_DEFAULT_*_MODEL` overrides or organization policy can change routing, so run the gate whenever a resolution is in doubt, not only at upgrade time.

## Current boundaries

- Image input is limited to Anthropic's JPEG, PNG, GIF, and WebP formats. Unsupported images become deterministic text notes so they cannot permanently break transcript replay.
- Pi-facing model IDs are version-aligned (`claude-5.5-sonnet`, `claude-5.5-opus`, `claude-5.1-fable`, `claude-5.5-haiku`, `claude-4.5-haiku`). Requests for current models send Claude Code's documented moving alias (`sonnet`, `opus`, `fable`, `haiku`) to the Agent SDK. The model metadata from bundled Claude Code 2.1.303 reports that `fable` resolves to Claude Fable 5.1, `opus` to Claude Opus 5.5, `sonnet` to Claude Sonnet 5.5, and `haiku` to Claude Haiku 5.5. `claude-4.5-haiku` sends the full model ID `claude-haiku-4-5`, because the `haiku` alias moved to Haiku 5.5 in 2.1.296. The bundled binary does not pin those resolutions on its own: `opus` was observed resolving to Claude Opus 5.5 under the unchanged 2.1.274 bundle, so a table entry can go stale without any SDK upgrade. The live gate fails when an alias resolution or context window no longer matches `models.ts`, so the table is reverified on every pin change and whenever a resolution is in doubt.
- Fable, Opus, Sonnet, and Haiku 5.5 have 1M context windows. Opus, Sonnet, and Haiku 5.5 advertise 128K output; Fable advertises **64K**, the maximum reported by bundled Claude Code 2.1.303. The [direct Messages API specifications](https://platform.claude.com/docs/en/models/overview) list 128K for Fable, but the SDK reports 64K even with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000`; this provider conservatively advertises the SDK value. `/thinking` offers native SDK effort `low`, `medium`, `high`, `xhigh`, and `max`; Fable also keeps Pi's `minimal` synonym, sent as `low`. These entries omit `off` because bundled Claude Code reports thinking-off as unsupported. This is a transport boundary, not a claim about the direct Messages API: that API supports disabled thinking on Haiku 5.5 and `between_tools` on Sonnet 5.5 at lower effort, while SDK 0.3.303 does not expose `between_tools` in its thinking configuration.
- Haiku 4.5 has a 200K context window and advertises **32K** output, the maximum reported by bundled Claude Code 2.1.303 (the direct Messages API lists 64K; setting the CLI output variable to 64000 still reports 32K). It supports **manual extended thinking**, not effort. `/thinking` offers `off`, `minimal`, `low`, `medium`, and `high`. Off explicitly sends `thinking: { type: "disabled" }`; enabled levels send manual budgets of 1,024 / 2,048 / 8,192 / 16,384 tokens respectively. Custom `thinkingBudgets` are supported and bounded to leave answer room under the model maximum; Claude Code can further cap them to its actual request output ceiling. Headless `xhigh`/`max` requests use the high budget. No Haiku 4.5 request sends `effort`.
- Model `maxTokens` describes the SDK-reported model output limit, not a promise that every turn uses that budget or that the direct Messages API has the same ceiling. Claude Code owns per-request output ceilings; this adapter does not currently forward Pi's `options.maxTokens`. Use Claude Code's documented `CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment variable when an explicit SDK request ceiling is needed. The live gate verifies the model maximum reported by `modelUsage.maxOutputTokens`, not the token count of a generated answer.
- Pi records subscription cost as zero. Token usage is retained when the SDK reports it, but Pi cannot infer the monetary value of an included subscription allocation.
- Reasoning/thinking deltas are streamed to Pi as a `thinking` content block, but the block is dropped (not replayed) when a later turn re-serializes the transcript — thinking is ephemeral, not part of the durable Pi conversation.
- An SDK `result` that ends in an error (`is_error: true`) is surfaced as a real provider error instead of a silent empty response, whatever its `stop_reason`. A `refusal` stop is a provider error too, matching Pi's Anthropic provider. A `max_tokens` stop is reported to Pi as a `length` stop reason. An unknown `stop_reason` on a clean result is a `protocol` failure.
- Streamed usage tracks the latest model call until the authoritative terminal `result.usage` replaces it. Those terminal counts cover the query's main-loop model calls, not just its final context; `modelUsage` additionally includes SDK query-pipeline side requests. Internal retries can therefore inflate Pi's context estimate and trigger compaction early. The adapter preserves reported spend instead of silently dropping earlier calls. Query diagnostics expose those retries and per-model totals separately. The API sends `null` for counts it has no value for, and the provider treats `null` like an omitted count.

## SDK upgrade gate

The Agent SDK dependency must remain an exact version. The installed SDK is the reference: ordinary CI verifies that the `package.json` pin, the `package-lock.json` entry, and `sdk-release-contract.json` all name the installed SDK version, and that the attestation's bundled Claude Code version matches the installed bundle.

To change the pinned SDK version:

1. Install the exact version, for example `npm install @anthropic-ai/claude-agent-sdk@<version> --save-exact -w packages/pi-claude-sdk`.
2. Authenticate the local Claude Code installation intended for the live check.
3. Run `npm run test:claude-sdk-upgrade`. It probes text streaming, an explicit deferred tool request, and a coding request that must call `read` rather than print tool-call markup. It also checks the SDK's model metadata, then probes every registered model to assert the advertised IDs, context windows, and maximum output match what the new bundled Claude Code actually serves (fix `models.ts` if the probe reports a moved alias or changed limits). When every contract passes, the live run rewrites `sdk-release-contract.json` from the installed SDK's metadata with the UTC verification time and the defer shape it observed. The command then checks the pinned versions.
4. Commit the rewritten attestation with the pin change. A failed or filtered live run leaves the file untouched.
5. Run `npm run check` before publishing the change. Include the live command and result in the pull request for reviewer verification.

Do not edit the attestation by hand; only a complete live run writes it. GitHub-hosted CI has no Claude subscription credential, so it validates version consistency and the committed attestation but does not pretend to prove the workstation live check. The reviewer owns that external-evidence decision.

If subscription usage limits block the live gate, do not hand-edit `sdk-release-contract.json` or claim the upgrade is live-verified. The pin/attestation consistency test deliberately stays red until a complete live run succeeds. Model metadata can still be checked without sending a model prompt:

```sh
npm run test:live -- --testNamePattern="model metadata"
```

## Checks

Use the project-local [verification skill](../../.agents/skills/verify-pi-claude-sdk/SKILL.md)
for real Pi CLI model registration, RPC status/usage notifications, text responses,
and Pi-owned tool execution. Its complete `all` run preserves evidence and must
pass before merging SDK/provider changes; exhausted subscription allowance is a
blocker, not a successful verification.

```sh
npm test
npm run typecheck
npm run test:claude-sdk-upgrade
pi --list-models claude-sdk

# Optional live cache trace (inspect the log; no raw prompt content is logged)
PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1 pi --model claude-sdk/claude-5.5-sonnet 2>claude-sdk-diagnostics.log
```
