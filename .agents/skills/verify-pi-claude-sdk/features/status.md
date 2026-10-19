# Inspect versions and routing

A user runs `/claude-sdk-status` to compare installed SDK/bundled/PATH Claude
versions and see advertised-to-canonical model routing without sending a prompt.

## Sub-features

- `status-discover`: Pi exposes the slash command to its client.
- `status-notify`: the real command emits version and model-mapping notification.

## How to get to it (user POV)

Type `/claude-sdk-status` in Pi, or send that slash command as a prompt from a Pi
RPC client. The helper verifies the supported RPC notification entry point.

## Driving it with verify.py

Preconditions: isolated Launch, Doctor, Catalog; `claude --version` works.

- **Discover and invoke:** run `"$H" commands --evidence "$E"`. Helper checks
  selected provider and no session file via `get_state`, discovers the command
  via `get_commands`, then sends `/claude-sdk-status` via `prompt`.
- **Observe:** `commands.jsonl` contains sent action, successful response and
  `extension_ui_request` method `notify` with `Agent SDK:`, `Bundled Claude Code:`,
  `Installed Claude Code:` and all five model IDs. `status` must be `passed`.
- **Proof:** preserve `commands.command.json`, `commands.jsonl`, stderr/exit and
  results. This action also drives [usage](usage.md); report each result separately.

## Gotchas

- Print/JSON mode has no UI; these handlers return immediately there. Exit 0
  without a notification is not success.
- RPC supports notifications with `ctx.hasUI=true`; no terminal rendering is proved.
- A newer PATH Claude can generate a warning; it does not prove the bundled SDK
  is stale. Fresh sessions have no last-observed model until actual live turns.
