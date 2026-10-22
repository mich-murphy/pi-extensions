# Subagent child credentials

## User path

A pi-subagents child session resolves web-tools credentials the parent can
resolve. pi-subagents builds each child a fresh `ModelRuntime` and
`ModelRegistry`, replays every parent runtime provider onto it (native first,
else configured), then creates the child session, which loads pi-web-tools
again.

## Executable journey

```sh
.agents/skills/verify-pi-web-tools/scripts/verify.py subagent-child
```

Scratch `auth.json` stores a synthetic `pi-web-tools-exa` API key; the clean
environment sets a synthetic `BRAVE_API_KEY`. A public SDK probe:

1. Opens a parent session with the checkout's pi-web-tools as the sole
   extension and binds it, firing `session_start`.
2. For each child, creates a fresh runtime and registry, replays the parent's
   registered providers as pi-subagents' `inheritRegisteredProviders` does, then
   creates and binds a child session with that runtime.
3. Requires no load or extension error and no authentication-registration
   notification in parent or child; each `pi-web-tools-*` provider exactly once;
   all three replayed natively; Exa configured from `stored` and Brave from
   `environment`, each resolving to the synthetic value.
4. Emits the child's `session_shutdown`, disposes it, and requires the parent's
   provider snapshot and native provider objects unchanged.

The probe then runs against a scratch copy of the checkout's package with
`authentication.ts` taken from the pinned pre-fix commit (`PRE_FIX_COMMIT` in
`verify.py`). That run must hit the collision notification in every child.

Evidence includes `subagent-child.mjs`, `subagent-child-checkout.json`,
`subagent-child-pre-fix.json`, their `.stderr.txt`, and
`subagent-child-summary.json` with each run's unmet assertions.

## Gotchas

- Pi caches extension factories per cwd. The `same-cwd` child reuses the
  parent's module instance; the `other-cwd` child gets a fresh one, and the
  harness requires that. Both exercise the `globalThis` origin map.
- `AgentSession` exposes only `modelRuntime`; the probe wraps it in a public
  `ModelRegistry`, as Pi does for extension contexts.
- Native registration starts an unawaited availability refresh. The probe awaits
  `refresh({allowNetwork: false})` before reading synchronous auth status.
- `dispose()` alone does not emit `session_shutdown`; the probe emits it like
  pi-subagents does.
- Summaries keep auth source, type and synthetic equality only, never values.
  No prompts, tool executions or network requests occur.
