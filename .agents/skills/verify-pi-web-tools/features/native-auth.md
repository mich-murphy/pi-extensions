# Native login, logout, and credential lifecycle

## User path

Run `/login` → API key → `Web Tools: Exa`, `Web Tools: Parallel`, or
`Web Tools: Brave`. Direct `/login pi-web-tools-exa` (and the corresponding
`parallel` / `brave` ID) opens the same real native secret dialog. Escape
cancels. `/logout` removes a selected stored key, not shell environment keys.

## Executable journey

```sh
.agents/skills/verify-pi-web-tools/scripts/verify.py native-auth
```

A fresh isolated terminal running the checkout's pinned Pi devDependency has synthetic `EXA_API_KEY`,
`PARALLEL_API_KEY`, and `BRAVE_API_KEY` environment fallbacks. The harness:

1. Cancels a Brave login and requires no stored credential.
2. Logs into each of the three native providers with a synthetic non-secret;
   requires the exact ID, `api_key` type and synthetic value in scratch auth.
3. Reloads twice, requires saved credentials unchanged and each provider label
   appearing exactly once in the native login selector.
4. Logs out each provider through the real selector; requires its auth-file
   entry removed and the native removal notification visible.
5. Requires an empty logout menu, while a public SDK second view confirms each
   provider still has its respective environment auth source configured.
6. Enumerates every operation's models, requiring no web-tools dummy models.
   Captures file paths/sizes/modes, never raw auth contents; removes scratch.

Evidence includes `*-login-prompt.txt`, `*-login-result.txt`,
`cancel-login-*.txt`, `after-cancel.json`, `*-after-login.json`,
`native-reload-*.txt/json`, `*-logout-*.txt`, `*-after-logout.json`,
`logout-empty.txt`, `catalog-doctor.json`, and `storage-metadata.json`.

## Boundaries

No browser, live service, paid request, ordinary model prompt, or tool execution
is used. The SDK doctor uses public `bindExtensions({})` to fire session start;
providers are deliberately registered at session start, not factory load, so
collision checks can use the live registry. CLI screenshots prove real user
flows; the second-view catalog is supplemental, not same-process introspection.

Stored-over-env routing, request-time changes, command-key handling, redaction,
and HTTP cancellation require deterministic production-boundary integration
tests; this UI harness does not establish them. There are no test-only
production APIs or verification driver extensions.

Pi's native stored `!command` resolution (unchanged through 1.3.0) is synchronous, uses a ten-second
executor, and caches successful command output. An extension AbortSignal cannot
interrupt that synchronous resolution; elapsed-time guards are not hard
cancellation. This harness deliberately does not execute credential commands.
