# pi-terminology verification map

- **commands** (`verify-tui.py`): `/terminology` browser (51 concepts, navigation,
  aliases, related, source), `/terminology-status`, `-auth-refresh` (missing auth),
  `-hide`/`-restore` persistence across restart, corrupt-state safety, 60x28 narrow
  pass over all new concepts, completion discovery of `/terminology-`.
- **preview** (`verify-preview-tui.py`): `/terminology-preview on N|off|status`,
  confirmation text and cost at 180x50 and 60x28, cancel, invalid budgets,
  finite allowance, exhaustion, restart-off, artifact mutation fail-closed,
  offline fake classifier journey with no primary context change.

## Evidence contract

Require `result.json` = passed, `actions.json`, captures, counters, cleanup.
All real provider/fetch counters must be 0; `native` is false (fake classify only).
No paid calls, real keys, or global config. Only slash commands and allowlisted
synthetic prompts are typed. Narrow-terminal warnings: a failure invalidates both viewports.
