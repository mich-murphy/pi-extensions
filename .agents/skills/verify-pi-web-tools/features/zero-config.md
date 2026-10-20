# Zero-config registration

A user starts Pi without web-service credentials and gets websearch and webfetch
without configuration.

## Sub-features

- `zero-start`: extension loads from an empty profile.
- `zero-tools`: both public tools are registered.
- `zero-isolation`: no unrelated resources load.

## How to get to it (user POV)

Start Pi with the web-tools extension; no API keys are required.

## Driving it with verify.py

Preconditions: dependencies installed (the checkout's pinned Pi
devDependency), Python 3, Node, and tmux; no
configured profile is reused.

- **Launch:** run `.agents/skills/verify-pi-web-tools/scripts/verify.py startup`
  from the repo root. `doctor.txt` shows the pinned Pi version and
  command, and `startup.txt` shows only the explicitly
  loaded extension.
- **Discover:** inspect `catalog-doctor.json`; require tool names `websearch`
  and `webfetch`, and zero skills, prompts, and context files.
- **Cleanup:** require `result.json` status `passed`, `serverStopped: true`, and
  `scratchRemoved: true`; evidence still exists.

## Gotchas

- Registration is not search/fetch execution. No keyless MCP or live HTTP
  behavior is claimed.
- No model credentials are expected; the baseline footer may show `unknown`.
- The helper's SDK second view is read-only registration evidence, not
  interactive tool use.
