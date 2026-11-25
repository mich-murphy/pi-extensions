# pi-feedback

Lets agents report friction with Pi's tools, extensions, skills and instructions, and records failed tool calls next to those reports. Both go to a local ledger that you read with a small command-line tool.

## Install

Run `pi install git:github.com/mich-murphy/pi-extensions`, or [load only some extensions](../../README.md#install). It has no settings. Recording is on by default.

## Commands

| Command | Effect |
| --- | --- |
| `/feedback` | Toggles recording for this session. |
| `/feedback on` | Turns recording on and makes the `harness_feedback` tool available. |
| `/feedback off` | Turns recording off and hides the tool from the model. |

The command confirms each change with `Harness feedback is on for this session.` or `Harness feedback is off for this session.`, followed by the ledger's path. Any other argument shows `Usage: /feedback [on|off]` and changes nothing.

## What it records

- **Reports.** The model calls `harness_feedback` when a tool, extension, skill or instruction gets in its way, even after it found a workaround. A report names the kind of problem, the component, a one-line summary, what was expected, what happened, an optional workaround and whether it blocked or slowed the task. A session files at most 5 reports, and a repeat of one already filed in the session is ignored. Each report also appears in the session as `Harness feedback filed`, which the model does not see.
- **Signals.** Every failed tool call, with its error text.

Each record carries the session ID, the model and Pi's version. Its owner is the extension in this repository that registered the tool, or the extension a report names. Anything else, including Pi's built-in tools, is `unattributed`.

## Ledger

Records are appended to `~/.pi/agent/harness-feedback/ledger.jsonl` (or under `PI_CODING_AGENT_DIR`). The directory is readable only by you. Common token formats and values assigned to key, token, secret or password names are replaced with `<secret>`, and each text field is cut to 2,000 characters. Nothing leaves the machine.

## Queue

Read the ledger with the `pi-feedback` script:

```sh
node --experimental-strip-types packages/pi-feedback/cli.ts queue
```

| Command | Effect |
| --- | --- |
| `queue [--all] [--json] [ledger.jsonl ...]` | Lists open groups, ready ones first. `--all` includes resolved groups. Pass several ledgers, such as copies from other machines, to read them together; a record seen in more than one counts once. |
| `resolve <group> <commit> <architecture\|types\|lint\|test\|docs>` | Marks a group fixed by a commit, at the layer the fix changed. |
| `reopen <group> <reason>` | Reopens a resolved group. |

Records with the same owner and fingerprint form a group. A fingerprint is the tool and its error text with paths, URLs, IDs and numbers removed, or for a report, its component and kind. A group is ready when it is open, owned by an extension in this repository and seen in at least two sessions. Ready groups rank by sessions × records, doubled when a report says the problem blocked work. A new record in a resolved group reopens it.
