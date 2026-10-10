# Claude subscription provider for Pi

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

Failed turns include a stable category: `authentication`, `cancelled`, `defect` (a provider bug), `host-sleep`, `network`, `protocol`, `provider`, `timeout`, `tool-contract`, or `usage-limit`. The provider also writes one `[claude-sdk-error]` JSON record to stderr with `schemaVersion`, `kind`, `errorTag`, and, when present, `operation` (`start` or `iterate`) and `terminalReason`. That record contains routing fields only. It excludes the provider message, prompt, credentials, and underlying cause.

Error messages never echo raw SDK error text. Query failures are classified from the structured fields the Agent SDK attaches to its own errors (`errorClass`, `exitCode`, `signal`), and authentication failures from the typed `error` on assistant messages, so a missing executable, a crashed subprocess, or an expired login each produce a specific, actionable message.

The provider deliberately removes API-key and Bedrock, Vertex, and Foundry routing variables from the Agent SDK subprocess. This keeps the provider on Claude's first-party subscription authentication instead of silently falling back to separately billed API or cloud-provider usage.

## Architecture

- Pi remains the visible coding harness and owns its conversation, tools, approvals, and tool execution.
- Each Pi model turn is sent through the official `@anthropic-ai/claude-agent-sdk` `query()` API.
- The query does not set the SDK's `maxTurns`; Pi owns the outer tool loop and cancellation. A one-turn SDK cap can fail before a deferred tool request returns to Pi.
- Pi hands the provider a normalized transcript. The working instructions and the tool declarations travel inside the transcript's system messages (`content`, `sections`, `toolsAdded`/`toolsRemoved`), not as separate context fields, and a later system message can amend either one mid-conversation. Each turn replays them to their current state, because the Agent SDK takes one system prompt and one tool catalog per query. System messages are therefore carried by the prompt prefix and the gateway catalog, never repeated as JSONL transcript entries.
- A short custom system prompt identifies Pi and enforces the bridge protocol. Pi's longer working instructions are labeled in the stable prompt prefix because Claude Team subscription metering can reject large custom system prompts as extra usage even when it accepts the same content as prompt input. The extension does not impersonate Claude Code.
- Pi tools are advertised through one in-process MCP gateway tool, `pi_call`. The bridge tells the model to invoke the actual gateway rather than print `<invoke>` markup as an answer. A `PreToolUse` hook resolves every valid `pi_call` request with `permissionDecision: "defer"`, which ends the SDK's `query()` call cleanly (`terminal_reason: "tool_deferred"`) once every tool_use in that turn has been resolved — the SDK never executes the tool itself, and the caller does not need to race an `AbortController` against the SDK's own deny-handling to stop the turn. A request for any other top-level tool name is denied outright (defense in depth; `tools: []` and `settingSources: []` should already make that path unreachable).
- An invalid `pi_call` request, such as an unknown inner `name`, the self-referential `name: "pi_call"`, or malformed `arguments`, is denied with a correction in `permissionDecisionReason`. A deny does not end `query()`, so the model can retry within the same turn. The runner allows 3 invalid attempts. The fourth aborts the SDK query and returns a typed provider failure, even if another call was captured in that turn.
- The hook captures every deferred call it sees, so a turn in which the model batches several `pi_call` requests together (parallel tool use) hands all of them back to Pi, not just the first.
- The `pi_call` MCP tool's own `handler` is a defensive fallback only — the hook resolves permission before it can run in normal operation. If the SDK ever invokes it anyway (the hook's `defer` decision was not honored), it returns an error result and does not forward the call to Pi, instead of faking a successful defer.
- A `result` message that reports `is_error: true`, or `terminal_reason: "tool_deferred_unavailable"`, becomes a typed provider failure. A rejected SDK query also wins over captured calls. Pi receives deferred calls only after a clean `terminal_reason: "tool_deferred"` result.
- The prompt is a single message, so the first `result` ends the turn. The runner stops reading there and aborts the SDK query whenever a turn ends, including a cancelled or abandoned one. A turn never waits on the SDK to close its own stream, and no subprocess outlives it.
- The runner parses every SDK message once, against a table keyed by message, stream event, and delta type. It ignores any type missing from the table, so a new SDK message type cannot fail a turn. A listed type with the wrong shape is a `protocol` failure that names the field and never echoes its value.
- Pi executes the tool(s) normally. The next model turn includes the resulting Pi transcript.
- SDK session persistence is disabled because Pi is the durable conversation owner.
- The transcript is sent as one content block per JSONL entry (via the SDK's streaming-input `prompt: AsyncIterable<SDKUserMessage>` mode, not the plain-string `prompt` path, which always collapses everything into a single block). Pi only ever appends to the transcript, so entries the previous turn already sent are byte-identical this turn; the last entry carries an explicit `cache_control: { type: "ephemeral" }` breakpoint (Anthropic's documented moving multi-turn pattern) so the API can serve that unchanged prefix from cache and pay only for the newly appended suffix. The runner's environment sets `DISABLE_PROMPT_CACHING=1`, because the CLI otherwise spends breakpoints of its own on blocks far below the 1024-token cache-creation minimum and Anthropic rejects requests with more than four `cache_control` blocks; the provider breakpoint is the only one on the wire. `PI_CLAUDE_SDK_CLI_CACHE=1` restores the CLI's native caching policy as an escape hatch. Anthropic only searches 20 blocks backwards from a breakpoint, so diagnostics report the exact common block prefix between consecutive turns. A mid-conversation system message rewrites the prefix block that carries the working instructions, so the turn that first sees one pays for a full prefix write.
- Supported user and tool-result images are forwarded as Anthropic image blocks. Their base64 is kept out of the JSONL text, and the breakpoint is placed after the final image in an entry. Anthropic documents that adding, removing, or changing images invalidates the affected cache prefix, so an image-introducing turn can legitimately create cache writes even when surrounding text is stable.
- Bash calls matching the executable-dump pattern (`cat $(which ...)`) are blocked. Binary-like and long base64-like bash results are replaced with a short quarantine notice before session persistence; the `context` hook also quarantines matching results from older sessions before any provider sees them.

