# Guard and manual invocation boundaries

Disabled resources should not be automatically advertised or read through the
supported guarded paths. Explicit user invocation and maintenance paths have
different semantics; this is best-effort control, not strict context isolation.

## Sub-features

- `guard-prompt`: disabled resources are absent from the next model prompt.
- `guard-read`: model `read` of disabled instructions/skill files is refused.
- `guard-shell`: supported literal content readers are checked in subagents.
- `guard-manual`: explicit `/skill:name` allows that skill in the main session.
- `guard-user`: user attachments and shell maintenance are not model read calls.

## How to get to it (user POV)

- Disable a resource in `/skill-toggle`, then request a task that would load it.
- Explicitly invoke a skill with `/skill:name`.
- Delegate a task to a subagent that encounters a disabled resource.
- Attach a file with `@path` or use a user-entered `!` command for maintenance.

## Driving it with verify.py

Preconditions:

- These paths require model-turn/tool-event and subagent fixtures that this safe
  TUI helper deliberately does not provide.
- Never submit those prompts to an actual provider to fill this coverage gap.

- **Safe run.** `.agents/skills/verify-pi-skill-toggle/scripts/verify.py drive --feature all`
  proves the menu preconditions only; `result.json` explicitly marks guard as
  **not executed**. It does not invoke `/skill:name`, attach a file, or execute a
  model tool call.
- **Required future proof.** Use a deterministic offline model/subagent boundary
  fixture reviewed separately. Capture actual prompt/tool actions, visible
  refusal naming the resource, allowed user/manual behavior, and unchanged
  source files. Production provider requests are not an acceptable substitute.
- **Status.** Every sub-feature on this page is mapped but **not executed** by the
  generated verification skill. Component tests or state snapshots do not turn
  these into end-to-end coverage.

## Gotchas

- No-model menu evidence cannot establish prompt filtering or tool blocking.
- The shell check is best-effort; do not promise interpreter analysis, universal
  blocking, or a security sandbox.
- User `!` commands are not model `bash` tool calls. Pi `/new` and `/fork` are not
  proof of subagent behavior.
- A current implementation defect must be reported, not hidden by weakening the
  intended journey or expanding the claimed coverage.
