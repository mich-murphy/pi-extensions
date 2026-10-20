# Prompt caching and toggle notes

A toggle during a session must reach the model without invalidating the cached
prompt. The system prompt is frozen after the first request; later toggles are
appended as hidden `pi-skill-toggle` notes after the user's message.

## Sub-features

- `cache-steady`: five prompts, no toggles; requests 2-5 reuse 100% of the
  previous request with no system patch messages.
- `cache-toggle-mid`: before prompt 3, global `research` is disabled and project
  `proj-deploy` enabled. Request 3 carries one note and no system patch.
- `cache-toggle-back`: the same change, reverted before prompt 5. Two notes; the
  second is the short revert note and the model's view matches launch again.
- `cache-toggle-twice`: `research` off before prompt 3, `code-review` off before
  prompt 4. The request 4 note restates both, so it still works if the first
  note is compacted away.
- `cache-instruction-off`: the global `AGENTS.md` is disabled before prompt 3;
  it is in force at request 2 and disregarded at request 3.

## How to get to it (user POV)

- Start a Pi session, send a prompt, then change a skill or instruction in
  `/skill-toggle` (or in another Pi session sharing the state file) and keep
  talking. The next model request should carry the change as a note.

## Driving it with model.py

Preconditions:

- `model.py launch` and `model.py doctor` pass (see [Model journeys](../SKILL.md#model-journeys)).
- No credentials: the offline recorder provider answers every request.

- **Run.** `"$M" drive --evidence "$E" --scenario steady --model all` (or
  `toggle-mid`, `toggle-back`, `toggle-twice`, `instruction-off`, or `all`),
  then `"$M" report --strict --evidence "$E"`.
- **Toggles.** Between prompts the helper atomically rewrites the scratch state
  file, exactly as another Pi session would. `state-before-prompt-N.json` in the
  run directory proves each edit.
- **Two renderings.** `recorder/codex-like` keeps mid-conversation system
  messages in place (like Codex); `recorder/collapse-like` folds them into the
  head (like `pi-claude-sdk`, which renders the folded prompt as block 0).
- **Evidence.** `report.json` rows give, per request: rendered chars, common
  prefix with the previous request, un-reused chars, reuse percent, system patch
  messages, note count and size, roles, and `skillsVisible` (the prompt's list
  overridden by the latest note). With `PI_SKILL_TOGGLE_CACHE_DEBUG=1`, each run
  also writes `cache-debug.jsonl` and the report adds a `debug` row (epochs,
  notes, state-load failures, fingerprints, usage).
- **Expected.** `--strict` passes: 100% reuse after request 1 and no system
  patch in any run. Un-reused chars grow only by the new turn and the note.
- **Compare.** `"$M" compare --evidence "$E" --baseline <earlier report.json>`
  prints reuse, un-reused chars, and patch changes per run.

## Gotchas

- Offline numbers measure **prompt bytes Pi sends**, not provider billing. Real
  cache tokens come only from live mode or assistant `usage` in real sessions.
- Live mode (`--live claude-sdk --confirm-subscription-usage`) spends the user's
  subscription allowance. Follow `verify-pi-claude-sdk` rules: check allowance,
  never log in or read credentials. Run one short scenario only.
- A note is sent only when the user's choice differs from the model's current
  view, so toggling back to what the model already sees sends nothing.
- The parser in `model.py` reads only the latest note; it accepts the current
  disabled-skills prefix and the older `(do not load or use)` one.
