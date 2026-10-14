# Security Policy

Report suspected vulnerabilities privately rather than in public issues. Do not include exploit details, secrets, or proof-of-concept payloads in public discussion.

## Scope

This package fetches and searches the public web on behalf of an AI agent. In scope:

- SSRF bypasses of the private host/IP blocking, including redirect chains and DNS rebinding.
- API key leakage into tool output, errors, logs, or non-official endpoints.
- Unsafe handling of untrusted provider or page content (markdown conversion, SSE parsing).

## Design notes

- Direct web fetches validate scheme (http/https only), reject URL credentials, resolve DNS, block private/reserved IP ranges, bind the socket to only those validated addresses while retaining the original Host and TLS identity, and re-validate every redirect hop. DNS failure or an empty answer fails closed.
- Responses are byte-capped after decompression (5 MB fetch, 1 MB search) with hard timeouts.
- API keys are resolved through Pi's native authentication system, including stored API keys and `!command` secret-manager keys, with `EXA_API_KEY`, `PARALLEL_API_KEY`, and `BRAVE_API_KEY` as environment fallbacks. Stored credentials take precedence; failed resolution never silently selects that provider's keyless transport. No extension-specific credential file is created.
- Resolved keys are trimmed, checked for embedded control characters, and wrapped in `Redacted`. Credentials are sent only to official provider origins. Endpoint overrides bypass web-tools credential lookup and force MCP; provider REST redirects are not followed. Pi's independent availability checks can still resolve stored commands.
- Each execution retains its credential snapshot for redacting text, metadata, errors, progress updates, telemetry, and spill files, including overlapping requests during key rotation. Scrubbing precedes truncation and spill writes; overlapping secrets are matched longest-first. Authentication exceptions retain only safe categories, never command text, stderr, or rejected key values. The redaction guarantee covers the execution's resolved credentials, not unrelated unused credentials or tool-call inputs that Pi can display/store before resolution; queries and URLs are not credential submission channels.
- Pi 1.1.0's native secret-command executor is synchronous, with a nominal ten-second timeout; it cannot be interrupted by tool cancellation/shutdown and that timeout is not a guaranteed hard wall-clock bound. Command successes and failures are cached for the process lifetime, including across `/reload`. Restart Pi to refresh an unchanged command. Async resolution and provider I/O remain bounded/cancellable; no alternate secret-command runner is introduced.
- Authentication provider IDs are namespaced (`pi-web-tools-exa`, `pi-web-tools-parallel`, `pi-web-tools-brave`). Registration preflights conflicts; replacement by another extension fails safely. Shutdown removes only registrations still owned by this extension, not stored credentials or unrelated providers.
- Provider-side fetch rescue is on by default and flagged in output when used; disable with `PI_WEB_TOOLS_FETCH_RESCUE=off`. Rescue is automatically disabled when a domain allow or deny list is configured because provider-side redirects cannot be checked locally.
- Temp files holding spilled tool output are written with 0600 permissions inside 0700 directories.
