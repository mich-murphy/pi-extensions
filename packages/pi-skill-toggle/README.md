# pi-skill-toggle

Switch skills and instruction files on or off without deleting them.

## Install

Install the repository with `pi install git:github.com/mich-murphy/pi-extensions`. To [load only some extensions](../../README.md#install), follow the root README.

## Usage

Run `/skill-toggle` in Pi's interactive terminal UI. Pick a category, then toggle a skill or instruction file. Each change saves immediately; there is no save step, and closing the menu keeps your choices.

| Key   | Action                                                                 |
| ----- | ---------------------------------------------------------------------- |
| Enter | Open a category. In a list, toggle the selected row.                   |
| Space | Toggle the selected row while the search box is empty.                 |
| Type  | Search the list by name.                                               |
| Esc   | Clear the search. With no search, go back. In the main menu, close it. |

Pi's configured keybindings for select, confirm and cancel apply.

### What you can toggle

| Category                 | Default | Notes                                                                                                                                                                                          |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global instructions      | On      | Enabled files show **Always on** and cannot be toggled. A file you disabled earlier stays Off until you turn it On. The category reads **Not loaded** when Pi loaded none.                     |
| Global skills            | On      | Skills in the agent directory and `~/.agents/skills`.                                                                                                                                          |
| Project instructions     | On      | `AGENTS.md` and `CLAUDE.md` files Pi loaded from the working directory or its parents.                                                                                                         |
| Project skills           | Off     | Enable the ones you want. Includes `.pi/skills`, `.agents/skills`, `.claude/skills` and `.codex/skills` up to the Git root.                                                                    |
| Manual only              | Off     | Skills with `disable-model-invocation: true` show **Manual only** and cannot be toggled.                                                                                                       |
| Nested instruction files | On      | Tracked `AGENTS.md`, `AGENTS.override.md` and `CLAUDE.md` files elsewhere in the worktree, labelled by relative path. Pi does not add them to the prompt, so their toggle controls reads only. |

Package, CLI and other extensions' skills are outside the menu.

### Which choices are shared

A choice for a file inside a Git repository applies to every worktree of that repository, because it is stored against the repository and the file's relative path. Global files and files outside Git are stored by absolute path. Project submenu titles say `all worktrees`, `per path` or `mixed scope`.

## How it behaves

A disabled resource is left out of the system prompt. The extension also refuses tool calls that read it:

| Tool                                  | Checked                                            |
| ------------------------------------- | -------------------------------------------------- |
| `read`                                | In all sessions.                                   |
| `bash`                                | Only in subagent sessions, as a best-effort check. |
| `edit`, `write`, `grep`, `find`, `ls` | Not checked.                                       |

Blocked calls return a message naming the disabled resource. Running `/skill:name` keeps that skill's files readable for the rest of the session. Your `@file` attachments and `!` commands are not checked.

Subagents follow their parent session. When the parent runs in the same process, it decides which resources the subagent sees and which reads are blocked, live at every call. Otherwise the subagent uses the saved state.

After a session's first request, toggles reach the model as a short appended note instead of a prompt rewrite, so the provider's prompt cache stays valid. See [the design page](docs/design.md).

## Limitations

This is a prompt and read control, **not a security boundary**. A model can still reach a disabled file through paths the extension does not check. The main gaps:

- Main-session `bash` is unrestricted, and `edit`, `write`, `grep`, `find` and `ls` are never checked.
- The subagent `bash` check inspects known content readers such as `cat`, `head`, `sed` and `rg`. It misses computed paths, globs, inline interpreter code (`python -c`, `node -e`), `eval`, `xargs`, `find -exec` and variable copies.
- Git, network access and other commands can expose content.
- Disabling a resource does not erase earlier conversation context or copies held elsewhere.

`test/shell-reads.test.ts` pins the exact forms the shell check does not detect.

## Configuration

| Setting                            | Default                              | Effect                                                                                                                                  |
| ---------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `<agent dir>/pi-skill-toggle.json` | Pi's agent directory (`~/.pi/agent`) | Stores your choices. The menu manages it; you do not need to edit it. Only choices that differ from the default are saved.              |
| `PI_SKILL_TOGGLE_CACHE_DEBUG`      | Unset (off)                          | `1` appends JSON lines to `<agent dir>/pi-skill-toggle-cache-debug.jsonl`. Another value is used as the file path. Empty or `0` is off. |

The debug log records epochs, token usage and discovery timing, never file contents. It grows without bound; delete it to reset.

## Troubleshooting

- **The extension reports a state error.** The file is not valid JSON, has a malformed entry, or cannot be read or written. Fix the file, or delete it to reset all toggles. The extension never resets it for you.
- **The file was written by a newer version.** An older pi-skill-toggle refuses state versions it does not know. Update the extension, or delete the file.
- **State fails to load during a session.** The first prompt is left unfiltered, later runs keep the prompt as it is, and reads of every known resource are refused. Fix the file to recover.
- **A save fails.** Your previous choices stay in place.

## Further reading

[Design](docs/design.md) explains scope, prompt freezing, subagents and the state file.
