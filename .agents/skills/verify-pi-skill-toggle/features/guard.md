# Guard and manual invocation boundaries

Disabled resources are not advertised to the model and model `read` calls of
their files are refused. Explicit user invocation keeps a skill usable. This is
best-effort control, not strict context isolation.

## Sub-features

- `guard-prompt`: disabled resources are absent from the first model prompt and
  announced by a note after a mid-session toggle (see [caching](cache.md)).
- `guard-read`: model `read` of a disabled skill or a default-off project skill
  is refused with a message naming it; an enabled skill is readable.
- `guard-live`: a toggle mid-session blocks the next read at once.
- `guard-manual`: after `/skill:name`, that skill's files stay readable in the
  main session.
- `guard-main-bash`: main-session `bash` is deliberately **not** guarded.
- `guard-shell`: subagent `bash` that prints a disabled file is refused (see
  [subagents](subagent.md)).
- `guard-user`: user `@file` attachments and `!` commands are never checked.

## How to get to it (user POV)

- Disable a resource in `/skill-toggle`, then ask for a task that would load it.
- Explicitly invoke a skill with `/skill:name`.
- Delegate a task to a subagent that touches a disabled resource.

## Driving it with model.py

Preconditions:

- `model.py launch` and `doctor` pass. Launch state: `legacy-notes` disabled,
  project skills `proj-deploy` and `proj-review` default off, `research` on.

- **Run.** `"$M" drive --evidence "$E" --scenario guard --model all`, then
  `"$M" report --strict --evidence "$E"`.
- **Journey.** The recorder scripts real tool calls from prompt markers
  (`READ-FILES: a|b`, `RUN-BASH: cmd`); Pi executes them through the real
  extension `tool_call` hook:
  1. read `legacy-notes`, `proj-deploy`, `research`;
  2. `/skill:proj-review ...`;
  3. read `proj-review`;
  4. `bash cat` of `legacy-notes`;
  5. after the state file disables `research`, read `research` again.
- **Expected.** `toolOutcomes` in `report.json`, in order: blocked, blocked,
  allowed, allowed, allowed (main `bash` is unguarded), blocked. Each refusal
  text names the skill, e.g. `The user disabled skill "legacy-notes" in
  /skill-toggle on purpose. Continue without it, do not retry it...`; the report
  fails a refusal without `do not retry`. Nine requests (one follow-up per tool
  turn), and `--strict` still sees no system patch.

## Gotchas

- The model is a scripted recorder, not a real provider. Never fill this
  coverage with prompts to a production model.
- `@file` attachments and user `!` commands are not driven: they never reach the
  guard by design, and RPC prompts cannot attach files the way the TUI does.
- The shell check is best-effort; do not promise interpreter analysis,
  universal blocking, or a sandbox.
- Pi `/new` and `/fork` are not subagents; only `@gotgenes/pi-subagents`
  children (parent session id in the header) get the shell guard.
- A current implementation defect must be reported, not hidden by weakening the
  journey.
