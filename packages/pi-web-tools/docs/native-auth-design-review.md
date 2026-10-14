# Native authentication design review

Status: implemented against Pi 1.1.0, retaining the native command limitations below. This document records the review and resulting architecture of the supplied native-authentication handoff. Verification results are recorded separately; design reasoning alone is not proof.

## Assessment

Moving credential ownership to Pi is better than the current environment-only implementation: it adds native API-key login/logout, stored credentials, and secret-manager commands without another store or custom login UI. Existing transports and public-web security controls should remain unchanged.

The handoff is not correct as written about command cancellation, command rotation, or failure classification. Public-API probes with synthetic credentials confirmed these limitations. No developer credentials were inspected and no live provider requests were made.

## Defaults and initial setup

With no credentials or configuration, search tries Exa's keyless MCP endpoint, then Parallel's. Fetch uses direct public HTTP first. Neither tool needs login.

| Setting | Default | Interaction |
| --- | --- | --- |
| Search providers | `exa,parallel` | Append Brave only when its request-time credential is usable; preserve explicit order separately. |
| Exa MCP | `https://mcp.exa.ai/mcp` | An explicit endpoint override always forces credential-free MCP. |
| Parallel MCP | `https://search.parallel.ai/mcp` | Same override rule. |
| Search result count | 8 | Per-call `maxResults` rounds/clamps to 1–20; nonfinite values use 8. |
| Search deadline | 25 seconds per provider | This is not a whole-chain deadline. |
| Search/provider response cap | 1 MiB | Includes provider-side rescue responses. |
| Fetch format | `markdown` | Per-call `text` and `html` are also supported; raster images are returned inline. |
| Whole fetch deadline | 30 seconds | Per-call `timeout` rounds/clamps to 1–120 seconds; includes rescue and output projection. |
| Direct fetch response cap | 5 MiB | Applied after decompression. |
| Direct fetch redirects | At most 5 | Recheck domain policy and DNS at every hop. Provider REST calls do not follow redirects. |
| Fetch rescue | On | Only for eligible blocked/unusable markdown; disabling rescue prevents sharing the URL with a rescue provider. |
| Fetch allow/deny lists | Empty | Hostname entries include subdomains; deny wins. Either nonempty list disables remote rescue. |
| Credential source | None | Pi-stored credentials take precedence over environment fallback. |

The nonsecret environment settings remain `PI_WEB_TOOLS_PROVIDERS`, `PI_WEB_TOOLS_EXA_ENDPOINT`, `PI_WEB_TOOLS_PARALLEL_ENDPOINT`, `PI_WEB_TOOLS_FETCH_RESCUE`, `PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS`, and `PI_WEB_TOOLS_FETCH_DENY_DOMAINS`. Unknown provider names and invalid endpoints fail closed. Provider lists are deduplicated in first-mention order. Rescue recognizes `on`/`off`, case-insensitively; unrecognized values retain the default.

Credentials continue to recognize `EXA_API_KEY`, `PARALLEL_API_KEY`, and `BRAVE_API_KEY`. They must leave static settings and be validated after resolution. Explicit Brave selection must be validated at request time, not rejected at startup merely because its environment variable is missing.

## Recommended startup and request lifecycle

1. Parse nonsecret settings at extension load; register tools without opening clients.
2. At `session_start`, preflight reserved provider IDs through the public model registry, then register authentication-only providers. Suggested IDs are `pi-web-tools-exa`, `pi-web-tools-parallel`, and `pi-web-tools-brave`, with clear display names. They contribute zero chat, image, or classifier models.
3. Reuse Pi's generated API-key login implementation, credential store, and command resolver. A narrow native authentication override must distinguish a stored credential with an unresolved key from a truly absent credential. Do not import Pi's internal provider composer or invent a streaming implementation.
4. Each tool execution owns immutable credential outcomes and redaction material. Resolve only credentials needed by its route; endpoint overrides must not trigger unnecessary secret commands. Generic progress messages can precede resolution, but must not echo credential-sensitive input then.
5. Create inexpensive keyed adapters per request. Retain the runtime's HTTP client, MCP endpoint-client cache, and Parallel application session ID across login/logout and key changes.
6. Redact before output projection, error conversion, excerpt truncation, telemetry export, and spill writes. Retain old request snapshots until their requests finish, even while newer keys are being used.
7. Cancellation stops fallback and prevents late auth completion from starting transport. Shutdown interrupts extension-owned work, closes the runtime admission gate, disposes resources, and unregisters only owned authentication providers without removing credentials. Pi retains session-start registrations across reload unless the extension explicitly removes them. Reload creates fresh extension state; a subsequent session_start reactivates session-scoped services.

Public provider registration does not enforce ownership. Factory-time registration queues changes before a registry context is available; session-start registration allows a collision check before changing the registry. Another extension can still overwrite IDs afterward, so namespace the IDs and fail safely if ownership changes. These auth-only providers do not need to exist in sessionless `--list-models` invocations.

## Credential outcomes and routing

