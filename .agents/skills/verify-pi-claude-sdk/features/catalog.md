# Register and discover models

A user can load the extension into Pi and find its five subscription models
before sending a prompt.

## Sub-features

- `catalog-load`: explicit CLI extension registration without other extensions.
- `catalog-list`: all five current IDs appear in Pi's available model catalog.

## How to get to it (user POV)

Run Pi with `--extension <repo>/packages/pi-claude-sdk/index.ts` and
`--list-models claude-sdk`. This recipe verifies that CLI entry, not the TUI picker.

## Driving it with verify.py

Preconditions: Launch and Doctor passed; no credentials or model prompts needed.

- **List:** run `"$H" catalog --evidence "$E"`. Actual CLI exits 0 and
  `catalog.stdout` lists provider `claude-sdk` and `claude-5.5-sonnet`,
  `claude-5.5-opus`, `claude-5.1-fable`, `claude-5.5-haiku`, `claude-4.5-haiku`.
- **Proof:** retain `catalog.command.json`, `catalog.stdout`, `catalog.stderr`,
  `catalog.exit`, `catalog-results.json`. Inspect context/output columns too:
  Sonnet/Opus/Haiku 5.5 show 1M/128K; Fable shows 1M/64K; Haiku 4.5 shows
  200K/32K. All models show thinking and images enabled. The helper asserts these
  SDK-specific values; missing IDs or incorrect columns fail.
- **Cleanup:** run `"$H" cleanup --evidence "$E"`; confirm catalog proof survives.

## Gotchas

- `--no-extensions` still permits the explicit `--extension` path.
- Running from the repository without isolation may auto-load unrelated extensions.
- Registration proves neither actual alias resolution nor successful model turns;
  those require the [live journey](live.md).
