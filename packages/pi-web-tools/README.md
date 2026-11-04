# pi-web-tools

Public web search and fetch tools for [Pi](https://pi.dev). Works with zero configuration; API keys unlock the official REST APIs and higher rate limits.

- `websearch` searches the web through Exa (default), Parallel, and Brave.
- `webfetch` fetches one public URL as markdown, text, raw HTML, or an inline raster image.

## Zero-config behavior

With no stored credentials or environment configuration:

- `websearch` uses Exa's hosted MCP endpoint (`https://mcp.exa.ai/mcp`), falling back to Parallel's (`https://search.parallel.ai/mcp`). Both are free and keyless.
- `webfetch` fetches directly over HTTP with SSRF protections, then retries Cloudflare challenges with a fallback user agent.

## Authentication

Requires Pi 1.1.0's provider authentication APIs. The web services are authentication-only providers: they appear in `/login` and `/logout`, but add no models to `/model`.

Use Pi's native API-key login:

```text
/login pi-web-tools-exa
/login pi-web-tools-parallel
/login pi-web-tools-brave
```

The display names are **Web Tools: Exa**, **Web Tools: Parallel**, and **Web Tools: Brave**. Pi stores credentials in its private agent directory's `auth.json`, not in this extension or project configuration. `/logout` removes the stored key but does not unset an environment key or revoke it at the provider.

Existing environment-only installations continue to work:

| Variable | Effect |
| --- | --- |
| `EXA_API_KEY` | Search switches to Exa's official REST API (`/search` with highlights). Fetch rescue uses Exa's REST `/contents`. |
| `PARALLEL_API_KEY` | Search switches to Parallel's official REST API (`/v1/search`, `fast` mode, result cap sent as `advanced_settings.max_results`). |
| `BRAVE_API_KEY` | Adds Brave to the end of the search fallback chain. |

Credentials are resolved for each request, with Pi-stored keys taking precedence over environment fallback. Login, logout, and literal key changes affect subsequent requests without restarting Pi. A failed or malformed credential is a provider failure, not permission to switch that provider to keyless MCP; search can still fall back to another provider. Explicit Brave chains require a usable Brave key when searched. Endpoint overrides bypass web-tools credential lookup and always use keyless MCP. Pi's own availability checks can independently resolve stored commands, even when a tool will not use that provider.

Pi also supports secret-manager commands in `auth.json`. For example, the following uses a command rather than persisting the resolved secret:

```json
{
  "pi-web-tools-exa": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'exa'"
  }
}
```

**Pi 1.1.0 command limitations:** native command execution is synchronous with a nominal 10-second timeout, so tool cancellation cannot interrupt a running command. Pi caches command results, including failures, for the process lifetime; `/reload` does not refresh an unchanged command. Restart Pi after changing a secret behind that command. Other asynchronous credential resolution is limited to 10 seconds per provider and respects tool cancellation/shutdown; provider I/O retains its existing deadlines.

Resolved request keys are trimmed, validated for embedded control characters, sent only to official provider origins, and redacted from tool results, details, progress updates, errors, telemetry, and spill files. Concurrent requests retain independent credential snapshots during rotation. This is not a guarantee to scrub unrelated, unused credentials: tool-call arguments are user/model inputs and Pi may display or record them before resolution. Never put credentials in queries or URLs; use native login or the environment instead.

## Configuration

Nonsecret configuration uses environment variables; everything is optional. Credentials use Pi authentication or the environment fallbacks above.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WEB_TOOLS_PROVIDERS` | `exa,parallel` (`+brave` when keyed) | Ordered, comma-separated provider chain. Inclusion enables; order sets priority. |
| `PI_WEB_TOOLS_EXA_ENDPOINT` | `https://mcp.exa.ai/mcp` | Exa MCP-compatible endpoint override. Forces MCP transport; API keys are never sent to overridden endpoints. |
| `PI_WEB_TOOLS_PARALLEL_ENDPOINT` | `https://search.parallel.ai/mcp` | Parallel MCP-compatible endpoint override. Same key rule. |
| `PI_WEB_TOOLS_FETCH_RESCUE` | `on` | `off` disables provider-side fetch rescue. |
| `PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS` | (unset) | Comma-separated hostname allow list for `webfetch`. Subdomains match. |
| `PI_WEB_TOOLS_FETCH_DENY_DOMAINS` | (unset) | Comma-separated hostname deny list. Wins over the allow list. |

## Tools

### `websearch`

Parameters: `query` (required), `maxResults` (1–20, default 8), `provider` (optional per-call override).

Providers are tried in priority order until one succeeds. Results are normalized to title, URL, snippet, published date, and source. Each provider call has a 25-second deadline and a 1 MiB response cap; the deadline is not a whole-chain timeout. A per-call override uses only the selected enabled provider and does not resolve unused provider credentials.

### `webfetch`

Parameters: `url` (required), `format` (`markdown` default, `text`, `html`), `timeout` (1–120s, default 30), `offset` (non-negative byte offset into the converted text, default 0).

Behavior:

- Blocks private and local hosts and IPs, binds each connection to the DNS addresses it validated, and re-checks domain policy plus DNS on every redirect hop.
- Follows at most 5 redirects; rejects URL credentials, non-HTTP redirects, and images or binary content over 10 MB.
- Pages long text: each call re-fetches the page and returns a window of up to 50 KB / 2000 lines starting at `offset` (counted in UTF-8 bytes of the converted text, after redaction; JSON/XML pass through unconverted). An offset inside a character moves to the next character boundary and the notice reports the offset used. When text remains, the notice ends with `Call webfetch again with offset=N to continue.`; an offset at or past the end returns `[offset N is at or past the end of the content (T)]`. For provider-rescued pages the offset counts the page markdown, not the leading note. `offset` is ignored for images.
- A text, HTML, JSON or XML page over the 10 MB download cap (measured after decompression) is not an error: the first 10 MB is returned with `details.truncated` and `details.responseTruncated` set and `structuredContent.response_truncated: true`. Every page of such a fetch starts with a notice that the rest cannot be fetched, and `offset` pages through those 10 MB only. The last window, and an offset past the end, say the content stops at the download limit and the rest cannot be fetched; `next_offset` is absent then. Search provider responses over their cap still fail.
- Returns PNG, JPEG, GIF, and WebP images inline.
- Spills oversized output to a private temp file (0700 directory, 0600 file) so the agent can read it in chunks.
- **Fetch rescue**: when a direct fetch hits a bot wall (401/403/429) or returns an unusable JS-only shell, the URL is retried through Exa's or Parallel's fetch infrastructure (following the search provider priority order). Rescued content is flagged in the output, since the URL is shared with that provider. Rescue only applies to the default markdown format and is disabled whenever a fetch domain allow or deny list is configured, because a remote provider cannot enforce the local policy across its redirects.

### Codemode scripts

Both tools declare an output schema, so codemode scripts receive structured values instead of the model-facing text.

- `websearch` resolves to `{ query, provider, results }`, where each result has `title`, `url` and, when the provider supplies them, `snippet`, `published_at`, `source` and `score`.
- `webfetch` resolves to `{ url, status, mime_type, format, bytes, content, truncated, full_output_path, via, offset, next_offset }` for text. `content` is the page in the requested format from `offset` up to 1 MiB, not the 50 KB model-facing cut; `truncated` is true only when that 1 MiB cut applied, `next_offset` is then the offset to continue from, `offset` is present only when it was non-zero, and `full_output_path` points to the spilled file when one exists. Rescued pages set `via` and omit `status` and `mime_type`. Images resolve to `{ type: "image", data, mimeType, note }`, which codemode's `image()` accepts.
- Failures still throw. Secrets are redacted from every string, as in the text output.

## Verification

Run `npm run check` for the whole-repository gate. Deterministic tests use synthetic credentials with real Pi authentication and injected provider transport boundaries; they cover routing, login/logout changes, command failures, concurrent rotation, redaction, and lifecycle cleanup.

The project-local CLI verification skill is [`.agents/skills/verify-pi-web-tools/SKILL.md`](../../.agents/skills/verify-pi-web-tools/SKILL.md). Its isolated real Pi terminal journeys exercise native login/logout, cancellation, reload, the model catalog, and invalid configuration without real credentials or provider calls. Paid/live provider tests require separate approval.

## Acknowledgements

Fetch-side architecture (SSRF defenses, HTML conversion pipeline, output truncation) is adapted from [dmmulroy/pi-web-tools](https://github.com/dmmulroy/pi-web-tools) (MIT), with the MCP handshake, keyed REST providers, Brave support, provider chain, and fetch rescue added on top.
