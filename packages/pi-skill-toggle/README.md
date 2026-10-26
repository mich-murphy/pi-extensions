# Pi Skill Toggle

Controls which user-managed instructions and skills Pi advertises to the model,
and guards supported reads of disabled resources. It does not remove files or
provide strict context isolation.

## Command

Run `/skill-toggle` in Pi's interactive terminal. The main menu has four
categories: global instructions, global skills, project instructions, and project
skills. Enter opens a category. Skill and project-instruction categories show
the number currently On. The main menu explains: **Auto-save: each change is
saved immediately.** There is no separate Save command; closing never rolls
back a saved choice.

Within a category, Enter toggles On / Off. Space also toggles when search is
empty; otherwise it inserts a search character. Type to search names. Escape
clears an active search, then returns to the main menu, then closes. The hint
changes from `Type to search · Enter toggle · Esc back` to
`Enter toggle · Esc clear` while searching. Project skills still start Off;
instructions and global skills start On.

Each resource shows its name, state and muted quoted source text on one line.
Skills quote their actual frontmatter description, not a generated summary.
Instructions quote their first Markdown heading, omitting absent headings and
headings that just repeat the filename. Long names and quotations are shortened
visually; states stay readable. Quotations collapse display whitespace and strip
terminal control sequences without rewriting the source files. No description
is repeated underneath the list.

Project submenus show `all worktrees` once in their heading when all their
resources have repository-wide policy. Resources outside that policy use
`per path`; a category containing both uses `mixed scope`.

Enabled global instructions are read-only **Always on** rows. An existing
explicitly disabled global instruction stays Off: opening the menu does not
re-enable or rewrite it. You can explicitly turn it On, after which it becomes
read-only. Missing global instructions say **Not loaded** rather than claiming
they are included. A skill declaring `disable-model-invocation: true` stays a
read-only **Manual only** row, distinct from a user-disabled skill.

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
for the rest of the current session. This exception does not change saved policy.
Subagents of that session inherit it while the parent is registered in the same
process (see below). Source-level manual-only
skills still require explicit invocation. User `@file` attachments and `!`
commands are not checked.

### Subagents follow the parent

Every session registers itself in a process-wide registry
(`globalThis[Symbol.for("pi-skill-toggle.sessions")]`, keyed by session id),
so a subagent created in the same process finds its parent even though it
loads its own copy of the extension. When the parent is registered, the parent
decides, live at every tool call and run:

- **Reads.** A path is blocked in the subagent exactly when the parent would
  block it: the parent's resources, the current state, and the skills the user
  invoked with `/skill:name` in the parent.
- **Prompt.** A toggle resource the parent knows, by path or, for skills, by
  name, is visible in the subagent when it is enabled or manually invoked in
  the parent. Resources the parent does not know keep the subagent's own state.
  A parent toggle during a subagent run reaches the subagent as an appended
  note, so its cached prompt stays frozen.
- Nested subagents follow the root through their own parent.

