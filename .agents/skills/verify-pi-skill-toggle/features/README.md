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
- [Guard and manual invocation boundaries](guard.md): model reads of disabled,
  default-off, enabled, invoked, and newly disabled skills; main `bash` unguarded.
  Driven by `model.py`.
- [Prompt caching and toggle notes](cache.md): steady, toggle mid-session, toggle
  back, toggle twice, instruction off; frozen prompt plus notes. Driven by `model.py`.
- [Subagents follow the parent](subagent.md): a real pi-subagents child reads what
  the parent invoked, is blocked from what it disabled, and keeps 100% reuse.
  Driven by `model.py`.

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
`not executed`. `verify.py` always marks guard **not executed**: it never submits
a model prompt. Do not report guard as verified through menu evidence; report it
from `model.py`'s `report.json` (`toolOutcomes` and checks) instead.

## Model journeys (model.py)

Run from the checkout root; see [Model journeys](../SKILL.md#model-journeys):

```sh
M=.agents/skills/verify-pi-skill-toggle/scripts/model.py
E=$(mktemp -d /tmp/pi-skill-toggle-model-proof-XXXXXX)
"$M" launch --evidence "$E" && "$M" doctor --evidence "$E"
"$M" drive --evidence "$E" --scenario all --model all
"$M" report --strict --evidence "$E"; "$M" cleanup --evidence "$E"
```

Reading the report:

- `commonPrefixChars` approximates what a prefix cache can reuse; 100% reuse
  means the previous request is a strict prefix of this one.
- `unreusedChars` is what must be processed again: the new turn, any note, and
  any invalidated tail.
- `systemPatchMessages` counts transcript system messages after the head. The
  extension should cause none after request 1 (`--strict`).
- `skillsVisible` is the model's view: the prompt's list overridden by the
  latest note (each note restates every difference, so only the latest counts).
- `toolOutcomes` lists each scripted `read`/`bash` call, its target, and whether
  it was allowed, for the guard (main session) and subagent (child) journeys.
- `debug` rows summarise `PI_SKILL_TOGGLE_CACHE_DEBUG` records: epochs
  (`initial` once, then `frozen`), notes, state-load failures, fingerprints.
