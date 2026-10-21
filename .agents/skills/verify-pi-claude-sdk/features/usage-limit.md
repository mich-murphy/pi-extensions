# Publish usage-limit reset notices

## Drive without credentials or quota exhaustion

After `launch`, run:

```sh
"$H" usage-limit --evidence "$E"
"$H" cleanup --evidence "$E"
```

This action is mandatory in `all`, alongside every pre-existing live, recovery,
cache, metadata, command and catalog requirement. Standalone success is NOT merge
approval. Do not deliberately exhaust real quota, log in, read credentials or
send provider requests to manufacture this condition.

## Boundary and required proof

Read `scripts/usage-limit-probe.ts` and `scripts/usage-limit-sdk-boundary.ts`.
The helper copies the production package unchanged into owned scratch, symlinks
existing dependencies, and launches a separate process with an empty owned HOME,
isolated Pi state and only basic host variables. No real auth variables or HOME
reach it; no key is needed. The checkout's pinned Pi SDK creates a real
`AgentSession`, resource loader, provider registry, extension runtime and event
bus. Compaction, retries, warming, tools and discovered resources are disabled.

An isolated jiti alias replaces only the installed SDK's `query` export with a
bounded async iterator of synthetic SDK messages. SDK `tool`, `AbortError` and
`createSdkMcpServer` still delegate to the installed SDK. The actual unchanged
production default extension factory registers its provider and wires its
`usageLimitObserver` to its real publisher. There is no replacement provider
stream, parser, runner, bridge, registration API or event-bus stub. A second
extension registers faulty listeners; a third receives the notice and observes
assistant completion. Exactly one injected query per prompt is required.

Required observations in safe JSON output:

- A rejected raw `rate_limit_event` with reset seconds produces exactly
  `{ provider: "claude-sdk", resetsAt: seconds * 1000 }` through the real bus.
  The receiving callback runs before the authoritative assistant error message.
- Both terminal `blocking_limit` and assistant `rate_limit` API error paths work.
  Successful turns, non-limit failures and authentication overriding a limit
  emit nothing, even with a valid rejected reset.
- Missing reset, allowed/warning, malformed metadata and invalid reset values
  (zero, negative, NaN, infinity, string, outside Date range) emit nothing.
- No reset leaks into the following query. The latest valid rejected reset wins;
  subsequent rate-limit updates replace it conservatively: missing/invalid,
  allowed/warning, unknown and malformed updates clear earlier reset metadata.
- A throwing listener and a rejecting async listener cannot prevent a later
  receiving extension or change the original failed turn. Exactly two controlled
  bus error logs are counted, not printed; unrelated errors remain visible.

## Evidence and honest limits

`usage-limit-results.json` records action status. `usage-limit-probe.stdout`
records each case, exact notice payload, callback/completion ordering and query
count; stderr retains production allowlisted failure diagnostics. Command, cwd,
PID and exit code are retained too. Evidence lives under private `/tmp` and
survives cleanup; scratch contains only controlled prompts and is removed.

This is **OFFLINE synthetic SDK-message fixture proof** of the production
messages parser + runner + extension registration/event-bus integration using
the pinned Pi runtime. It does NOT exercise the real SDK/Claude CLI's creation
of rate-limit messages, Anthropic transport, actual subscription limits, live
reset timing, automatic resumption or interactive UI. In particular it is not
the separate recovery feature's real SDK/CLI parser fixture. Existing live
provider journeys remain mandatory and must be reported separately. No live
quota-exhaustion check is authorized by this recipe.