When the parent is not registered (another process, or it has shut down), a
subagent uses its own state as before, and manual skills are not inherited. If
the parent's state cannot be loaded, the parent blocks every listed resource.

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
Pi renders the prompt itself. [Prompt caching](#prompt-caching) explains how
toggles avoid section changes after the first request. Pi 0.85 uses
exact rendered-section replacement without mutating live options. An unmatched
legacy section is reported. If another extension replaces the entire system
prompt, its replacement can bypass this filtering.

Invalid JSON, malformed policy, a newer unsupported version, or filesystem
errors are reported rather than silently resetting choices. On a load failure,
the first request's prompt is left unfiltered and later runs keep the prompt and
the model's view without a note; the read guard treats known loaded resources as
disabled, subject to the manual-invocation exception and the tool limitations
above. This does not guarantee that all instruction or skill content is blocked.
A failed save leaves the previous policy and displayed values in place. Repeated
identical state errors are reported once until the error changes or clears.

### Prompt caching

On Pi 0.86 and newer the prompt is frozen after a session's first request, so a
toggle never invalidates the provider's prompt cache. Each run reads the
current branch's transcript (`buildSessionProjection`) and replays its system
messages to learn which toggle resources the model's prompt lists, then picks
an epoch:

- `initial`: the transcript has no system message yet. The current toggles
  shape the prompt Pi writes as the session head.
- `model-change`: since the latest response, the user selected a different
  model from the one that response ran under, so the new model's cache is cold.
  The current toggles are applied to the prompt. Virtual-model routing and
  re-recording an unchanged selection stay `frozen`.
- `frozen`: every other run. Each toggle resource keeps exactly the prompt
  status it already has, so Pi finds no section to patch. Package, CLI, and
  other non-toggle resources pass through untouched.

Freezing deliberately departs from the Pi extension guide's advice to prefer
section changes over rewriting the prompt. Providers that cannot represent
mid-conversation system messages, including `pi-claude-sdk`, which renders
the folded system prompt as its first block, receive a section change as a
full checkpoint that invalidates the cached prefix. Even capable providers
resend the whole section. An appended note costs only its own text.

The model's view is the prompt's set, overridden by the latest
`pi-skill-toggle` note. When the user's choice differs from that view, the run
appends one hidden note after the user's message. Each note is standalone: it
states every difference between the user's choice and the system prompt, so
the latest surviving note is enough even if compaction or context editing
removed earlier ones. Its `details` (`{ version: 1, visible: [...] }`) record
the full visible set, so toggling back to what the model already sees sends
nothing. Text is deterministic and sorted:

```text
The user changed /skill-toggle. This note supersedes earlier /skill-toggle notes and overrides the skills and project instructions listed in the system prompt.
Disabled skills (do not load unless the user invokes /skill:<name>): alpha, beta
Disabled instructions (disregard): /work/AGENTS.md
Enabled skills:
<Pi's formatSkillsForPrompt block for the run's reader tool, trimmed>
Enabled instructions:
<project_instructions path="/work/docs/AGENTS.md">
...content...
</project_instructions>
```

Empty groups are left out. When the user's choice matches the system prompt
again after an earlier note, the note reads only:

```text
The user changed /skill-toggle. This note supersedes earlier /skill-toggle notes.
The system prompt's skills and project instructions apply as listed.
```

Compaction keeps the prompt head; if it summarises a note away, the next run announces the difference again. Resume, fork, and tree navigation
work because the view comes from the branch, not from memory. Reads are
always checked against the current state.

### Cache diagnostics

Set `PI_SKILL_TOGGLE_CACHE_DEBUG=1` to append JSON lines to
`pi-skill-toggle-cache-debug.jsonl` in the agent directory, or set it to a file
path. Unset, empty, or `0` turns it off. Records are never printed, never hold
file contents, and a failed write is ignored:

- `run`: epoch, state load result, desired and prompt-hidden ids, the note's
  changes and length, and fingerprints of the skills and instructions handed
  to Pi, so identical prompts have identical fingerprints.
- `usage`: input, output, cache read and write tokens of each response.
- `discover`: project skill discovery duration and contributed count.

The log grows without bound; delete the file to reset it.

## Maintainer invariants

- Never edit resource contents or override source-level manual-only behavior.
- Use the same repository/absolute-path policy for menu, prompt, and reads; never
  identify resources by display name or infer unrelated copies from folder names.
- Keep manual invocation and user attachments/commands working; never broaden
  shell guarding to main sessions or guard `edit`, `write`, `grep`, `find`, or `ls`.
- Preserve native discovery winners and exclusions, global-first menu ordering,
  unrelated saved choices, and project-skills-disabled defaults.
- Let a registered parent session decide a subagent's reads and toggle
  visibility, evaluated live; fall back to the subagent's own state otherwise.
- Keep registry entries plain versioned objects, validate them on every read,
  and never throw on malformed registry content.
- On Pi 0.86+, change a toggle resource's prompt status only in the `initial`
  or `model-change` epoch; announce every other toggle in an appended note.
- Derive the prompt and the model's view from the current branch's transcript.
- Render skill entries exactly like Pi's `formatSkillsForPrompt`.
- Never write diagnostics to stdout or stderr.
