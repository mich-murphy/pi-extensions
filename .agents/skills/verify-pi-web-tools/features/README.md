# pi-web-tools verification map

This maintained map covers baseline behavior and synthetic native authentication in real Pi
1.1.0. Start each journey with fresh scratch state through the helper; never
drive a shared instance.

## Features

- [Zero-config registration](zero-config.md): empty profile, tool discovery,
  usable editor.
- [Native authentication](native-auth.md): synthetic native login, cancellation,
  logout with environment fallback, credential lifecycle and reload identity.
- [Model catalog](model-catalog.md): interactive selector plus all-operation
  catalog; no web-tools dummy models.
- [Reload and invalid configuration](configuration.md): reload and safe visible
  startup failure.

## Evidence contract

Require action records, terminal captures, read-only second-view state, and
successful cleanup. Helpers print retained `/tmp/pi-web-tools-evidence-*` paths.
Report failures and skipped paths explicitly. No prompts, tool executions, or
live provider calls are permitted.
