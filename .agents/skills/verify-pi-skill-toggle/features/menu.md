# Menu and navigation

The user can browse four resource categories, identify state and source text
without relying on color, search within a category, and return to the editor.

## Sub-features

- `menu-open`: command opens Context; arguments produce usage feedback.
- `menu-groups`: global instructions, global skills, project instructions and
  project skills, with an auto-save explanation on the main menu only.
- `menu-source`: skill descriptions and instruction headings are quoted inline;
  instruction names remain repository-relative and long quotations truncate.
- `menu-readonly`: enabled global instructions show Always on and cannot toggle.
- `menu-search`: matching, no matches and clearing without state writes.
- `menu-layout`: normal 120×45 and resized 60×28 terminals remain usable.
- `menu-escape`: Escape clears a query, returns to Context, then closes.

## How to get to it

Run `/skill-toggle`, choose a category with arrows and Enter, then type to search.
Enter toggles; Space toggles only when search is empty. Escape clears search
before backing out. No separate Save step is required.

## Driving it with verify.py

From the checkout root, run the read-only doctor, then
`.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature menu`.
The helper owns a disposable profile, repositories and Pi terminal. It submits
only slash commands and key input, never a model prompt.

The journey runs the same checks at 120×45 and after resizing to 60×28:

- `menu-normal.txt` and `menu-narrow.txt` show all four categories, On counts,
  Always on global instructions and the auto-save note.
- `menu-*-global-readonly.txt` shows the global instruction's quoted heading
  after Enter and Space, with no state changes.
- `menu-*-verify-*.txt` and instruction-path captures show resource states and
  quoted source metadata on the same row. Project headings say all worktrees;
  the main-menu auto-save note is not repeated in submenus.
- `menu-*-empty.txt` shows no matches. Escape restores the list.
- `menu-*-escape-clears-search*.txt` proves a query clears without leaving the
  submenu. The other resource in that category returns.
- Each screen has exactly one accurate key hint: Enter open / Esc close at the
  root; Type to search / Enter toggle / Esc back within a category; Enter toggle
  / Esc clear while searching. SettingsList's old Esc to cancel hint is absent.
- `menu-*-escape.txt` shows the editor after backing out and closing. State
  bytes remain unchanged throughout navigation, search, read-only interaction
  and resizing.

Read `actions.json`, current-pane captures and `result.json` together. Require
successful owned-process and scratch cleanup. Changes, scope and model guard
journeys remain not executed in menu-only mode.

## Gotchas

- Slash-command completion may consume Enter; the helper dismisses it first.
- Search is category-local, not across the entire inventory.
- Truncate source text before losing readable On / Off / Manual only states.
- Old scrollback can contain stale menus; current-pane captures are authoritative.
- A No models available warning is expected in the credential-free fixture.
