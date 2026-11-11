# pi-claude-sdk

Run Claude models in Pi through the Claude Agent SDK and your Claude Code subscription.

## Requirements

- Claude Code 2.1.317 or later, installed and signed in with `claude auth login`. Run `claude update` if it is older.
- `claude` on your `PATH`, or `PI_CLAUDE_SDK_CLAUDE_PATH` set to its executable. The provider never runs a bundled binary.

## Install

```sh
pi install git:github.com/mich-murphy/pi-extensions
```

This loads every extension. To [load only some extensions](../../README.md#install), see the root README. Restart Pi or run `/reload`.

## Usage

Open `/model` and pick a `claude-sdk/...` model. To list them from the shell:

```sh
pi --list-models claude-sdk
```

The provider registers these models:

| ID | Context | Max output | Thinking levels |
| --- | --- | --- | --- |
| `claude-5.5-sonnet` | 1,000,000 | 128,000 | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-5.5-opus` | 1,000,000 | 128,000 | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-5.2-fable` | 1,000,000 | 128,000 | `minimal` (sent as `low`), `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-5.5-haiku` | 1,000,000 | 128,000 | `low`, `medium`, `high`, `xhigh`, `max` |
| `claude-4.5-haiku` | 200,000 | 32,000 | `off`, `minimal`, `low`, `medium`, `high` |

The 5.x models cannot turn thinking off. Haiku 4.5 uses manual thinking budgets instead of effort.

## Commands

| Command | Effect |
| --- | --- |
| `/claude-sdk-status` | Shows the Agent SDK and Claude Code versions, and for each model the Claude Code alias it sends and the model that actually answered. It flags a mismatch. |
| `/claude-sdk-usage` | Shows the remaining subscription allowance and reset time for each rate-limit window. It sends no model prompt. |

## Configuration

Set these environment variables before you start Pi:

| Variable | Default | Effect |
| --- | --- | --- |
| `PI_CLAUDE_SDK_CLAUDE_PATH` | search `PATH` | Path to the Claude Code executable. An invalid path fails the turn. |
| `PI_CLAUDE_SDK_ALLOW_EXTRA_USAGE` | unset | `1` lets turns bill to Extra Usage. See the guard below. |
| `PI_CLAUDE_SDK_ENTRYPOINT` | `pi-claude-sdk` | Label that tells Claude which client sent the request, via `CLAUDE_CODE_ENTRYPOINT`. It must match `^[a-z0-9][a-z0-9._-]{0,63}$`. Labels that name Anthropic's own clients are ignored, so the provider never impersonates them. |
| `PI_CLAUDE_SDK_CLI_CACHE` | unset | `1` restores Claude Code's own caching instead of the provider's breakpoints. |
| `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS` | unset | `1` writes cache records to redirected stderr. See [diagnostics](docs/diagnostics.md). |
| `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE` | unset | Appends cache records to this file and implies diagnostics. |
| `PI_CACHE_RETENTION` | unset (5 minutes) | Pi's variable, not this package's. `none`, `short` (5 minutes) or `long` (1 hour) sets the prompt-cache lifetime unless the request sets its own. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Claude Code default | Claude Code's variable. The provider sets it from the request's `maxTokens` when Pi supplies one. |

> [!WARNING]
> By default, a turn fails when Claude reports it would bill to Extra Usage, instead of continuing at pay-as-you-go rates. The event arrives after Claude Code has sent the request, so the request that triggers the guard may already be billed. The guard only stops later requests.

## Subscription-only routing

The provider removes API-key, Bedrock, Vertex and Foundry variables from the Claude Code subprocess, so turns never fall back to separately billed usage.

## How it behaves

- Pi owns the conversation, tools, approvals and tool execution. Claude only proposes tool calls.
- Claude Code settings, `CLAUDE.md`, hooks, MCP servers and built-in tools are not loaded. See [architecture](docs/architecture.md).
- A failed turn carries one category: `authentication`, `cancelled`, `defect` (a provider bug), `host-sleep`, `internal-continuation`, `network`, `protocol`, `provider`, `rate-limit`, `server-error`, `timeout`, `tool-contract` or `usage-limit`.
- Error text never includes raw SDK output.
- Recognized `cat` commands that read paths from `which` or `command -v` substitutions are blocked; literal quoted text and supported quoted heredoc data are not commands. The scanner conservatively refuses unsupported heredoc delimiters (escaped ANSI-C quotes, locale-translated quotes, or substitution-shaped spelling) and excessive nesting rather than guessing which text executes. Plain ANSI-C quoted delimiters are supported. For literal documents, prefer the `write` tool. Binary-like or long base64-like `bash` output is still quarantined, including in older session context. This is a best-effort guard, not a shell sandbox.
- When stderr is redirected, the provider writes one `[claude-sdk-error]` JSON record per failure with routing fields only. Capture it with `pi 2>claude-sdk-diagnostics.log`.
- On a usage limit with a known reset time, the provider emits `{ provider: "claude-sdk", resetsAt }` (epoch milliseconds) on Pi's `usage-limit` event channel. `pi-auto-resume` uses it.

## Limitations

- The provider is experimental. For cache-sensitive or API-billed work, use Pi's `anthropic/...` provider.
- Images must be JPEG, PNG, GIF or WebP. Other images become text notes.
- Pi records subscription cost as zero.
- Thinking blocks stream to Pi but are not replayed on later turns.
- Each SDK query uses a fresh native session ID. Pi owns continuity: reuse scratch paths recorded in the Pi conversation, not a native per-query scratchpad suggestion. A new SDK ID is not a reason to move or delete earlier scratch files. The provider does not enable SDK session persistence.

## Troubleshooting

- **`ENOENT` or "session working directory is unavailable".** You removed the worktree Pi started in. Exit Pi, change to an existing worktree, then run `pi --session /absolute/path/to/session.jsonl`. To keep the original session intact, run `pi --fork /absolute/path/to/session.jsonl`.
- **"Claude Code is too old".** Run `claude update`, then check with `/claude-sdk-status`.
- **Usage limit.** Run `/claude-sdk-usage` to see when the window reopens.

- **Claude continued inside the SDK.** Pi stops the turn rather than accept an internal continuation or automatically replay uncertain work. This is not malformed JSON. Review completed tools and on-disk changes, then send `continue` when ready; do not blindly repeat side-effecting commands. See [the safety boundary](docs/architecture.md#internal-continuation-safety-boundary).
- **Rejected SDK tool call in a child.** The rejected tool does not execute. Pi records an error and requests a correction. Child tool allowlists can omit the reserved validation helper without preventing correction; the provider does not widen those allowlists. If the child inherits only the provider, without this extension's hooks, Pi may show `Tool pi_claude_sdk_validation_error not found`; replay still supplies the correction. Load the extension in the child for the friendlier diagnostic, not extra tool permissions.
- **Fable missing from the picker.** Run `pi --list-models claude-sdk` and check `/scoped-models`. Saved `enabledModels`, default-model or compaction preferences may still name removed Fable 5.1. Update those preferences yourself to an available ID such as `claude-sdk/claude-5.2-fable`, then reload. The extension does not migrate global settings automatically.
- **Unexpected SDK error.** Check `/claude-sdk-status` and Claude Code availability. Raw SDK errors are deliberately not printed. Pi and auto-resume may already retry this bounded failure; after retries stop, inspect completed work before sending `continue`.

## Further reading

- [Architecture](docs/architecture.md)
- [Cache and error diagnostics](docs/diagnostics.md)
- [Runner API for extension authors](docs/runner-api.md)
- [SDK upgrade steps for maintainers](docs/sdk-upgrade.md)
