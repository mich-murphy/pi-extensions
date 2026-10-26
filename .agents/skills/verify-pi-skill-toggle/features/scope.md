# Repository-wide scope

One repository resource has one choice across all its worktrees. A linked
worktree can reset that choice for the main checkout; unrelated repositories
remain independent, while global discovery-path choices apply everywhere.

## Sub-features

- `scope-linked`: linked worktree initially shows main-checkout choices.
- `scope-reset`: toggling back to defaults removes the repository choice.
- `scope-main`: fresh main-checkout process sees the linked reset.
- `scope-other`: same path in a different repository has independent choices.
- `scope-global`: global skill remains disabled in every project.

## How to get to it (user POV)

- Open `/skill-toggle` in a repository, change a project resource, then start Pi
  in a linked worktree and open the same menu.
- Change it back there, return to the main checkout, and reopen.
- Open the menu in an unrelated repository to compare project and global rows.

## Driving it with verify.py

Preconditions:

- Doctor passes; helper owns a main repository, linked worktree, independent
  `other` repository, and isolated shared Pi profile.
- This journey first runs the changes journey through the real menu to enable
  the project skill and disable the global skill and nested instruction.

- **Run.** From the checkout root, execute `.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature scope`.
- **Compare linked.** `scope-linked-verify-*.txt` and the instruction capture
  show the three saved values in their categories in a fresh linked process.
- **Reset linked.** Enter on `verify-project` restores disabled; Enter on
  `web/agent/AGENTS.md` restores enabled. `scope-linked-*-immediate.state.json`
  proves the canonical repository entries disappear, with no worktree override.
  Escape then clears the active search (`scope-linked-escape-clears-search*.txt`)
  before returning to Context and closing; the `other` run does the same.
- **Return main.** `scope-main-verify-*.txt` and the instruction capture show
  defaults there too, while the global skill remains disabled.
- **Independent repository.** `scope-other-project.txt` and the other category
  captures start at project defaults. Enable its `verify-project` with Enter.
  `scope-other-immediate.state.json` records only that repository's relative-path
  choice. `scope-final-project.txt` proves main remains disabled.
- **Proof.** Read `fixture.json` for the actual common Git directory and all
  `*.state.json` snapshots for v7 `files`/`repositories`. Require successful
  `result.json` with changes and scope passed; menu and guard remain not executed
  in this focused mode.

## Gotchas

- Linked worktrees must be real Git worktrees, not copied directories.
- The repository identity is the canonical common Git directory, not its name,
  branch, checkout path, or linked-worktree administration directory.
- A per-worktree override is a defect, even if the first inherited view looks right.
- This journey compares fresh processes; simultaneous conflicting writers and
  instant refresh of an already-open menu are not covered.
