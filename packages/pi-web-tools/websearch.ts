import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { SearchProvider } from "./provider-types";
import { appendExpandedPreview, appendExpandHint, getTextContent } from "./render";
import { err, ok, type Result } from "./result";
import { type SearchChainError, searchWithFallback } from "./search";
import {
  clampInteger,
  SEARCH_MAX_RESULTS,
  SEARCH_PROVIDERS,
  type WebToolsSettings,
} from "./settings";
import { type PiToolResult, projectSearchResults, type ToolOutputStore } from "./tool-output";
import {
  parseSearchQuery,
  type SearchProviderName,
  type SearchQuery,
  type WebSearchDetails,
} from "./types";

/** Composition injected into the websearch tool. */
export interface WebSearchToolComposition {
  readonly settings: WebToolsSettings;
  readonly providers: readonly SearchProvider[];
  readonly outputStore: ToolOutputStore;
  readonly secrets: readonly (string | undefined)[];
}

/** Parsed websearch tool parameters. */
export interface WebSearchParams {
  readonly query: SearchQuery;
  readonly maxResults: number;
  readonly provider?: SearchProviderName | undefined;
}

/** Expected failures parsing websearch tool input. */
export type WebSearchInputError = { readonly _tag: "InvalidToolInput"; readonly message: string };

interface RenderTheme {
  fg(name: string, value: string): string;
  bold(value: string): string;
}

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

  return ok({
    query: query.value,
    maxResults: clampInteger(
      params.maxResults ?? settings.search.defaultMaxResults,
      SEARCH_MAX_RESULTS,
    ),
    provider: params.provider,
  });
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
      onUpdate?: (update: PiToolResult<WebSearchDetails>) => void,
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
        parsed.value.query,
        outcome.value.results,
        {
          query: parsed.value.query,
          maxResults: parsed.value.maxResults,
          provider: outcome.value.provider,
          attemptedProviders: outcome.value.attemptedProviders,
          resultCount: outcome.value.results.length,
        },
        { store: composition.outputStore, secrets: composition.secrets },
      );
      if (projected._tag === "err") {
        throw new Error("Failed to write full websearch output");
      }
      return projected.value;
    },

    renderCall(args: { query: string; provider?: SearchProviderName }, theme: RenderTheme) {
      let text = theme.fg("toolTitle", theme.bold("websearch "));
      text += theme.fg("accent", args.query);
      if (args.provider) {
        text += theme.fg("muted", ` (${args.provider})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        content: Array<{ type: string; text?: string }>;
        details?: WebSearchDetails;
        isError?: boolean;
      },
      options: { expanded: boolean; isPartial: boolean },
      theme: RenderTheme,
    ) {
      if (options.isPartial) {
        return new Text(theme.fg("warning", "Searching..."), 0, 0);
      }
      if (result.isError) {
        return new Text(
          theme.fg("error", `✗ ${getTextContent(result.content) || "Search failed"}`),
          0,
          0,
        );
      }

      const details = result.details;
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
        text = appendExpandedPreview(text, getTextContent(result.content), theme, {
          maxLines: 20,
          maxColumns: 220,
        });
        if (details?.fullOutputPath) {
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
    case "UnknownProvider":
      return `Provider "${error.provider}" is not enabled. Available: ${error.available.join(", ")}`;
    case "AllProvidersFailed":
      return `All search providers failed (${error.attempts.join("; ")})`;
  }
}
