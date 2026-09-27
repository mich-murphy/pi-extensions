# pi-web-tools

Public web search and fetch tools for [Pi](https://pi.dev). Works with zero configuration; API keys unlock the official REST APIs and higher rate limits.

- `websearch` searches the web through Exa (default), Parallel, and Brave.
- `webfetch` fetches one public URL as markdown, text, raw HTML, or an inline raster image.

## Zero-config behavior

With no environment variables set:

- `websearch` uses Exa's hosted MCP endpoint (`https://mcp.exa.ai/mcp`), falling back to Parallel's (`https://search.parallel.ai/mcp`). Both are free and keyless.
- `webfetch` fetches directly over HTTP with SSRF protections, then retries Cloudflare challenges with a fallback user agent.

## Optional API keys

| Variable | Effect |
| --- | --- |
| `EXA_API_KEY` | Search switches to Exa's official REST API (`/search` with highlights). Fetch rescue uses Exa's REST `/contents`. |
| `PARALLEL_API_KEY` | Search switches to Parallel's official REST API (`/v1/search`, `fast` mode). |
| `BRAVE_API_KEY` | Adds Brave to the end of the search fallback chain. |

Keys are sent only to the official provider origins, are validated for control characters at startup, and are redacted from all tool output.

## Configuration

All configuration is environment variables; everything is optional.

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

Providers are tried in priority order until one succeeds. Results are normalized to title, URL, snippet, published date, and source.

### `webfetch`

Parameters: `url` (required), `format` (`markdown` default, `text`, `html`), `timeout` (1–120s, default 30).

Behavior:

- Blocks private and local hosts and IPs (with DNS resolution, re-checked on every redirect hop).
- Follows at most 5 redirects; rejects URL credentials, non-HTTP redirects, and binary content over 5 MB.
- Returns PNG, JPEG, GIF, and WebP images inline.
- Spills oversized output to a private temp file (0700 directory, 0600 file) so the agent can read it in chunks.
- **Fetch rescue**: when a direct fetch hits a bot wall (401/403/429) or returns an unusable JS-only shell, the URL is retried through Exa's or Parallel's fetch infrastructure (following the search provider priority order). Rescued content is flagged in the output, since the URL is shared with that provider. Rescue only applies to the default markdown format.

## Acknowledgements

Fetch-side architecture (SSRF defenses, HTML conversion pipeline, output truncation) is adapted from [dmmulroy/pi-web-tools](https://github.com/dmmulroy/pi-web-tools) (MIT), with the MCP handshake, keyed REST providers, Brave support, provider chain, and fetch rescue added on top.
