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

Each record carries the session ID, the model and Pi's version.

## Owner

Code decides which extension owns each record:

- the extension in this repository that registered the failing tool, from Pi's `sourceInfo`;
- for a report, the extension it names first, the extension that registered the tool it names, or the extension that registered the slash command it names. A command counts only when the component starts with `/`, and only its first word is matched, so `/claude usage` belongs to pi-claude while a bare `retry` or `skills` stays `unattributed`, because Pi has a retry setting and skill loading of its own;
- pi-claude, when the error names a Claude SDK scratch directory (`/tmp/claude-<uid>/…`) or a Claude project directory name;
- otherwise `unattributed`, including Pi's built-in tools.

A failure of a Pi built-in tool whose error names Pi's sessions directory or a Pi session directory name is marked as Pi path evidence. It stays `unattributed`. When the failure is recorded, code also checks on disk whether every Pi path the error names exists, and stores the answer as `pathExisted`.

A report that code leaves `unattributed` can still be moved by the classifier (see below). Signals never are.

## Calls in the same batch

Pi runs the tool calls of one assistant message at the same time. When a call fails because a path is missing, and another call in the same message that can write names that path or its directory, the failure is marked `parallel-batch`: the agent ordered its calls badly. Such records do not count towards a group.

## Codemode

`harness_feedback` declares an output schema, so a codemode script that calls it gets `{ status, group, owner }` instead of text. `status` is `recorded`, `duplicate`, `limit`, `off` or `failed`, and `group` and `owner` are set when it is `recorded`. A call that fails still resolves to this value.

Calls a script makes are checked the same way as calls in one message: a failed call's batch is the script's other calls that were running at the same time. When a call inside a script fails, that call is recorded once. The script's own failure is not recorded again when its error repeats the failed call's error text, for example when the script lets the rejection through or rethrows it. A script failure with a different error is recorded as well. A failed `harness_feedback` call is not recorded, so it does not stop the script's own failure from being recorded.

## Pi core

Pi core problems are recorded but never queued for a fix here. The queue shows a group as `pi-core` only when all of these hold, and `unattributed` otherwise:

- every record is a Pi built-in tool failure that names a Pi path, and every Pi path it names existed when it was recorded;
- no record was marked `parallel-batch`;
- records come from at least two sessions;
- for every fingerprint in the group, a stored classifier verdict says the harness created the path (≥ 0.7) and no outside service failed (< 0.3).

A verdict that an outside service failed (≥ 0.9) also stops its records from counting towards a group.

## Ledger

Records are appended to `~/.pi/agent/harness-feedback/ledger.jsonl` (or under `PI_CODING_AGENT_DIR`). The directory is readable only by you. Secrets are replaced with `<secret>` whatever their length: common token formats (OpenAI, Anthropic, GitHub, GitLab, Slack, AWS, Google, npm, Stripe, Hugging Face, JWTs, private keys and Slack webhook URLs), the password in a URL such as `postgres://user:pass@host`, the credential after `Authorization:` or `Bearer`, `Cookie:` and `Set-Cookie:` values, the password in `curl -u user:pass`, and values given to names containing key, secret, password, pwd, token, credential, auth, session ID or cookie. A value counts when it follows `=`, `:=`, a quoted key with `:`, `--name` or `--name=`, or an unquoted `name:` that ends its line. The user name, host, label and scheme are kept. Placeholders such as `${API_KEY}`, `<your-key>`, `$TOKEN`, `***` and `process.env.X` are kept, and so are names such as `max_tokens`, `api_key_file` and `secret_name`. A password in plain prose, such as `the password is hunter2`, is not found. Each text field is cut to 2,000 characters. Only the classifier calls below leave the machine.

## Classification

When Pi has a TypeSafe key, each new record is classified in the background with TypeSafe's Jev model, pinned to `jev-1.14.0`. Without a key nothing is sent and records stay unclassified. Records from batch-ordered calls are not sent. An `unattributed` record is sent for a verdict only when it names a Pi path that existed; otherwise it is sent only if it is a report, and only for the owner question below.

Each call gives up after 30 seconds. A missing key, a failed call or a timeout only leaves a record unclassified; recording and the tool's result never wait for the classifier.

- **Verdict.** Once per fingerprint, Jev is asked whether the error involves a path the harness created and whether an outside service caused it. Whether the path existed is checked by code, not asked. It sees the tool name, the error text (at most 600 characters) and the call's arguments (redacted, at most 400 characters). For a report it sees the component, the kind and what happened.
- **Owner.** Once per fingerprint, for a report that code leaves `unattributed`, Jev is asked which package owns the failing component: one of this repository's extensions, Pi itself or another extension. It sees the kind, component, summary, what was expected and what happened, with your home directory written as `~`. When ledgers from several machines hold different answers for a fingerprint, the one with the highest probability counts. The queue moves the report's group to the named extension only when that answer is one of this repository's extensions with a probability of 0.9 or more. An answer of Pi itself or another extension changes nothing, so Pi core is still decided only by the rules above. Reports whose text contains `mcp__` are not asked about and stay `unattributed`. This includes reports that quote pi-claude's own `mcp__pi__…` tool names. A resolve or reopen that names the report's original `unattributed` group ID still applies to the moved group.
- **Same cause.** Once per pair, a new fingerprint is compared with up to 12 open groups that have the same owner. Groups whose answer is 0.7 or more merge, under the earliest fingerprint. A resolve or reopen that names a merged group's old ID still applies.

Answers are stored in the ledger as `verdict`, `owner` and `same_cause` events, so no question is asked twice, and ledgers from several machines merge the same way. `/feedback` shows how many classifier calls failed. The questions and thresholds are in `jev.ts`.

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

Records with the same owner and fingerprint form a group. A fingerprint is the tool and its error text with paths, URLs, IDs and numbers removed, or for a report, its component and kind. A group is ready when it is open, owned by an extension in this repository and has counted records from at least two sessions. Ready groups rank by sessions × records, doubled when a report says the problem blocked work. A new record in a resolved group reopens it.
