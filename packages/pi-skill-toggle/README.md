# Pi Skill Toggle

Controls which user-managed instruction files and skills Pi advertises to the
model, and stops the model from reading the ones that are disabled.

## Command

Run `/skill-toggle` to open one settings list. Project skills start disabled and
must be enabled from this list before Pi advertises them to the model. Changes
apply immediately and persist across projects and sessions.

Resources are ordered by hierarchy:

1. Global instructions
2. Global skills
3. Project and inherited instructions
4. Project skills

Each row is labelled `[global]` or `[project]`. Origin affects ordering and
explanation only. Every editable instruction uses `enabled` or `disabled`, and
every editable skill uses the same values.

Pi may load `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md`. The extension
shows whichever files Pi loaded, plus every such file tracked in the current Git
worktree that Pi did not load, such as `web/agent/AGENTS.md`. Those nested rows
are labelled with their path from the worktree root. Pi never puts them in the
prompt, so toggling one only decides whether the model may read it. The menu
includes only user-managed global and project resources. Pi already discovers the working directory's `.pi/skills`,
ancestor `.agents/skills`, configured skill paths, and global skill roots. The
extension leaves those native paths and winners alone, including explicit Pi
exclusions, and supplements them with ancestor `.pi/skills`, `.claude/skills`,
and `.codex/skills` through the Git root. A supplemental skill never displaces a
same-named native winner. Names already loaded through CLI or SDK additional
skill paths are reserved too, without making those temporary skills toggle rows.
When supplemental harness directories contain the same skill name, the first
copy wins without a startup collision warning. Unique
skills from later directories are still loaded. Malformed skills are skipped
rather than reported as extension loading errors. Projects outside a Git
worktree are limited to the working directory so a parent user's skills are not
mistaken for project skills. Missing configured packages are never installed
merely to inspect native winners.

Project-scoped skills may also live elsewhere when project settings configure
their directory. Package, internal, unrelated extension-provided, and temporary
CLI skills remain outside the toggle's scope.

A skill that declares `disable-model-invocation: true` already requires
explicit invocation, so it appears as a read-only `manual only` row.

## Blocking reads

Removing a resource from the prompt does not stop a model from finding the file
and reading it. The extension also refuses tool calls that would read a
disabled resource:

- **`read`, in every session.** The refusal names the resource and says it is
  disabled in `/skill-toggle`.
- **`bash`, in subagent sessions only.** A command is refused when it prints
  the content of a disabled resource: a literal file argument of a reader such
  as `cat`, `head`, `tail`, `sed -n`, `awk`, `nl`, `grep`, or `rg`; the list of a
  `for` loop whose body runs such a reader; an input redirect; or a path in an
  inline Python, Node, Perl, or Ruby script that calls a file-reading API. The
  check follows `cd`, subshells, `bash -c`, command substitutions, and wrappers
  such as `env` and `timeout`. The refusal names the disabled files, so the
  subagent can run the command again without them.

The `bash` check errs towards allowing commands. It never refuses listing
(`find`, `ls`, `rg --files`, `grep -l`), counting (`wc`, `grep -c`), editing
(`sed -i`, `perl -pi`, redirects), copying, or Git commands, and it skips
anything it cannot resolve without running the shell, such as variables, globs,
and computed paths. Main sessions keep unrestricted `bash`, so maintaining
instructions and skills by hand keeps working. `edit`, `write`, `grep`, `find`,
and `ls` are never checked.

A session is a subagent session when its header records a parent session id,
which is what `@gotgenes/pi-subagents` writes. Pi's own `/new` and `/fork`
record the parent's session file path instead, so those stay main sessions.

Paths match by location, not content:

- A disabled skill blocks its whole folder, including `references/` and
  scripts, under any `.agents/skills`, `.claude/skills`, `.codex/skills`,
  `.pi/skills`, or agent-directory `skills` root. The skill is matched by folder
  name, so a copy in another worktree is blocked too. A skill enabled anywhere
  keeps that name readable.
- A disabled instruction blocks its own path and the same path from the
  worktree root in every worktree of the same repository, including linked
  worktrees outside the checkout. A nested `AGENTS.md` at a different path stays
  readable unless it is disabled itself.

A skill the user invokes with `/skill:name` stays readable for the rest of that
session, so its references and scripts can be loaded; subagents do not inherit
this. `@file` attachments and `!` commands come from the user and are never
checked.

## State

Only choices that differ from the default are stored: disabled global resources
and enabled project skills. They live in `~/.pi/agent/pi-skill-toggle.json`, or
the agent directory selected by Pi's configuration, keyed by absolute discovery
path so projects and same-named skills never collide:

```json
{
  "version": 6,
  "overrides": {
    "/Users/me/.pi/agent/skills/research/SKILL.md": "disabled",
    "/work/project/.agents/skills/deploy/SKILL.md": "enabled"
  }
}
```

Loading only reads the file. A toggle re-reads the file, changes one entry,
drops entries whose path no longer exists, and replaces the file atomically, so
toggles made in other Pi sessions are kept and a reader never sees a partial
file. There is no lock: if two sessions toggle in the same instant, the last
write wins.

Version 4 and 5 files are read as they are and rewritten as version 6 by the
next toggle. Older, name-keyed state is ignored.

An override applies to every worktree of its repository. A resource without its
own override takes the override of the same path from the worktree root in
another worktree, preferring the main checkout's. Toggling a row in a linked
worktree stores an explicit override for that worktree, even when the value
matches the default, so it is not replaced by the inherited one.

## Pi versions

Pi 0.86 and newer hand each run a private, mutable copy of the prompt options.
The extension removes hidden resources from that copy and Pi renders the prompt,
so prompt caching and section diffing keep working. If another extension
replaces the whole system prompt, Pi sends that text and toggles do not apply
to it.

Pi 0.85 exposes only the rendered prompt. There the extension replaces the exact
project-context and skills sections and returns the new text. Pi has discovered
`.agents/skills` natively since 0.54, so the supplemental discovery rules above
also avoid duplicate native paths on the supported 0.85 release.
`hideResources` in `prompt-filter.ts` holds both prompt strategies; its legacy
half can be deleted once Pi 0.85 support is dropped.

## Failure behavior

The prompt is touched only when a loaded resource is hidden. If state cannot be
loaded, the prompt remains unchanged, every instruction and skill is treated as
disabled for reads, and the error is shown once until it changes or clears. A failed toggle restores the row and is never half-written.
On Pi 0.85 and older, a section that cannot be matched exactly is reported
instead of silently claiming success.

## Maintainer invariants

- Never edit an instruction file or `SKILL.md`.
- Never override source-level `disable-model-invocation`.
- Preserve manual `/skill:name` invocation, `@file`, and `!` commands.
- Check `bash` only in subagent sessions, and refuse a command only when its
  literal text shows it prints a disabled resource.
- Never check `edit`, `write`, `grep`, `find`, or `ls`.
- Treat every resource as disabled for reads when state cannot be loaded.
- Reserve every native skill name and contribute only deduplicated supplemental project files.
- Keep global resources before project resources in the menu.
- Identify resources by path, never by display or project name.
- Treat a `temporary` skill as a project skill only when this extension
  contributed its path.
- Never mutate prompt options on Pi 0.85. They are Pi's live objects.
- Return a replacement prompt only on Pi 0.85, and only when a
  resource is hidden.
- Keep project skills model-hidden until the user enables them.
- Preserve unrelated state during updates and cleanup.
