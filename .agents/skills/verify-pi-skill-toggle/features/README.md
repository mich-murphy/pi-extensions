# pi-skill-toggle verification map

This is the maintained user-facing verification source. Run the read-only doctor
first, then choose a journey. Fixtures and Pi profiles are fresh per invocation;
never drive a shared session or weaken a journey to match a bug.

## Features

- [Menu and navigation](menu.md): `/skill-toggle`, labels, scope help, search,
  invalid arguments, Escape, normal/narrow terminal layouts, no color dependency.
- [Changes and persistence](changes.md): Enter/Space, immutable manual-only rows,
  immediate actual file changes, reload, and process restart.
- [Repository-wide scope](scope.md): one choice across linked worktrees, default
  reset, global discovery-path choices, and unrelated repository isolation.
- [Guard and manual invocation boundaries](guard.md): mapped **not executed**;
  actual model reads and explicit skill invocation are outside this safe driver.

## Baseline and driving conventions

From the checkout root:

```sh
.agents/skills/verify-pi-skill-toggle/scripts/verify.py doctor
.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature all
```

The helper can run from another cwd because it resolves the checkout from its
own location. Python stdlib, Git, Node, tmux, installed dependencies, and the checkout's
pinned Pi devDependency (exact version from the root `package.json`) are required (a global `pi` is never used). See [Launch](../SKILL.md#launch) for exact argv and isolation.

Global `verify-global` starts enabled. Project `verify-project` starts disabled.
`verify-manual` declares source-level manual invocation only and is read-only.
Global/root instructions and tracked `web/agent/AGENTS.md` and `api/CLAUDE.md`
start enabled. Main and linked directories share a Git common directory; `other`
is an independent repository with the same fixture paths.

Type to search using names/relative paths. Use Enter in filtered results. Space
only toggles with empty search; otherwise it inserts a search character. Escape
clears a nonempty search and keeps the menu open; with an empty search it closes.
Closing never undoes saved changes. No ordinary prompts may be submitted.

## Proof and skip reporting

Require timestamped action records, current-pane text and screen images, actual
state-file snapshots, unchanged resource hashes, and successful cleanup. Artifacts
live in printed `/tmp/pi-skill-toggle-evidence-*` directories, outside scratch.
SVGs are monochrome reconstructions of real captured terminal cells, not OS
screenshots. Raw PTY transcripts supplement screen captures.

`result.json` records per-feature execution. `all` runs menu, changes, and scope;
`scope` also runs changes for preconditions. Unselected features stay explicitly
`not executed`. Guard/manual invocation is **always not executed** by this helper:
no provider/model calls or model tool execution is permitted. Do not report that
feature as verified through menu evidence.
