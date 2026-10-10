import { StringEnum } from "@earendil-works/pi-ai";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cause, Duration, Effect, Exit, Result, Schema } from "effect";
import { absurd } from "effect/Function";
import { Type } from "typebox";
import type { Static } from "typebox";
import { checkDomainPolicy } from "./domain-policy";
import { FetchPage } from "./fetch-page";
import type { FetchPageError, FetchPageResult } from "./fetch-page";
import type { FetchProvider } from "./provider-types";
import { appendExpandedPreview, appendExpandHint, getTextContent } from "./render";
import type { RenderTheme } from "./render";
import { FetchRescueProviders } from "./search";
import {
  clampInteger,
  FETCH_TIMEOUT_SECONDS,
  secretsForRedaction,
  WEB_FETCH_FORMATS,
  WebToolsConfig,
} from "./settings";
import type { WebToolsSettings } from "./settings";
import { projectFetchResult, projectProviderFetchedPage, ToolOutputStore } from "./tool-output";
import type { ProviderFetchedPage, ToolOutputStoreError } from "./tool-output";
import type { ToolRuntime } from "./tool-runtime";
import {
  ParsePublicHttpUrlError,
  parsePublicHttpUrl,
  redactUrlCredentialsForDisplay,
} from "./types";
import type { PublicHttpUrl, WebFetchDetails, WebFetchFormat } from "./types";

/** Composition injected into the webfetch tool. */
export type WebFetchToolComposition = {
  /** Non-secret settings, for input defaults and domain policy; keys stay in WebToolsConfig. */
  readonly settings: Pick<WebToolsSettings, "fetch">;
  /** The runtime every fetch runs on. */
  readonly runtime: ToolRuntime<
    FetchPage | FetchRescueProviders | ToolOutputStore | WebToolsConfig
  >;
};

/** Parsed webfetch tool parameters. */
export type WebFetchParams = {
  readonly url: PublicHttpUrl;
  readonly format: WebFetchFormat;
  readonly timeoutSeconds: number;
};

/** The webfetch url parameter is not a usable public http(s) URL. */
export class InvalidFetchUrlInput extends Schema.TaggedError<InvalidFetchUrlInput>()(
  "InvalidFetchUrlInput",
  {
    /** Why the URL was rejected. */
    reason: ParsePublicHttpUrlError,
  },
) {
  /** Safe user-facing description; never echoes the URL itself. */
  override get message(): string {
    return renderUrlParseError(this.reason);
  }
}

/** Expected failures parsing webfetch tool input. */
export type WebFetchInputError = InvalidFetchUrlInput;

/** The whole fetch, rescue included, ran past the tool's deadline. */
class WebFetchTimedOut extends Schema.TaggedError<WebFetchTimedOut>()("WebFetchTimedOut", {
  /** The tool's deadline in whole seconds. */
  timeoutSeconds: Schema.Number,
}) {
  /** Safe user-facing description naming the deadline. */
  override get message(): string {
    return `Web fetch timed out after ${this.timeoutSeconds}s`;
  }
}

/** Every expected failure of one webfetch run, after input parsing and domain policy. */
type WebFetchRunError = FetchPageError | ToolOutputStoreError | WebFetchTimedOut;

/** Statuses that indicate an anti-bot wall worth retrying through a provider's fetch infrastructure. */
const RESCUE_STATUSES = new Set([401, 403, 429]);
/** Below this many characters of converted text an HTML page counts as unusable (JS-only shell). */
const MIN_USABLE_TEXT_LENGTH = 160;

/**
 * Tool parameters. Pi validates and converts arguments against this schema before `execute` runs,
 * so it owns field types, the format enum, and unknown-field rejection.
 */
