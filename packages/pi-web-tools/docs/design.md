# Design

How pi-web-tools resolves credentials, keeps fetches safe and manages its native authentication.

## Credential resolution

Each request resolves only the credentials its route needs. Endpoint overrides and providers outside a per-call `provider` choice are skipped.

- Pi owns storage. The extension registers `pi-web-tools-exa`, `pi-web-tools-parallel` and `pi-web-tools-brave` as authentication-only providers with no models, and reads keys through Pi's registry. A stored key wins over `EXA_API_KEY`, `PARALLEL_API_KEY` or `BRAVE_API_KEY`. The extension creates no credential file.
- A resolved key is trimmed and rejected if empty or containing control characters. It is wrapped in `Redacted` and sent only to official provider origins. Provider REST redirects are not followed.
- Each outcome is a key, absent, or a failure. A stored key that cannot resolve is a failure, not absent, so a broken Exa or Parallel credential never silently downgrades to keyless MCP. Search can still continue with the next provider. Failures keep only a safe category (`unavailable`, `resolution`, `invalid`, `timeout`, `incompatible`), never command text, stderr or the rejected value.
- Each execution keeps its own credential snapshot, so overlapping requests stay correct during key rotation.

### Redaction

Every string that leaves a tool is scrubbed with the execution's snapshot: text, details, errors, progress updates, telemetry, image metadata and spill files. Scrubbing runs before truncation and spilling. Overlapping secrets match longest first. Redaction covers the execution's resolved keys, not tool-call arguments, which Pi can show or record before resolution. Early validation errors avoid echoing schemes and hostnames for the same reason.

## Fetch safety

Direct fetches pass these checks:

- Only `http` and `https`, and no credentials in the URL.
- Domain allow and deny lists apply first. Deny wins.
- DNS is resolved and private and reserved addresses are blocked. A DNS failure or empty answer fails closed.
- The connection is pinned to the validated addresses, keeping the original Host header and TLS identity. A rebinding answer cannot change the target.
- Every redirect hop repeats the domain and DNS checks, up to 5 hops.
- Responses are byte-capped after decompression (10 MiB), with a deadline. Text over the cap is returned truncated and flagged. Cloudflare challenges are retried once with a fallback user agent.
- Oversized output spills to a temp file in a 0700 directory with 0600 permissions, because pages can hold sensitive content.

### Redirects

OWASP's [SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) says to "Disable the support for the following of the redirection in your web client". This package follows redirects anyway, as a deliberate deviation, because many real pages move between URLs and a fetch tool that fails on every redirect is not useful.

Following is safe only if a redirect cannot reach a target the first request could not. `network.ts` handles each hop as a new request. It rejects credentials in the URL, a non-`http(s)` protocol, a missing or invalid `Location` and a chain past the hop limit. Then it applies the domain allow and deny lists, resolves DNS, blocks private and reserved addresses and connects only to the validated addresses.

The residual risk is that the policy is a deny list of address ranges, which OWASP calls bypass-prone, so a range the list misses is reachable by redirect as well as directly. A redirect also lets a public page choose where the next request goes, within the same policy.

## Provider-side fetch rescue

When a direct markdown fetch gets 401, 403 or 429, or returns an HTML page with under 160 characters of text, the URL is retried through Exa or Parallel in search priority order. Output marks rescued pages with `via`, because the URL is shared with that provider.

Rescue is off when `PI_WEB_TOOLS_FETCH_RESCUE=off`, when the format is not `markdown`, or when an allow or deny list is set. A remote provider follows its own redirects, so it cannot enforce the local policy. A provider whose credential failed is skipped.

## Native authentication

### Lifecycle

1. At load, the extension parses settings and registers both tools. No clients open yet. Invalid settings register tools that report the error.
2. At `session_start`, it checks the provider IDs for conflicts, registers the three authentication-only providers and starts the runtime. A conflict shows an error notification.
3. Each tool call resolves credentials from the registry of the current session, builds cheap per-request adapters and redacts every output. The HTTP client, MCP clients and Parallel session ID persist across logins and logouts.
4. Cancellation stops fallback at once.
5. At `session_shutdown`, the extension disposes its runtime and unregisters only providers it still owns. Stored credentials stay.

Provider registration does not enforce ownership, so another extension could overwrite an ID later. The extension detects that and fails the credential with `incompatible` instead of using it.

### Pi limitation: secret commands

Pi runs stored `!command` keys with a synchronous call and a nominal 10-second timeout. The event loop cannot handle a tool abort or shutdown while it runs, and the timeout is not a guaranteed hard bound. Pi caches both successes and failures by command text for the process lifetime, and `/reload` does not clear it. Restart Pi after changing a secret behind an unchanged command. Pi's own availability checks can also run a stored command even when web-tools skips that provider. Prompt cancellation needs an upstream Pi change.
