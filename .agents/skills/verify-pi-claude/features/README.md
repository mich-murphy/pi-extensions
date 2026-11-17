# Pi Claude SDK verification map

This is the maintained user-journey source for this provider. Read the matching
recipe before driving. All five advertised model IDs are required; a convenient
single-model success cannot stand in for full catalog and live gate coverage.

## Baseline preconditions

- Follow Launch and Doctor in [SKILL.md](../SKILL.md), from this checkout.
- `H` names the executable helper and `E` an owned, fresh `/tmp` proof directory.
- Use isolated `PI_CODING_AGENT_DIR` and scratch cwd throughout. CLI journeys use
  `--no-session`; recovery alone persists owned SDK-loop sessions to prove durability.
- Use existing Claude subscription authentication only. Never log in or read tokens.
- No billing: model prompts require paid extra usage disabled and usable allowance.

## Driving conventions

Use only owned instances. Each helper action starts its own subprocess; no shared
terminal or session is driven. RPC JSONL records are the command/notification
surface, not UI setters. `launch` and `cleanup` are mandatory even on failure.

## Proof and skip reporting

Preserve exact command, stdout/stderr, exit status, sent action and received state.
Each action writes results keyed by feature or sub-feature. Report blocked,
failed, and passed separately. Metadata, status, and usage can pass while live
text/tools remain blocked. Only a fresh `all` exit 0 satisfies the merge condition.
A filtered live test cannot update/replace the full live attestation requirement.

## Features

- [Register and discover models](catalog.md): real CLI loading and model listing.
- [Inspect versions and routing](status.md): discover and invoke status command.
- [Inspect subscription allowance](usage.md): actual usage command without a prompt.
- [Chat and use Pi tools](live.md): actual Pi text/read journeys, real SDK metadata,
  and the full live SDK upgrade gate across all selectors.
- [Recover invalid tool input](recovery.md): real SDK hooks, Pi durable errors,
  corrected pure-tool execution, and no internal model continuation.
- [Publish usage-limit resets](usage-limit.md): offline synthetic SDK messages
  through production registration/parser/runner/bridge and pinned Pi event bus;
  explicitly not live quota exhaustion or SDK/CLI message-generation proof.
- [Reuse the prompt cache](cache.md): live multi-turn cache read shares, no
  hidden side requests, cross-session and fan-out reuse.
