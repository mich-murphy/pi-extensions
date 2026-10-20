# Changes and persistence

Users change editable values immediately, cannot change source-authored manual
skills, and see their saved choices after reload and a fresh Pi process.

## Sub-features

- `changes-enter`: Enter enables a filtered ordinary project skill.
- `changes-space`: Space disables the selected global skill with empty search.
- `changes-instruction`: a nested instruction can be disabled independently.
- `changes-manual`: Enter and Space cannot change manual-only rows or state.
- `changes-save`: file persistence occurs while the menu is still open.
- `changes-restart`: Escape, reload, and process restart retain choices.

## How to get to it (user POV)

- Open `/skill-toggle`, search an editable resource, and press Enter.
- Clear search, navigate with arrow keys, and press Space.
- Press Escape to clear the search, Escape again to close; run `/reload` or quit
  and start Pi again in the same project.

## Driving it with verify.py

Preconditions:

- Read-only doctor passes; helper starts fresh disposable fixtures and profile.
- Global skill is enabled; project skill is disabled; nested instruction is enabled.

- **Run.** From the checkout root, execute `.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature changes`.
- **Read-only.** The driver selects `verify-manual` and presses Enter and Space.
  `changes-manual-*.txt` show manual-only unchanged; state bytes remain identical.
- **Enter.** Search `verify-project`, press Enter. `changes-project-enter.txt`
  shows enabled; `changes-project-immediate.state.json` records its actual saved
  repository choice before closing the menu.
- **Space.** Clear the query, navigate to `verify-global`, press Space.
  `changes-global-space.txt` shows disabled and
  `changes-global-immediate.state.json` records the absolute global file choice.
- **Instructions.** Search `web/agent/AGENTS.md`, press Enter.
  `changes-instruction-enter.txt` and `changes-instruction-immediate.state.json`
  prove disabled state persisted independently of skills.
- **Escape.** With the instruction query still active, one Escape clears the
  search and keeps the menu open (`changes-escape-clears-search*.txt`); a second
  Escape closes (`changes-escape.txt`).
- **Reload and restart.** Run `/reload`, reopen, quit, and launch a fresh
  process in the main fixture. `changes-after-reload.txt`, `changes-restart.txt`,
  and their state snapshots retain all three editable choices.
- **Proof.** `side-effects.json` confirms instruction/skill contents were not
  edited; `result.json` proves cleanup. Menu-only layout/search and scope journeys
  are not executed in this mode; guard is not executed either.

## Gotchas

- Escape clears an active search first, then closes; closing is not rollback,
  so saving must precede it.
- Read actual state, not a notification or list callback. The driver never seeds
  or changes policy except through the real menu.
- `manual only` is a source-authored restriction, not a third editable value.
- Reload and restart do not prove prompt filtering or read blocking without a
  model turn; those paths remain explicitly unverified here.
