# Pi Auto Resume

Continues a session automatically when a provider's usage limit resets. It is
on by default; `/auto-resume off` turns it off for the current session,
`/auto-resume on` turns it back on, and `/auto-resume` alone toggles it.

## When it waits

A provider publishes the limit's reset time on the `usage-limit` event channel
before its failed turn ends. Currently only `pi-claude-sdk` does this; its
payload is `{ provider: "claude-sdk", resetsAt }`, with `resetsAt` in epoch
milliseconds. When the run settles on that failure and the reset is at most
five hours away, the extension:

1. Omits the failed attempt from model context, so the resumed turn carries on
   as if it never happened. The attempt stays in the transcript.
2. Shows a warning and a one-line widget above the editor with the resume time.
3. Checks the wall clock once a minute and, once the reset has passed and Pi is
   idle, starts the next turn with a marker message. The marker is shown in the
   transcript and hidden from the model.

A resumed turn that hits a new limit with a new reset time waits again. A new
prompt, any newly started agent run (including one started by another extension),
session tree navigation, or `/auto-resume off` cancels the wait. Session replacement,
reload, and shutdown also discard it.

Everything else is left to Pi: a limit with no reset time, a reset more than
five hours away, and connection or capacity errors, which Pi's own retry
settings handle. The extension never probes the provider, and the wait is kept
in memory only, so it ends with the Pi process.

Comparing the wall clock, rather than sleeping for the whole wait, keeps the
resume on time when the machine sleeps; it does not keep the machine awake.

## Print and JSON modes

These modes exit as soon as Pi settles, so the extension never waits there.
Print mode writes `Usage limit resets at <ISO time>` to stderr, and JSON mode
records an `auto-resume` custom entry with `{ resetsAt }`, which appears as an
`entry_appended` event.

## Notice correlation

Notices are consumed at settlement and cleared at each agent/turn start, so a
retry or the next main request cannot reuse a previous request's notice. When a
notice names a provider, it must match the final failed assistant message.
Malformed or out-of-range dates are ignored in every mode.

The event has no request/session ID. A nested or concurrent call to the same
provider can therefore still be ambiguous if its notice arrives during the final
main request. Exact correlation would require a richer provider event contract;
the extension does not infer usage limits from error text.

## Verification

Ask Pi to run the `verify-pi-auto-resume` skill, or open
[the skill instructions](../../.agents/skills/verify-pi-auto-resume/SKILL.md).
Follow that skill's invocation instructions for its
[verification runner](../../.agents/skills/verify-pi-auto-resume/scripts/verify.py).
The harness uses the checkout-pinned Pi runtime and a synthetic offline provider;
it does not require subscription credentials or live provider requests.
