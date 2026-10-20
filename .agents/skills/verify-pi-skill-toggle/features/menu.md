# Menu and navigation

The user can open a comprehensible instruction/skill list, identify scope and
current values without color, find a resource, and return to the editor.

## Sub-features

- `menu-open`: command opens the list; arguments produce usage feedback.
- `menu-labels`: instruction/skill, global/project, repository-relative paths,
  repository-wide help, enabled/disabled/manual-only values, and one selected-row
  scope line such as `Project skill · repository-wide (all worktrees)`.
- `menu-search`: matching, no matches, and clearing without state writes.
- `menu-layout`: normal 120×45 and narrow 60×28 terminals remain usable.
- `menu-escape-search`: Escape with an active search clears it; menu stays open.
- `menu-close`: Escape with an empty search returns to editor without changing policy.

## How to get to it (user POV)

- Type `/skill-toggle` in Pi's main editor and submit.
- Type `/skill-toggle unexpected` to inspect invalid-argument feedback.
- Within the menu, type to search, clear the query with Ctrl+U or Escape, then
  press Escape again with an empty query to close.

## Driving it with verify.py

Preconditions:

- Read-only doctor passes; disposable baseline fixtures are created by the helper.
- No model credentials or prompt submission is needed.

- **Run.** From the checkout root, execute `.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature menu`.
- **Open and identify.** The driver submits both command forms. `menu-usage.txt`
  shows usage feedback; `menu-normal.txt` shows the actual list and semantic labels.
- **Find.** It searches `verify-project`, searches `no-such-fixture-zzzz`, then
  clears. `menu-search-match.txt`, `menu-search-empty.txt`, and
  `menu-search-clear.txt` prove matching, empty, and restored states.
- **Scope line.** `menu-normal.txt` (global instruction selected),
  `menu-search-match.txt`, `menu-search-instruction.txt`,
  `menu-search-global-skill.txt`, and `menu-search-manual.txt` each show exactly
  the expected single scope line, e.g. `Global skill · this path only` or
  `Project skill · repository-wide (all worktrees) · Manual only (read-only)`.
  The menu shows exactly one key hint, `Enter toggle · Esc clear search, then close
  · type to search · Space toggle (empty search)`, in `menu-normal.txt`,
  `menu-search-match.txt`, and `menu-search-empty.txt`; `Esc to cancel` never
  appears.
- **Resize.** It resizes the owned terminal to 60×28, searches the nested
  instruction and manual skill. `menu-narrow*.txt` and corresponding SVGs show
  layout, repository-relative paths, and selected read-only explanation.
- **Escape clears search.** With `verify-manual` searched in the narrow terminal,
  `menu-narrow-escape-clears-search-before.txt` shows the active query and only
  that row; after one Escape `menu-narrow-escape-clears-search.txt` still shows
  the menu with an empty query and every row. State bytes are unchanged.
- **Close.** A second Escape with the empty query closes: `menu-escape.txt` and
  `menu-narrow-escape.txt` show the editor again. No toggle-state file is written
  by navigation, search, or Escape.
- **Proof.** Pair the screen artifacts with `actions.json` and successful
  `result.json`. `changes`, `scope`, and `guard` are not executed in this mode.

## Gotchas

- Slash-command completion may consume Enter; the helper dismisses it first.
- Space in a nonempty search is a character, not a toggle.
- At narrow width, long value text may truncate; select the row to inspect its
  wrapped description. A missing readable manual-only explanation is a failure.
- Current-pane captures are authoritative; old scrollback can contain stale menus.
- A `No models available` startup warning is expected in this credential-free run.