const WEB_FETCH_PARAMETERS = Type.Object(
  {
    url: Type.String({ description: "The http:// or https:// URL to fetch." }),
    format: Type.Optional(
      StringEnum([...WEB_FETCH_FORMATS], {
        description: "Return format. Defaults to markdown.",
      }),
    ),
    timeout: Type.Optional(
      Type.Number({
        description: `Optional timeout in seconds (${FETCH_TIMEOUT_SECONDS.min}-${FETCH_TIMEOUT_SECONDS.max}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Parse schema-validated parameters into webfetch input. Only semantic work is left here: URL
 * parsing, settings defaults, and timeout clamping.
 */
export function parseWebFetchParams(
  params: Static<typeof WEB_FETCH_PARAMETERS>,
  settings: Pick<WebToolsSettings, "fetch">,
): Result.Result<WebFetchParams, WebFetchInputError> {
  const url = parsePublicHttpUrl(params.url);
  if (Result.isFailure(url)) {
    return Result.fail(new InvalidFetchUrlInput({ reason: url.failure }));
  }

  return Result.succeed({
    url: url.success,
    format: params.format ?? settings.fetch.defaultFormat,
    timeoutSeconds: clampInteger(
      params.timeout ?? Duration.toSeconds(settings.fetch.timeout),
      FETCH_TIMEOUT_SECONDS,
    ),
  });
}

/** Returns true when a fetch outcome justifies the provider-side rescue path. */
export function isRescueEligible(result: Result.Result<FetchPageResult, FetchPageError>): boolean {
  if (Result.isFailure(result)) {
    return (
      result.failure._tag === "HttpStatusRejected" && RESCUE_STATUSES.has(result.failure.status)
    );
  }
  const { body } = result.success;
  return (
    body._tag === "Text" && body.kind === "html" && body.text.trim().length < MIN_USABLE_TEXT_LENGTH
  );
}

/** Create the webfetch pi tool. */
export function createWebFetchTool(composition: WebFetchToolComposition) {
  return {
    name: "webfetch",
    label: "Web Fetch",
    description:
      "Fetch a single URL and return readable markdown, text, raw HTML/source, or an inline raster image.",
    promptSnippet: "Fetch one public URL as markdown, text, html, or an inline raster image",
    promptGuidelines: [
      "Use webfetch when the user provides a URL or after websearch identifies a page to inspect.",
      "Prefer webfetch format=markdown unless the user explicitly wants plain text or raw source.",
    ],
    parameters: WEB_FETCH_PARAMETERS,

    async execute(
      _toolCallId: string,
      params: Static<typeof WEB_FETCH_PARAMETERS>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<WebFetchDetails>,
    ) {
      const parsed = parseWebFetchParams(params, composition.settings);
      if (Result.isFailure(parsed)) {
        throw new Error(parsed.failure.message);
      }

      const policy = checkDomainPolicy(parsed.success.url, {
        allow: composition.settings.fetch.allowDomains,
        deny: composition.settings.fetch.denyDomains,
      });
      if (Result.isFailure(policy)) {
        throw new Error(policy.failure.message);
      }

      const { url, format } = parsed.success;
      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${url}...` }],
        details: { requestedUrl: url, format, bytes: 0 },
      });

      const exit = await composition.runtime.runExit(runWebFetch(parsed.success), signal);
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      if (Cause.hasInterrupts(exit.cause)) {
        throw new Error("Web fetch cancelled");
      }
      const failure = Cause.findError(exit.cause);
      if (Result.isSuccess(failure)) {
        throw new Error(renderWebFetchFailure(failure.success));
      }
      throw Cause.squash(exit.cause);
    },

    renderCall(
      args: { readonly url: string; readonly format?: WebFetchFormat },
      theme: RenderTheme,
    ) {
      let text = theme.fg("toolTitle", theme.bold("webfetch "));
      text += theme.fg("accent", redactUrlCredentialsForDisplay(args.url));
      if (args.format !== undefined && args.format !== "markdown") {
        text += theme.fg("muted", ` (${args.format})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        readonly content: readonly { readonly type: string; readonly text?: string }[];
        readonly details?: WebFetchDetails;
        readonly isError?: boolean;
      },
      options: { readonly expanded: boolean; readonly isPartial: boolean },
      theme: RenderTheme,
    ) {
      if (options.isPartial) {
        return new Text(theme.fg("warning", "Fetching..."), 0, 0);
      }
      if (result.isError === true) {
        return new Text(
          theme.fg("error", `✗ ${getTextContent(result.content) || "Fetch failed"}`),
          0,
          0,
        );
      }

      const { details } = result;
      let text = theme.fg("success", "✓ Fetched") + fetchedBadges(details, theme);
      text = appendExpandHint(text, options.expanded);

      if (options.expanded) {
        if (details?.image === true) {
          text += `\n${theme.fg("dim", `Image URL: ${details.finalUrl ?? ""}`)}`;
        } else {
          text = appendExpandedPreview(text, {
            text: getTextContent(result.content),
            theme,
            maxLines: 12,
            maxColumns: 220,
          });
        }
        if (typeof details?.fullOutputPath === "string") {
          text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  };
}

/** The summary after "✓ Fetched": mime, size, provider and flags. */
function fetchedBadges(details: WebFetchDetails | undefined, theme: RenderTheme): string {
  if (details === undefined) {
    return "";
  }
  let text = "";
  if (details.mime !== undefined && details.mime !== "") {
    text += theme.fg("muted", ` (${details.mime})`);
  }
  if (details.bytes > 0) {
    text += theme.fg("dim", ` ${formatSize(details.bytes)}`);
  }
  if (details.via !== undefined && details.via !== "") {
    text += theme.fg("warning", ` [via ${details.via}]`);
  }
  if (details.truncated === true) {
    text += theme.fg("warning", " [truncated]");
  }
  if (details.image === true) {
    text += theme.fg("muted", " [image]");
  }
  return text;
}

// One fetch under the tool deadline: fetch directly, rescue through a provider when eligible, then
// project the page for Pi.
const runWebFetch = Effect.fnUntraced(
  function* (input: WebFetchParams) {
    const { url, format } = input;
    const fetchPage = yield* FetchPage;
    const config = yield* WebToolsConfig;
    const limits = config.fetch;
    const output = {
      store: yield* ToolOutputStore,
      secrets: secretsForRedaction(config.credentials),
    };
    const result = yield* Effect.result(
      fetchPage.fetch(
        { url, format },
        {
          maxRedirects: limits.maxRedirects,
          maxResponseBytes: limits.maxResponseBytes,
          blockPrivateHosts: true,
        },
      ),
    );
    const rescued =
      limits.rescue && format === "markdown" && isRescueEligible(result)
        ? yield* tryProviderRescue(url, yield* FetchRescueProviders)
        : undefined;
    if (rescued !== undefined) {
      return yield* projectProviderFetchedPage(rescued, output);
    }
    return yield* projectFetchResult(yield* Effect.fromResult(result), output);
  },
  (effect, input) =>
    Effect.timeoutOrElse(effect, {
      duration: Duration.seconds(input.timeoutSeconds),
      orElse: () => Effect.fail(new WebFetchTimedOut({ timeoutSeconds: input.timeoutSeconds })),
    }),
);

// Rescue providers are tried in order; a provider that fails just yields nothing.
const tryProviderRescue = Effect.fnUntraced(function* (
  url: PublicHttpUrl,
  providers: readonly FetchProvider[],
): Effect.fn.Return<ProviderFetchedPage | undefined> {
  for (const provider of providers) {
    const markdown = yield* provider.fetchMarkdown(url);
    if (markdown !== undefined) {
      return { provider: provider.name, url, markdown };
    }
  }
  return undefined;
});

// Only the store failure needs context (the tool name); every other failure's message stands alone.
function renderWebFetchFailure(error: WebFetchRunError): string {
  return error._tag === "OutputStoreError"
    ? `Could not save full webfetch output to ${error.path}: ${error.reason}`
    : error.message;
}

function renderUrlParseError(error: ParsePublicHttpUrlError): string {
  switch (error._tag) {
    case "EmptyUrl": {
      return "URL cannot be empty";
    }
    case "UnsupportedUrlProtocol": {
      return error.protocol === undefined
        ? "URL must start with http:// or https://"
        : `Unsupported URL protocol ${error.protocol}; URL must start with http:// or https://`;
    }
    case "InvalidUrl": {
      return "Invalid URL";
    }
    case "UrlCredentialsUnsupported": {
      return "URL credentials are not supported";
    }
    default: {
      return absurd(error);
    }
  }
}