| Outcome | Exa | Parallel | Brave |
| --- | --- | --- | --- |
| Absent | Keyless MCP search/rescue | Keyless MCP search/rescue | Not in default chain; an explicit Brave chain fails validation before provider I/O. |
| Usable | Official REST search and contents rescue | Official REST search; MCP rescue remains unchanged | Official REST search; append to default chain. |
| Failed resolution/validation | Failed attempt, never silently use this provider's keyless route | Same; preserve the intentionally MCP-based rescue contract | Safe auth failure, not an absent credential. |
| Endpoint override | Credential-free MCP | Credential-free MCP | No override supported. |

Fallback to a different provider may continue after a provider authentication failure, except an explicitly configured unusable Brave chain fails validation before search. Failed Exa/Parallel credentials also skip that provider's rescue adapter; this is not an implicit downgrade. Parallel's MCP rescue remains unchanged for usable or absent credentials. A per-call override skips validation/resolution of other providers. Per-call provider selection must use request-time availability. Logout removes Pi's stored key, not the environment key: a surviving environment key can keep REST enabled.

Stored blank/unresolved keys should be failures; blank environment values remain absent. Trim and reject control characters without printing rejected values. Never surface raw resolver exceptions or their causes: Pi's configured-command errors can include the full command text.

## Material Pi 1.1.0 limitations

### Native commands are blocking, not promptly cancellable

Pi resolves stored `!command` keys with synchronous `execSync`/`spawnSync`, using a nominal ten-second timeout. The event loop cannot process a tool abort, shutdown signal, or Effect timer while that command blocks. Ten seconds is not a guaranteed hard wall-clock bound if child termination stalls.

The extension-facing `ModelRegistry.getProviderAuth()` has no signal parameter. Racing its promise against cancellation can stop asynchronous waiting and suppress late transport, but cannot cancel the underlying synchronous command.

Strict command cancellation therefore requires an upstream Pi change or separately approved process isolation. A second command runner/store would violate the requested architecture.

### Stored command results are cached for the process lifetime

Both success and failure are cached by command text. `/reload` does not clear this cache. Replacing a literal key affects subsequent requests; changing a secret behind an unchanged command does not guarantee fresh output. Restart Pi to refresh that command's result.

### Legacy resolution alone loses failure information

A legacy registration with `apiKey: "$EXA_API_KEY"` rejects when the environment variable is absent. A failed stored command can instead resolve to `undefined`. Neither `getApiKeyForProvider()` nor `getProviderAuth()` alone gives the required absent/failed distinction. `getProviderAuthStatus()` uses snapshot metadata and is not an authoritative atomic classifier.

Use a narrow public native authentication override over the publicly registered empty-catalog provider. It receives Pi's resolved stored credential object: no credential plus no environment value is absent; a stored API-key credential with no usable resolved key is a failure. Preserve Pi's generated methods and login rather than implementing fake model operations. The adapter marks authoritative absence in its auth result; an undefined result without that marker is an incompatible credential failure, including externally added OAuth entries whose registry status metadata is stale. Native availability checks still report absent credentials as unconfigured. Pi may serve its last valid storage snapshot after a read failure, so the extension cannot promise stronger storage-failure detection than Pi itself.

## Redaction corrections

The current startup-only redactor cannot cover newly stored or rotated keys. Also fix these existing weaknesses while implementing:

- Match overlapping secrets longest-first in one pass, so a short key does not partially expose a longer one.
- Never throw raw Effect defects to Pi.
- Sanitize textual image metadata as well as text/details, without modifying binary image data.
- Scrub MCP errors before truncating excerpts; a truncated key cannot be removed reliably by later full-key matching.
- Verify telemetry using a captured exporter, not just the final tool result.

## Verification plan

Use `.agents/skills/verify-pi-web-tools/SKILL.md`, generated with the `create-verification` skill. Its real Pi 1.1.0 terminal harness uses a private tmux socket, scratch home/agent directory/cwd, empty environment, and explicitly loads only this extension. It disables discovery, MCP auto-start, sessions, telemetry, and automatic online activity. It never sends a model prompt or a provider call.

Mapped journeys cover registration/model catalog, reload, invalid configuration, and native login/logout: cancelled login, synthetic successful login for all three providers, native storage side effects, stored-key preservation through repeated reload, logout with environment fallback, and no dummy models. Capture actions, terminal states, safe synthetic storage summaries, catalog metadata, and cleanup results; retain evidence after cleanup. Deterministic integration tests cover transport changes after logout without an environment fallback.

Deterministic tests must cover resolver outcomes, stored/environment precedence, command success/failure, dynamic Brave, overrides, order/fallback, concurrent rotation/cancellation, safe errors/updates/spills/telemetry, client/session identity, and shutdown. Keep redirect, SSRF, domain-policy, timeout, and byte-cap regressions unchanged. Run targeted tests during development and `npm run check` at completion. Do not weaken gates. Paid/live provider calls require separate approval.

## Runtime decision

The implementation uses Pi 1.1.0's native authentication with its blocking command execution and process-lifetime command cache explicitly documented. It does not introduce another store or executor and does not promise prompt native-command cancellation. Strict command cancellation requires an upstream Pi change. Pi's independent availability checks may resolve stored commands even when web-tools bypasses credential lookup for an endpoint override.

Redaction covers the execution's resolved credential snapshot, including overlap during rotation. It cannot scrub unrelated unused credentials or prevent Pi from recording user/model-supplied tool arguments before resolution. Early validation errors therefore avoid echoing arbitrary schemes and hostnames, and credentials belong only in native login/environment inputs.