## Cache diagnostics

Diagnostics are opt-in and contain only counts, breakpoint positions, usage, and truncated SHA-256 fingerprints—never prompt text or image bytes:

```sh
PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1 pi
```

Each request emits a `[claude-sdk-cache]` JSON line on stderr. A request carries at most one provider cache breakpoint, reported as `breakpointBlock`. Consecutive request records include `commonPrefixBlocks` and `commonPrefixCharacters`; usage records include `cacheReadPercent` and flag a large turn below 50% reuse as `possibleCollapse`. Use these records to distinguish local prefix divergence from an upstream cache miss.

## Model routing

Each current advertised ID routes to a Claude Code moving alias (`sonnet`, `opus`, `fable`, `haiku`). Superseded models are pinned to their full model ID instead (`claude-4.5-haiku` → `claude-haiku-4-5`). `models.ts` records the concrete model each selector resolves to under the pinned Agent SDK. Two checks keep that table honest:

- Every turn observes the concrete model the main conversation ran on, taken from the SDK's `message_start` message. `/claude-sdk-status` prints the advertised ID, selector, and last observed model per family and flags any mismatch against the table.
- The live upgrade gate probes every advertised model and fails when the observed model or context window differs from the table, so a moved alias is caught before the SDK pin lands. An alias can also move without any pin change, so run the gate whenever a resolution is in doubt, not only at upgrade time.

## Current boundaries

