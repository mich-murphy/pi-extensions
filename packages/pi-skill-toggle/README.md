# Pi Skill Toggle

Controls which user-managed instructions and skills Pi advertises to the model,
and guards supported reads of disabled resources. It does not remove files or
provide strict context isolation.

## Command

Run `/skill-toggle` in Pi's interactive terminal. Select a row and press Enter
to toggle `enabled` / `disabled`; Space also toggles when search is empty. Type
to search. Esc clears a nonempty search; with an empty search it closes the
menu. Choices save immediately; closing does not undo them. Project skills start
disabled; instructions and global skills start enabled.

The list groups global instructions, global skills, project/inherited
instructions, then project skills. Rows show their origin and kind;
the selected row's description shows its discovery path and one scope line,
such as `Project skill · repository-wide (all worktrees)`. Global resources,
resources outside Git, and project resources under global skill roots show
`this path only`, matching how the choice is saved. A skill with
`disable-model-invocation: true` is a read-only `manual only` row, not something
the toggle can enable automatically.

### Resources

The menu includes user-managed resources Pi loaded. It also lists tracked
`AGENTS.override.md`, `AGENTS.md` / `AGENTS.MD`, and `CLAUDE.md` / `CLAUDE.MD`
files elsewhere in the current Git worktree. These nested instructions are
labelled by repository-relative path. Pi does not add them to the prompt; their
toggles control supported reads.

Pi's native discovery, configured skill paths, exclusions, and same-name winners
are preserved. The extension supplements project discovery with ancestor
`.pi/skills` and working-directory/ancestor `.claude/skills` and `.codex/skills`,
through the Git root. Pi already discovers working-directory `.pi/skills`,
ancestor `.agents/skills`, and global roots. Supplemental discovery requires
project trust and, outside Git, stays within the working directory.

Supplemental skills never displace native or temporary CLI/SDK skill names.
Among supplemental copies, the first discovered name wins; unique later skills
still load. Malformed supplemental skills are skipped, and missing configured
packages are not installed merely to inspect native winners. Project settings
may configure skills outside conventional roots. Package, internal, unrelated
extension-provided, and temporary CLI/SDK skills are outside the toggle's scope.

## Scope and reads

One policy resolver supplies the menu value, prompt filtering, and read guard:

- **Repository resources:** one choice for a repository-relative path across
  every worktree of the same repository, including linked worktrees elsewhere.
  Repository identity is the canonical common Git directory. There are no
  worktree-specific overrides.
- **Global resources and resources outside Git:** choices use their absolute
  discovery paths, even when global configuration itself is in Git.
- **Instructions:** only the instruction's own path and repository equivalents
  are protected. Disabling `AGENTS.md` does not disable `web/AGENTS.md`.
- **Skills:** protection covers the actual directory containing `SKILL.md` and
  its descendants, including references and scripts, under configured or nested
  roots too. Separately loaded nested skills own their scope and follow their
  own policy and manual invocation, rather than an outer skill's policy;
  independently loaded standalone Markdown skills likewise own only their file.
  Repository-equivalent directories share policy. Matching folder or skill
  names in unrelated roots or repositories do not share policy.

Disabled resources are omitted from subsequent prompt construction. Supported
model tool calls are also refused with a message naming the disabled resource:

- **`read`, in all sessions.** Paths are resolved from the tool's working
  directory, with Pi-style `@` and `~` handling.
- **`bash`, only in subagent sessions.** This is a best-effort check for known
  literal content readers such as `cat`, `head`, `tail`, `sed`, `awk`, `grep`,
  and `rg`, including their input redirects. Simple `for` loops are recognized
  only when a reader takes the exact loop variable, such as `cat "$f"`.
  Supported shell wrappers, literal shell scripts, and substitutions are
  inspected in their command's directory. Literal `cd` targets support `--`,
  `-L`, and `-P`; uncertain directory changes stop relative-path resolution.
  This is not a general shell interpreter or an inline Python/Node/Perl/Ruby
  file-read detector.

A subagent session has a parent session id in its header, as written by
`@gotgenes/pi-subagents`. Pi's `/new` and `/fork` record a parent session file
path instead, so they remain main sessions for this check.

Explicit `/skill:name` invocation lets that loaded skill's files remain readable
for the rest of the current session. This exception is session-local, does not
change saved policy, and is not inherited by subagents. Source-level manual-only
skills still require explicit invocation. User `@file` attachments and `!`
commands are not checked.

### Limitations

This is a prompt and supported-read control, **not a security boundary**:

