import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cause, Effect, Exit, Match, Result, Schema } from "effect";
import { Type } from "typebox";
import type { Static } from "typebox";
import { resolveCredentialSnapshot } from "./credentials";
import type { CredentialFailure, CredentialResolver, CredentialSnapshot } from "./credentials";
import { appendExpandedPreview, appendExpandHint, displayText, getTextContent } from "./render";
import type { RenderTheme } from "./render";
import { SearchProviders, searchWithFallback } from "./search";
import type { SearchChainError } from "./search";
import { clampInteger, SEARCH_MAX_RESULTS, SEARCH_PROVIDERS, WebToolsConfig } from "./settings";
import type { WebToolsSettings } from "./settings";
import {
  createRequestRedactor,
  credentialNames,
  validateExplicitBrave,
  withToolCredentials,
} from "./tool-credentials";
import type { ToolCredentialComposition, ToolCredentialContext } from "./tool-credentials";
import { projectSearchResults, ToolOutputStore, WEB_SEARCH_OUTPUT_SCHEMA } from "./tool-output";
import type { ToolOutputStoreError } from "./tool-output";
import type { ToolRuntime } from "./tool-runtime";
import { parseSearchQuery } from "./types";
import type { SearchProviderName, SearchQuery, WebSearchDetails } from "./types";

export type WebSearchToolComposition = ToolCredentialComposition & {
  readonly settings: Pick<WebToolsSettings, "search">;
  readonly redactText: (input: string) => string;
  readonly runtime: ToolRuntime<
    SearchProviders | ToolOutputStore | WebToolsConfig | CredentialResolver
  >;
};

export type WebSearchParams = {
  readonly query: SearchQuery;
  readonly maxResults: number;
  readonly provider?: SearchProviderName;
};

export class EmptySearchQueryInput extends Schema.TaggedError<EmptySearchQueryInput>()(
  "EmptySearchQueryInput",
  {},
) {
  override get message(): string {
    return "Search query cannot be empty.";
  }
}

export type WebSearchInputError = EmptySearchQueryInput;

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

export function parseWebSearchParams(
  params: Static<typeof WEB_SEARCH_PARAMETERS>,
  settings: Pick<WebToolsSettings, "search">,
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

export function createWebSearchTool(composition: WebSearchToolComposition) {
  return {
    name: "websearch" as const,
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
    outputSchema: WEB_SEARCH_OUTPUT_SCHEMA,

    async execute(
      _toolCallId: string,
      params: Static<typeof WEB_SEARCH_PARAMETERS>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<WebSearchDetails>,
      context?: ToolCredentialContext,
    ) {
      const parsed = parseWebSearchParams(params, composition.settings);

      if (Result.isFailure(parsed)) {
        throw new Error(composition.redactText(parsed.failure.message));
      }

      const redactor = createRequestRedactor(composition.redactText);

      const program = runWebSearch(parsed.success, (snapshot) => {
        redactor.capture(snapshot);
        const { query, maxResults } = parsed.success;
        onUpdate?.({
          content: [{ type: "text", text: redactor.redactText(`Searching for ${query}...`) }],
          details: {
            query: redactor.redactText(query),
            maxResults,
            provider: composition.settings.search.providers[0] ?? "exa",
            attemptedProviders: [],
            resultCount: 0,
          },
        });
      });

      const exit = await composition.runtime.runExit(
        withToolCredentials(program, composition, context),
        signal,
      );

      if (Exit.isSuccess(exit)) {
        return exit.value;
      }

      if (Cause.hasInterrupts(exit.cause)) {
        throw new Error("Web search cancelled");
      }

      const failure = Cause.findError(exit.cause);

      if (Result.isSuccess(failure)) {
        throw new Error(redactor.redactText(renderWebSearchFailure(failure.success)));
      }

      throw new Error("Web search failed unexpectedly (a pi-web bug). Ask the user to report it.");
    },

    renderCall(
      args: { readonly query: string; readonly provider?: SearchProviderName },
      theme: RenderTheme,
    ) {
      let text = theme.fg("toolTitle", theme.bold("websearch "));
      text += theme.fg("accent", composition.redactText(displayText(args.query)));

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
          theme.fg(
            "error",
            composition.redactText(
              `✗ ${displayText(getTextContent(result.content)) || "Search failed"}`,
            ),
          ),
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

      return new Text(composition.redactText(text), 0, 0);
    },
  };
}

function renderWebSearchFailure(
  error: SearchChainError | ToolOutputStoreError | CredentialFailure,
): string {
  return Match.valueTags(error, {
    OutputStoreError: ({ path, reason }) =>
      `Could not save full websearch output to ${path}: ${reason}`,
    CredentialFailure: ({ provider, message }) => `${provider}: ${message}`,
    UnknownProvider: ({ message }) => message,
    AllProvidersFailed: ({ message }) => message,
  });
}

const runWebSearch = Effect.fnUntraced(function* (
  input: WebSearchParams,
  onCredentials: (snapshot: CredentialSnapshot) => void,
) {
  const providers = yield* SearchProviders;
  const config = yield* WebToolsConfig;
  const store = yield* ToolOutputStore;
  const { query, maxResults, provider } = input;

  const snapshot = yield* resolveCredentialSnapshot(
    credentialNames(config, provider === undefined ? {} : { providerOverride: provider }),
  );

  onCredentials(snapshot);
  yield* validateExplicitBrave(config, snapshot, provider);

  const outcome = yield* searchWithFallback(
    providers.forRequest(snapshot),
    { query, maxResults },
    { providerOverride: provider },
  );

  return yield* projectSearchResults(
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
    { store, secrets: snapshot.secrets },
  );
});