- Image input is limited to Anthropic's JPEG, PNG, GIF, and WebP formats. Unsupported images become deterministic text notes so they cannot permanently break transcript replay.
- Pi-facing model IDs are version-aligned (`claude-5.5-sonnet`, `claude-5.5-opus`, `claude-5.1-fable`, `claude-5.5-haiku`, `claude-4.5-haiku`). Requests for current models send Claude Code's documented moving alias (`sonnet`, `opus`, `fable`, `haiku`) to the Agent SDK. Under bundled Claude Code 2.1.296, `fable` resolves to Claude Fable 5.1, `opus` to Claude Opus 5.5, `sonnet` to Claude Sonnet 5.5, and `haiku` to Claude Haiku 5.5. `claude-4.5-haiku` sends the full model ID `claude-haiku-4-5`, because the `haiku` alias moved to Haiku 5.5 in 2.1.296. The bundled binary does not pin those resolutions on its own: `opus` was observed resolving to Claude Opus 5.5 under the unchanged 2.1.274 bundle, so a table entry can go stale without any SDK upgrade. The live gate fails when an alias resolution or context window no longer matches `models.ts`, so the table is reverified on every pin change and whenever a resolution is in doubt.
- Fable, Opus, Sonnet, and Haiku 5.5 are declared with their current 1M context windows and 128K maximum output, and they accept the Agent SDK's `effort` option. Haiku 4.5 keeps its 200K context window and 64K maximum output. It does not support `effort`, so the provider omits effort-based reasoning settings for every Haiku 4.5 request, including requests from headless callers and Pi sub-agents.
- Pi records subscription cost as zero. Token usage is retained when the SDK reports it, but Pi cannot infer the monetary value of an included subscription allocation.
- Reasoning/thinking deltas are streamed to Pi as a `thinking` content block, but the block is dropped (not replayed) when a later turn re-serializes the transcript — thinking is ephemeral, not part of the durable Pi conversation.
- An SDK `result` that ends in an error (`is_error: true`) is surfaced as a real provider error instead of a silent empty response, whatever its `stop_reason`. A `refusal` stop is a provider error too, matching Pi's Anthropic provider. A `max_tokens` stop is reported to Pi as a `length` stop reason. An unknown `stop_reason` on a clean result is a `protocol` failure.
- Usage is the latest model call's token counts, which is what Pi needs to size the context. The API sends `null` for counts it has no value for, and the provider treats `null` like an omitted count.

## SDK upgrade gate

The Agent SDK dependency must remain an exact version. The installed SDK is the reference: ordinary CI verifies that the `package.json` pin, the `package-lock.json` entry, and `sdk-release-contract.json` all name the installed SDK version, and that the attestation's bundled Claude Code version matches the installed bundle.

To change the pinned SDK version:

1. Install the exact version, for example `npm install @anthropic-ai/claude-agent-sdk@<version> --save-exact -w packages/claude-sdk-provider`.
2. Authenticate the local Claude Code installation intended for the live check.
3. Run `npm run test:claude-sdk-upgrade`. It probes text streaming, an explicit deferred tool request, and a coding request that must call `read` rather than print tool-call markup. It then probes every registered model to assert the advertised IDs and context windows match what the new bundled Claude Code actually serves (fix `models.ts` if the probe reports a moved alias). When every contract passes, the live run rewrites `sdk-release-contract.json` from the installed SDK's metadata with the UTC verification time and the defer shape it observed. The command then checks the pinned versions.
4. Commit the rewritten attestation with the pin change. A failed or filtered live run leaves the file untouched.
5. Run `npm run check` before publishing the change. Include the live command and result in the pull request for reviewer verification.

Do not edit the attestation by hand; only a complete live run writes it. GitHub-hosted CI has no Claude subscription credential, so it validates version consistency and the committed attestation but does not pretend to prove the workstation live check. The reviewer owns that external-evidence decision.

## Checks

```sh
npm test
npm run typecheck
npm run test:claude-sdk-upgrade
pi --list-models claude-sdk

# Optional live cache trace (inspect stderr; no raw prompt content is logged)
PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1 pi --model claude-sdk/claude-5.5-sonnet
```
