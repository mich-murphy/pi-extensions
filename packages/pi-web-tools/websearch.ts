import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cause, Data, Effect, Exit, Result } from "effect";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { SearchProvider } from "./provider-types";
import { appendExpandedPreview, appendExpandHint, getTextContent } from "./render";
import type { RenderTheme } from "./render";
import { searchWithFallback } from "./search";
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

/** The websearch query was empty after trimming. */
export class EmptySearchQueryInput extends Data.TaggedError("InvalidToolInput") {
  /** Safe user-facing description. */
  override get message(): string {
    return "query cannot be empty";
  }
}

/** Expected failures parsing websearch tool input. */
export type WebSearchInputError = EmptySearchQueryInput;

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
): Result.Result<WebSearchParams, WebSearchInputError> {
  const query = parseSearchQuery(params.query);
  if (Result.isFailure(query)) {
    return Result.fail(new EmptySearchQueryInput());
  }

  const maxResults = clampInteger(
    params.maxResults ?? settings.search.defaultMaxResults,
    SEARCH_MAX_RESULTS,
  );
  return Result.succeed(
    params.provider === undefined
      ? { query: query.success, maxResults }
      : { query: query.success, maxResults, provider: params.provider },
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
      if (Result.isFailure(parsed)) {
        throw new Error(parsed.failure.message);
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching for ${parsed.success.query}...` }],
        details: {
          query: parsed.success.query,
          maxResults: parsed.success.maxResults,
          provider: composition.providers[0]?.name ?? "exa",
          attemptedProviders: [],
          resultCount: 0,
        },
      });

      const { query, maxResults, provider } = parsed.success;
      const program = searchWithFallback(
        composition.providers,
        { query, maxResults },
        { providerOverride: provider },
      ).pipe(
        Effect.flatMap((outcome) =>
          projectSearchResults(
            {
              query,
              results: outcome.results,
              details: {
                query,
                maxResults,
                provider: outcome.provider,
                attemptedProviders: outcome.attemptedProviders,
                resultCount: outcome.results.length,
              },
            },
            { store: composition.outputStore, secrets: composition.secrets },
          ),
        ),
      );

      const exit = await Effect.runPromiseExit(program, { signal });
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      if (Cause.hasInterrupts(exit.cause)) {
        throw new Error("Web search cancelled");
      }
      const failure = Cause.findError(exit.cause);
      if (Result.isSuccess(failure)) {
        const error = failure.success;
        throw new Error(
          error._tag === "OutputStoreError"
            ? `Could not save full websearch output to ${error.path}: ${error.reason}`
            : error.message,
        );
      }
      throw Cause.squash(exit.cause);
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
