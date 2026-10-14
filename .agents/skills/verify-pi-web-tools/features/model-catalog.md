# Model catalog

Users should not find invented web-search chat models in Pi's model selector.

## Sub-features

- `model-open`: open the real model picker.
- `model-no-dummy`: inspect all operation catalogs, not only authenticated chat
  models.

## How to get to it (user POV)

Run `/model` or press Ctrl+L in Pi. The helper exercises `/model`; Ctrl+L is not
separately verified.

## Driving it with verify.py

Preconditions: credential-free isolated baseline profile.

- **Open:** run `.agents/skills/verify-pi-web-tools/scripts/verify.py startup`.
  `actions.json` records `/model` and Escape; `model-picker.txt` records the
  real picker result.
- **Inspect:** require no `pi-web-tools` provider models in
  `catalog-doctor.json`, which enumerates all operation types regardless of
  authentication.
- **Retain:** require successful cleanup in `result.json` and preserved
  catalog/terminal evidence.

## Gotchas

- Empty interactive results alone are insufficient: unauthenticated models can
  be hidden.
- Authentication-only native providers have no models of any operation; the
  SDK doctor binds session-start handlers before inspecting them.
- No model is selected and no completion request is sent.
