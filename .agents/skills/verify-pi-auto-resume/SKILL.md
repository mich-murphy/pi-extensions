---
name: verify-pi-auto-resume
description: Verify pi-auto-resume after provider or lifecycle changes using checkout-pinned Pi CLI, isolated real tmux TUI, print and JSON modes, and synthetic usage limits. Offline only; no real credentials or provider calls; includes a real minute-long resume timer.
---

# Verify pi-auto-resume

Read [the feature map](features/README.md), then run from the checkout root:

```sh
.agents/skills/verify-pi-auto-resume/scripts/verify.py all
```

Requires installed checkout dependencies (`npm install`), Node, Python 3, and
tmux. Resolve script paths relative to this skill when running elsewhere. The
helper resolves the checkout from its own location, checks the installed Pi
version against the root devDependency, and runs that package's actual `bin.pi`
with Node. A global Pi is recorded but never executed.

## Isolation and safety

Each run creates unique `/tmp/pi-auto-resume-state-*` scratch state and a private
tmux socket. Every journey gets separate HOME, agent directory, temporary
directory, and empty cwd. Pi receives a clean environment, no inherited secrets,
empty package settings, disabled retries/compaction/cache warming, and explicit
`--offline`. Discovered extensions, MCP, skills, context files, prompts, themes,
and tools are disabled. Only the package under test and
[`scripts/fixture-provider.ts`](scripts/fixture-provider.ts) load explicitly.

The fixture registers a synthetic model with a non-network URL and a dummy key.
It records complete model requests, emits the documented `usage-limit` event
bus payload, and returns canned assistant errors/success. It never delegates to
another provider, executes tools, or uses network transports. **Do not replace
this fixture with a subscription model or real credentials.** `--offline`
disables automatic network activity, not arbitrary network calls; this is not an
OS firewall. Isolation here avoids loading real settings and credentials, not
sandboxing untrusted extensions.

## Execution and acceptance

Print and JSON journeys run first, followed by independent tmux TUI sessions.
The TUI cases overlap their real one-minute timers to keep runtime around two
minutes rather than one minute per case. No extension internals, clocks, or
timers are mocked or accelerated. A reset is two seconds ahead of the actual
wall clock; the production interval remains 60 seconds.

The helper sends literal prompts and slash commands through real terminal PTYs,
dismisses command completion with Escape before Enter, and saves current-pane
screens. It requires both the visible waiting widget and the resumed transcript,
plus a second recorded model request at/after reset and at least 59 seconds after
the original request. It checks failed-attempt and marker exclusion from that
request, while the original user task remains present.

Require exit status zero, `result.json` status `passed`, all cleanup booleans
true, and the expected request counts. Do not treat a startup screen, an emitted
limit event, or merely waiting 60 seconds as a passing resume.

## Evidence and cleanup

The helper prints and retains `/tmp/pi-auto-resume-evidence-*`. Artifacts:

- `launch.json`: pinned version, exact argv, sanitized environment, isolated cwd.
- `actions.json`: timestamped terminal input.
- `<case>-*.txt`: startup, waiting, cancellation/switch, and final pane captures.
- `<case>-requests.jsonl`: full synthetic model requests and wall-clock times.
- `print-stdout.txt`, `print-stderr.txt`, `json-stdout.txt`, `json-stderr.txt`.
- `result.json`: assertions summary, request counts, failure, and cleanup state.

Evidence contains only synthetic conversations, never real auth. `finally`
snapshots owned pane PIDs and descendants, stops only the dedicated tmux server,
waits for those PIDs to exit (escalating signals only to owned PIDs if needed),
and removes scratch. Cleanup failures set status `failed` and populate
`cleanupErrors` before writing the result. Node compile caching is disabled to prevent
exit-time cache writes. Failure artifacts survive cleanup. If interrupted with
SIGKILL, use the exact socket in `launch.json`'s scratch paths to stop only that
server before removing its scratch directory; never kill tmux by process name.

## Coverage limits

This proves the extension's public integration with Pi, not Claude SDK's real
limit parsing or provider retry behavior. The fixture publishes the event itself;
no live provider or transport is tested. Real sleep/wake, OS clock jumps, the
exact five-hour boundary, malformed payload permutations, repeated limits after
resume, busy-at-reset, fork/tree/resume navigation, and RPC are not covered.
Negative TUI cases are observed beyond a real interval, but cannot prove the
absence of an invisible dormant timer; they prove no widget or extra request.
The `/new` and `/reload` regressions cover active-wait disposal, not every
session-switch path. Record these limits explicitly in acceptance reports.
