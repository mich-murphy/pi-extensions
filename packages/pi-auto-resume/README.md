# Pi Auto Resume

Continues a session automatically when a provider's usage limit resets, or
after a transient provider or network failure outlasts Pi's own retries. It is
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

Everything else is left to the user: a limit with no reset time or a reset more
than five hours away. The extension never probes the provider, and the wait is
kept in memory only, so it ends with the Pi process.

Comparing the wall clock, rather than sleeping for the whole wait, keeps the
resume on time when the machine sleeps; it does not keep the machine awake.

## Transient failures

Pi retries connection and capacity errors itself. When a run still ends on a
failed reply after those retries, with no usage-limit notice, the extension
retries the turn with backoff using the same widget, context omission and
cancellation as a usage-limit wait. A failure counts as transient when
`isRetryableAssistantError` from `@earendil-works/pi-ai` matches it and it is not
a context overflow, or when it is one of two Claude Agent SDK failures that
classifier does not recognise:

- `Claude Agent SDK: the query failed; retry or check Claude Code status`
- `Claude Agent SDK: could not start the query (unexpected SDK error)`

Aborted runs (Esc, or subagents stopped on interrupt), authentication and
invalid-request errors, context overflow and unrecognised errors are not
retried. Transient retries run only in the TUI and RPC modes.

The waits are 1, 2, 5, 10 and 15 minutes, then 15 minutes for each later
attempt. Retrying stops after 8 attempts or once the next attempt would start
more than 120 minutes after the first failure, whichever comes first. Pi then
shows one warning and leaves the session to you. A completed run or a prompt of
your own resets the count. A usage-limit notice replaces a pending transient
wait, and only one wait exists at a time.

Because the wall clock is checked once a minute, a wait shorter than a minute
resumes at the next check.

### Settings

Set `autoResume.transient` in Pi's settings. Every field is optional:

```json
{
  "autoResume": {
    "transient": {
      "enabled": true,
      "delaysMinutes": [1, 2, 5, 10, 15],
      "maxAttempts": 8,
      "windowMinutes": 120
    }
  }
}
```

Delays and the window must be positive and may be fractional. `maxAttempts` must
be a positive integer. If any field is invalid, Pi warns once and uses the
defaults. Settings are reread at each failure. `enabled: false` turns off
transient retries only. `/auto-resume off` turns off both kinds of wait for the
session.

## Print and JSON modes

These modes exit as soon as Pi settles, so the extension never waits there and
never retries transient failures.
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
