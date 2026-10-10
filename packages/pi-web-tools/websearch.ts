import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { SearchProvider } from "./provider-types";
import { appendExpandedPreview, appendExpandHint, getTextContent } from "./render";
import type { RenderTheme } from "./render";
import { err, ok } from "./result";
import type { Result } from "./result";
import { searchWithFallback } from "./search";
import type { SearchChainError } from "./search";
import { clampInteger, SEARCH_MAX_RESULTS, SEARCH_PROVIDERS } from "./settings";
import type { WebToolsSettings } from "./settings";
import { projectSearchResults } from "./tool-output";
import type { ToolOutputStore } from "./tool-output";
import { parseSearchQuery } from "./types";
import type { SearchProviderName, SearchQuery, WebSearchDetails } from "./types";

/** Composition injected into the websearch tool. */
export type WebSearchToolComposition = {
  readonly settings: WebToolsSettings;
  readonly providers: readonly SearchProvider[];
  readonly outputStore: ToolOutputStore;
  readonly secrets: readonly (string | undefined)[];
};

/** Parsed websearch tool parameters. */
export type WebSearchParams = {
  readonly query: SearchQuery;
  readonly maxResults: number;
  readonly provider?: SearchProviderName;
};

/** Expected failures parsing websearch tool input. */
export type WebSearchInputError = { readonly _tag: "InvalidToolInput"; readonly message: string };

/**
 * Tool parameters. Pi validates and converts arguments against this schema before `execute` runs,
 * so it owns field types, the provider enum, and unknown-field rejection.
 */
const WEB_SEARCH_PARAMETERS = Type.Object(
  {
    query: Type.String({ description: "The search query." }),
    maxResults: Type.Optional(
      Type.Number({
        description: `Maximum number of results (${SEARCH_MAX_RESULTS.min}-${SEARCH_MAX_RESULTS.max}). Defaults to ${SEARCH_MAX_RESULTS.default}.`,
      }),
    ),
    provider: Type.Optional(
      StringEnum([...SEARCH_PROVIDERS], {
        description: "Optional provider override. Defaults to the configured provider chain.",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Parse schema-validated parameters into websearch input. Only semantic work is left here: query
 * trimming, settings defaults, and maxResults clamping.
 */
export function parseWebSearchParams(
  params: Static<typeof WEB_SEARCH_PARAMETERS>,
  settings: WebToolsSettings,
): Result<WebSearchParams, WebSearchInputError> {
  const query = parseSearchQuery(params.query);
  if (query._tag === "err") {
    return err({ _tag: "InvalidToolInput", message: "query cannot be empty" });
  }

  const maxResults = clampInteger(
    params.maxResults ?? settings.search.defaultMaxResults,
    SEARCH_MAX_RESULTS,
  );
  return ok(
    params.provider === undefined
      ? { query: query.value, maxResults }
      : { query: query.value, maxResults, provider: params.provider },
  );
}

/** Create the websearch pi tool. */
export function createWebSearchTool(composition: WebSearchToolComposition) {
  return {
    name: "websearch",
    label: "Web Search",
    description:
      "Search the public web and return ranked results with titles, URLs, and snippets. Defaults to Exa, with automatic fallback across configured providers.",
    promptSnippet: "Search the public web and return ranked results with URLs and snippets",
    promptGuidelines: [
      "Use websearch to find current information, documentation, or sources before fetching.",
      "Fetch the most promising result with webfetch rather than fetching every result.",
      "Only set the provider parameter when the user asks for a specific provider or a previous search failed.",
    ],
    parameters: WEB_SEARCH_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: Static<typeof WEB_SEARCH_PARAMETERS>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<WebSearchDetails>,
    ) {
      const parsed = parseWebSearchParams(params, composition.settings);
      if (parsed._tag === "err") {
        throw new Error(parsed.error.message);
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching for ${parsed.value.query}...` }],
        details: {
          query: parsed.value.query,
          maxResults: parsed.value.maxResults,
          provider: composition.providers[0]?.name ?? "exa",
          attemptedProviders: [],
          resultCount: 0,
        },
      });

      const outcome = await searchWithFallback(
        composition.providers,
        { query: parsed.value.query, maxResults: parsed.value.maxResults },
        { signal, providerOverride: parsed.value.provider },
      );
      if (outcome._tag === "err") {
        throw new Error(renderSearchChainError(outcome.error));
      }

      const projected = await projectSearchResults(
        {
          query: parsed.value.query,
          results: outcome.value.results,
          details: {
            query: parsed.value.query,
            maxResults: parsed.value.maxResults,
            provider: outcome.value.provider,
            attemptedProviders: outcome.value.attemptedProviders,
            resultCount: outcome.value.results.length,
          },
        },
        { store: composition.outputStore, secrets: composition.secrets },
      );
      if (projected._tag === "err") {
        throw new Error("Failed to write full websearch output");
      }
      return projected.value;
    },

    renderCall(
      args: { readonly query: string; readonly provider?: SearchProviderName },
      theme: RenderTheme,
    ) {
      let text = theme.fg("toolTitle", theme.bold("websearch "));
      text += theme.fg("accent", args.query);
      if (args.provider) {
        text += theme.fg("muted", ` (${args.provider})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        readonly content: readonly { readonly type: string; readonly text?: string }[];
        readonly details?: WebSearchDetails;
        readonly isError?: boolean;
      },
      options: { readonly expanded: boolean; readonly isPartial: boolean },
      theme: RenderTheme,
    ) {
      if (options.isPartial) {
        return new Text(theme.fg("warning", "Searching..."), 0, 0);
      }
      if (result.isError === true) {
        return new Text(
          theme.fg("error", `✗ ${getTextContent(result.content) || "Search failed"}`),
          0,
          0,
        );
      }

      const { details } = result;
      const count = details?.resultCount ?? 0;
      let text = theme.fg("success", `✓ ${count} result${count === 1 ? "" : "s"}`);
      if (details?.provider) {
        text += theme.fg("muted", ` via ${details.provider}`);
      }
      if (details?.truncated === true) {
        text += theme.fg("warning", " [truncated]");
      }
      text = appendExpandHint(text, options.expanded);

      if (options.expanded) {
        text = appendExpandedPreview(text, {
          text: getTextContent(result.content),
          theme,
          maxLines: 20,
          maxColumns: 220,
        });
        if (details?.fullOutputPath !== undefined && details.fullOutputPath !== "") {
          text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  };
}

/** Render a search chain failure as a safe user-facing message. */
export function renderSearchChainError(error: SearchChainError): string {
  switch (error._tag) {
    case "UnknownProvider": {
      return `Provider "${error.provider}" is not enabled. Available: ${error.available.join(", ")}`;
    }
    case "AllProvidersFailed": {
      return `All search providers failed (${error.attempts.join("; ")})`;
    }
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}
