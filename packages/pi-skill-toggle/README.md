# Pi Skill Toggle

Controls which user-managed instruction files and skills Pi advertises to the
model.

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
shows whichever files Pi loaded. It includes only user-managed global and
project resources. It discovers project skills used by Pi, Claude Code, and
Codex under `.pi/skills`, `.agents/skills`, `.claude/skills`, and `.codex/skills`.
It checks the working directory and each ancestor through the Git root. When
harness directories contain the same skill name, the first copy wins without a
startup collision warning. Unique skills from later directories are still
loaded. Malformed skills are skipped rather than reported as extension loading
errors. Projects outside a Git worktree are limited to the working directory so
a parent user's skills are not mistaken for project skills.

Project-scoped skills may also live elsewhere when project settings configure
their directory. Package, internal, unrelated extension-provided, and temporary
CLI skills remain outside the toggle's scope.

A disabled skill remains available through `/skill:name`; the extension only
removes it from automatic model discovery. A skill that declares
`disable-model-invocation: true` already requires explicit invocation, so it
appears as a read-only `manual only` row.

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

## Pi versions

Pi 0.86 and newer hand each run a private, mutable copy of the prompt options.
The extension removes hidden resources from that copy and Pi renders the prompt,
so prompt caching and section diffing keep working. If another extension
replaces the whole system prompt, Pi sends that text and toggles do not apply
to it.

Pi 0.85 and older expose only the rendered prompt. There the extension replaces
the exact project-context and skills sections and returns the new text.
`hideResources` in `prompt-filter.ts` holds both strategies; the second half can
be deleted once Pi 0.85 support is dropped.

## Failure behavior

The prompt is touched only when a loaded resource is hidden. If state cannot be
loaded, the prompt remains unchanged and the error is shown once until it
changes or clears. A failed toggle restores the row and is never half-written.
On Pi 0.85 and older, a section that cannot be matched exactly is reported
instead of silently claiming success.

## Maintainer invariants

- Never edit an instruction file or `SKILL.md`.
- Never override source-level `disable-model-invocation`.
- Preserve manual `/skill:name` invocation.
- Contribute deduplicated project skill files, then use Pi's loaded resources.
- Keep global resources before project resources in the menu.
- Identify resources by path, never by display or project name.
- Treat a `temporary` skill as a project skill only when this extension
  contributed its path.
- Never mutate prompt options on Pi 0.85 and older. They are Pi's live objects.
- Return a replacement prompt only on Pi 0.85 and older, and only when a
  resource is hidden.
- Keep project skills model-hidden until the user enables them.
- Preserve unrelated state during updates and cleanup.
