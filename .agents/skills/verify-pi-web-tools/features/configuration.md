# Reload and invalid configuration

Users can reload the extension and see a safe notification when provider
configuration is invalid.

## Sub-features

- `config-reload`: `/reload` finishes and keeps registration usable.
- `config-invalid`: unknown provider configuration visibly fails without
  crashing Pi.

## How to get to it (user POV)

Run `/reload` in Pi. Set `PI_WEB_TOOLS_PROVIDERS` before starting Pi to
configure provider order.

## Driving it with verify.py

Preconditions: isolated scratch profile, no credentials or provider calls.

- **Reload baseline:** run `.agents/skills/verify-pi-web-tools/scripts/verify.py
  startup`. Require `/reload` in `actions.json`, `Reloaded` in `reload.txt`,
  both tool names in the catalog doctor, and empty `after-reload.json` auth
  state.
- **Invalid provider:** run
  `.agents/skills/verify-pi-web-tools/scripts/verify.py invalid-config`. Require
  the unknown provider in `invalid-config.txt`; both tool descriptions in
  `catalog-doctor.json` must start with `Unavailable:`.
- **Cleanup:** both runs must retain evidence and report owned server stopped
  and scratch removed.

## Gotchas

- A running process does not receive changed shell environment variables on
  `/reload`; restart for environment changes.
- This negative case uses an unknown provider, not a malformed credential; never
  print real secrets.
- No failing tool is executed: visible notification and unavailable registration
  are the proof boundary.
- See [native auth](native-auth.md) for two reloads with stored synthetic keys
  and exactly-once provider labels in the native selector.
