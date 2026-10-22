# Subagents follow the parent

A subagent's skills and instructions follow its parent session: a skill the
parent enabled or invoked is usable in the child, and what the parent disables
is blocked there too. Following the parent must not cost prompt caching.

## Sub-features

- `subagent-manual`: the child can read a skill the parent invoked with
  `/skill:name`, even though it is a default-off project skill.
- `subagent-blocked`: the child is blocked from the parent's disabled and
  default-off skills.
- `subagent-shell`: child `bash` that prints a disabled file is refused.
- `subagent-cache`: the child's own requests reuse 100% after its first request,
  with no system patches; the parent's requests are unchanged.

## How to get to it (user POV)

- In a session with `@gotgenes/pi-subagents`, invoke `/skill:name`, then ask
  for a task the model delegates with the `subagent` tool.

## Driving it with model.py

Preconditions:

- `doctor` reports `pi-subagents=found`. The default entry is
  `~/.pi/agent/npm/node_modules/@gotgenes/pi-subagents/src/index.ts`; set
  `PI_SKILL_TOGGLE_SUBAGENTS_EXTENSION` for another. Without it, `--scenario all`
  skips this journey and `--scenario subagent` exits 2 (blocked).
- Children build their own resource loader from settings, not CLI `-e`, so
  `launch` lists the toggle, recorder, and pi-subagents extensions in the
  scratch `settings.json`. The parent ignores it (`--no-extensions`).

- **Run.** `"$M" drive --evidence "$E" --scenario subagent --model all`, then
  `"$M" report --strict --evidence "$E"`.
- **Journey.** Prompt 1 is `/skill:proj-review ...`. Prompt 2 is a
  `SPAWN-CHILD` line followed by the child's task (`READ-FILES:` of
  `proj-review`, `legacy-notes`, `proj-deploy`, then `RUN-BASH: cat` of
  `legacy-notes`); the recorder makes the parent call the real `subagent` tool
  and the child run those calls. Prompt 3 closes.
- **Expected.** Child `toolOutcomes`: allowed, blocked, blocked, blocked (the
  last refusal reads `This command reads skill "legacy-notes", which the user
  disabled in /skill-toggle on purpose...`; every refusal must say
  `do not retry`). Parent: 4 requests, 100% reuse. Child: at least
  2 requests, 100% reuse after its first. Requests are split by the `sessionId`
  the recorder logs; the first request is the parent's.
- **Evidence.** `report.json` holds `childRequestRows`, `summary.child` (reuse,
  rendered and un-reused chars, skills the child can see), and `toolOutcomes`.

### A/B against another build

Set `PI_SKILL_TOGGLE_EXTENSION` to another build's `index.ts` for `launch` and
`drive` to measure what following the parent costs:

```sh
B=/tmp/skill-toggle-ab-main; mkdir -p "$B"
git archive origin/main packages/pi-skill-toggle | tar -x -C "$B"
ln -s "$PWD/node_modules" "$B/node_modules"
export PI_SKILL_TOGGLE_EXTENSION="$B/packages/pi-skill-toggle/index.ts"
```

A build without parent-follow is expected to fail only the `proj-review`
check. Compare `summary.child` between the two reports.

## Gotchas

- Following the parent works only in-process (pi-subagents runs children in the
  parent's process). A child in another process uses its own state.
- pi-subagents replaces the child's system prompt, so the child's prompt
  contents are not compared with the parent's; reads and caching are.
- Live mode skips this journey: scripted tool calls never go to a real model.
