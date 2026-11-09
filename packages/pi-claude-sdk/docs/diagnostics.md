# Diagnostics

Cache diagnostics are opt-in. They hold counts, breakpoint positions, usage and truncated SHA-256 fingerprints. They never hold prompt text or image bytes.

## Enable

| Variable | Effect |
| --- | --- |
| `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1` | Writes `[claude-sdk-cache]` JSON lines to redirected stderr. A terminal stderr stays silent. |
| `PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE=<path>` | Implies diagnostics. Appends one JSON record per line to the file, created with mode `0600`, even when stderr is a terminal. Write failures are ignored. |

```sh
PI_CLAUDE_SDK_CACHE_DIAGNOSTICS=1 pi 2>claude-sdk-diagnostics.log
```

## Record types

Each record has a `type` and a `turn`.

### `request`

| Field | Meaning |
| --- | --- |
| `model`, `reasoning` | Requested model and thinking level. |
| `minimumCacheableTokens` | Minimum cacheable prefix for the model, when known. |
| `ttl` | `none`, `5m` or `1h`. |
| `blocks`, `textCharacters`, `imageBase64Characters` | Prompt size. |
| `breakpoints` | Block indexes that carry a breakpoint. |
| `commonPrefixBlocks`, `commonPrefixCharacters` | Prefix shared with the previous request. |
| `contentFingerprint`, `systemFingerprint`, `toolsFingerprint`, `reusablePrefixFingerprint` | Fingerprints of the whole prompt, the preamble, the tool catalog and the reusable prefix. |
| `msSincePreviousRequest` | Time since the previous request. |
| `prefixChange` | `first`, `appended`, `system-changed`, `tools-changed`, `history-rewritten`, `model-changed` or `reasoning-changed`. |

### `usage`

| Field | Meaning |
| --- | --- |
| `promptTokens` | Input plus cache read and write tokens. |
| Token counts | Input, output, cache read and cache write, with `cacheWrite1h` and `cacheWrite5m` when the API splits them. |
| `cacheReadPercent` | Share of the prompt served from cache. |
| `expectedReusableCharacters` | Characters shared with the previous prompt. |
| `possibleCollapse` | True for a large turn below half reuse. |
| `minimumCacheableTokens` | Minimum for the observed model, else the requested one. |
| `likelyMissCause` | Present when reuse is below half. See below. |
| `query` | The query summary. |

### `query`

A record with only `type`, `turn` and `query`. It covers a failed turn that reported no usage, so the provider invents no zero counts.

## `likelyMissCause` values

| Value | Meaning |
| --- | --- |
| `caching-disabled` | The request sent no breakpoints. |
| `below-minimum` | The prompt is below the model's minimum and shows no cache read or write. |
| `first` | This is the first request, so nothing could be reused. |
| `ttl-expired` | The previous write outlived its lifetime. |
| `prefix-changed` | The prompt diverged from the previous one. |
| `lookback` | No breakpoint sits within 20 blocks of the previous write. |

## Query summary

| Field | Meaning |
| --- | --- |
| `outcome` | `completed` or `failed`. |
| `numTurns` | SDK turn count. Internal tool-result messages can raise it, so it is not a request count. |
| `modelRequests` | Distinct main-loop model starts. A clean query with more than one fails the handoff. |
| `models`, `modelEntriesOmitted` | Up to eight per-model token totals. Unknown models get `unknown-N` labels. |
| `apiError` | Typed API error. |
| `assistantToolUses`, `maxAssistantToolUses` | Tool uses seen and the highest count allowed. |
| `errorToolResults` | Internal error tool results. |
| `invalidGatewayCalls`, `unexpectedToolCalls`, `uncapturedBatchCalls`, `sdkRejectedCalls` | Counts of rejected calls by category. |
| `fallbackCalls` | MCP handler fallback calls. |

The summary never holds tool arguments, result text or raw SDK messages.

## Failure records

When stderr is redirected, each failed turn also writes a `[claude-sdk-error]` JSON record.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `1`. |
| `kind` | The failure category, as listed in the [README](../README.md#how-it-behaves). |
| `errorTag` | The provider's error type. |
| `operation` | `start` or `iterate`, for transport failures. |
| `terminalReason` | The SDK's terminal reason, when given. |
| `toolContract` | `naming` or `schema`, for tool catalog failures. |
