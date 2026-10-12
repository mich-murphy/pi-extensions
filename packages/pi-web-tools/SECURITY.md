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
- API keys come from the environment only, are validated for control characters, are never sent to overridden endpoints, and are redacted from all tool output.
- Provider-side fetch rescue is on by default and flagged in output when used; disable with `PI_WEB_TOOLS_FETCH_RESCUE=off`. Rescue is automatically disabled when a domain allow or deny list is configured because provider-side redirects cannot be checked locally.
- Temp files holding spilled tool output are written with 0600 permissions inside 0700 directories.