- Main-session `bash` is unrestricted. `edit`, `write`, `grep`, `find`, and `ls`
  tools are unaffected in every session.
- The shell check skips unsupported or unresolvable reads, including computed
  paths, globs, general variable expansion, expanding heredocs, and non-shell
  interpreter scripts. Git and network access are unrestricted; listing,
  counting, editing, and copying forms are not treated as content readers.
  Search tools and other commands can still expose content.
- Inline interpreter code is not inspected: `python -c`, `node -e`, `perl -e`,
  and `ruby -e` reads, as well as interpreter heredocs, are not detected.
- Loop variables are tracked only when a reader uses them directly. Copying one
  into another variable (`g=$f; cat "$g"`) is not tracked, and a temporary
  assignment to the loop variable (`f=x cmd`) makes that binding unknown for
  the rest of the loop body.
- Paths are compared by on-disk identity as well as lexically. A read through a
  symlink, or through a differently cased name on a case-insensitive file
  system such as default macOS APFS, is blocked when it reaches a protected
  file. On case-sensitive file systems, a distinct `agents.md` beside
  `AGENTS.md` stays readable. Persisted choices for files that are not loaded
  and not present on disk still match only their exact path.
- Shell analysis is approximate: it can miss reads or refuse commands that would
  not actually print a resource. Disabling a resource does not erase existing
  conversation context, earlier tool output, or copies obtained elsewhere.

## State

Choices differing from the default live in `~/.pi/agent/pi-skill-toggle.json`
(or Pi's selected agent directory). Version 7 separates absolute file choices
from repository policy:

```json
{
  "version": 7,
  "files": {
    "/Users/me/.pi/agent/skills/research/SKILL.md": "disabled"
  },
  "repositories": {
    "/work/project/.git": {
      ".agents/skills/deploy/SKILL.md": "enabled",
      "AGENTS.md": "disabled"
    }
  }
}
```

Two spellings of one key that normalize to the same path, such as `/x/.git` and
`/x/.git/`, are reported as a malformed entry rather than silently merged.

Each toggle re-reads state, changes one choice, and atomically replaces the file.
Returning a resource to its default removes its explicit choice. Definitely
missing absolute-file entries are pruned; repository policy is retained even
when a checkout or resource is absent. Unrelated choices are preserved. There is
no lock: simultaneous updates can overwrite one another; the last write wins.

### Upgrading to version 7

Version 7 is a breaking change to toggle behavior and the state format:

- **Choices are repository-wide.** A choice for a repository resource applies in
  every worktree of that repository. Earlier versions kept a separate choice per
  checkout path.
- **Conflicts resolve on migration.** Versions 4, 5, and 6 migrate in memory.
  Recognizable repository paths become shared repository choices. When
  worktrees disagree, the main checkout's choice wins; otherwise the lexically
  first absolute path wins. Paths in pruned or moved worktrees whose Git folder
  no longer exists are outside Git and stay absolute-file choices.
- **The next toggle discards the losing values.** Loading never rewrites the
  file, but the next successful toggle saves version 7 and permanently drops the
  losing per-worktree values. Back up the file first to keep them.
- **Older releases refuse version 7.** An earlier pi-skill-toggle reports the
  file as written by a newer version instead of resetting it. Update the
  extension, or remove the file to reset all toggles.

Name-keyed state from versions 1 to 3 is ignored.

## Compatibility and failures

Pi 0.86+ provides private mutable prompt options; the extension filters those so
Pi's prompt rendering, caching, and section diffing keep working. Pi 0.85 uses
exact rendered-section replacement without mutating live options. An unmatched
legacy section is reported. If another extension replaces the entire system
prompt, its replacement can bypass this filtering.

Invalid JSON, malformed policy, a newer unsupported version, or filesystem
errors are reported rather than silently resetting choices. On a load failure,
the prompt is left unchanged; the read guard treats known loaded resources as
disabled, subject to the manual-invocation exception and the tool limitations
above. This does not guarantee that all instruction or skill content is blocked.
A failed save leaves the previous policy and displayed values in place. Repeated
identical state errors are reported once until the error changes or clears.

## Maintainer invariants

- Never edit resource contents or override source-level manual-only behavior.
- Use the same repository/absolute-path policy for menu, prompt, and reads; never
  identify resources by display name or infer unrelated copies from folder names.
- Keep manual invocation and user attachments/commands working; never broaden
  shell guarding to main sessions or guard `edit`, `write`, `grep`, `find`, or `ls`.
- Preserve native discovery winners and exclusions, global-first menu ordering,
  unrelated saved choices, and project-skills-disabled defaults.
