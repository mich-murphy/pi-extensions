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
prompt or `/auto-resume off` cancels the wait.

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
