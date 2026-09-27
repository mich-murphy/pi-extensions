import { StringEnum } from "@earendil-works/pi-ai";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { checkDomainPolicy, type DomainPolicyError } from "./domain-policy";
import type { FetchPage, FetchPageError, FetchPageResult } from "./fetch-page";
import { createOperationSignal, isOperationTimeoutError } from "./network";
import type { FetchProvider } from "./provider-types";
import { appendExpandedPreview, appendExpandHint, getTextContent } from "./render";
import { err, ok, type Result } from "./result";
import {
  clampInteger,
  FETCH_TIMEOUT_SECONDS,
  WEB_FETCH_FORMATS,
  type WebToolsSettings,
} from "./settings";
import {
  type PiToolResult,
  type ProviderFetchedPage,
  projectFetchResult,
  projectProviderFetchedPage,
  type ToolOutputStore,
} from "./tool-output";
import {
  type PublicHttpUrl,
  parsePublicHttpUrl,
  redactUrlCredentialsForDisplay,
  type WebFetchDetails,
  type WebFetchFormat,
} from "./types";

/** Composition injected into the webfetch tool. */
export interface WebFetchToolComposition {
  readonly settings: WebToolsSettings;
  readonly fetchPage: FetchPage;
  readonly fetchProviders: readonly FetchProvider[];
  readonly outputStore: ToolOutputStore;
  readonly secrets: readonly (string | undefined)[];
}

/** Parsed webfetch tool parameters. */
export interface WebFetchParams {
  readonly url: PublicHttpUrl;
  readonly format: WebFetchFormat;
  readonly timeoutSeconds: number;
}

/** Expected failures parsing webfetch tool input. */
export type WebFetchInputError = { readonly _tag: "InvalidToolInput"; readonly message: string };

interface RenderTheme {
  fg(name: string, value: string): string;
  bold(value: string): string;
}

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
  settings: WebToolsSettings,
): Result<WebFetchParams, WebFetchInputError> {
  const url = parsePublicHttpUrl(params.url);
  if (url._tag === "err") {
    return err({ _tag: "InvalidToolInput", message: renderUrlParseError(url.error) });
  }

  return ok({
    url: url.value,
    format: params.format ?? settings.fetch.defaultFormat,
    timeoutSeconds: clampInteger(
      params.timeout ?? settings.fetch.timeoutSeconds,
      FETCH_TIMEOUT_SECONDS,
    ),
  });
}

/** Returns true when a fetch outcome justifies the provider-side rescue path. */
export function isRescueEligible(result: Result<FetchPageResult, FetchPageError>): boolean {
  if (result._tag === "err") {
    return result.error._tag === "HttpStatusRejected" && RESCUE_STATUSES.has(result.error.status);
  }
  const { body } = result.value;
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
      onUpdate?: (update: PiToolResult<WebFetchDetails>) => void,
    ) {
      const parsed = parseWebFetchParams(params, composition.settings);
      if (parsed._tag === "err") {
        throw new Error(parsed.error.message);
      }

      const policy = checkDomainPolicy(parsed.value.url, {
        allow: composition.settings.fetch.allowDomains,
        deny: composition.settings.fetch.denyDomains,
      });
      if (policy._tag === "err") {
        throw new Error(renderDomainPolicyError(policy.error));
      }

      const composed = createOperationSignal(parsed.value.timeoutSeconds * 1_000, signal);
      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${parsed.value.url}...` }],
        details: { requestedUrl: parsed.value.url, format: parsed.value.format, bytes: 0 },
      });

      try {
        const result = await composition.fetchPage.fetch(
          { url: parsed.value.url, format: parsed.value.format },
          {
            signal: composed.signal,
            maxRedirects: composition.settings.fetch.maxRedirects,
            maxResponseBytes: composition.settings.fetch.maxResponseBytes,
            blockPrivateHosts: true,
          },
        );

        const rescued =
          composition.settings.fetch.rescue &&
          parsed.value.format === "markdown" &&
          isRescueEligible(result)
            ? await tryProviderRescue(parsed.value.url, composition, composed.signal)
            : undefined;

        if (rescued) {
          const projected = await projectProviderFetchedPage(rescued, {
            store: composition.outputStore,
            secrets: composition.secrets,
          });
          if (projected._tag === "err") {
            throw new Error("Failed to write full webfetch output");
          }
          return projected.value;
        }

        if (result._tag === "err") {
          throw toWebFetchError(result.error, parsed.value.timeoutSeconds, signal, composed.signal);
        }

        const projected = await projectFetchResult(result.value, {
          store: composition.outputStore,
          secrets: composition.secrets,
        });
        if (projected._tag === "err") {
          throw new Error("Failed to write full webfetch output");
        }
        return projected.value;
      } finally {
        composed.cleanup();
      }
    },

    renderCall(args: { url: string; format?: WebFetchFormat }, theme: RenderTheme) {
      let text = theme.fg("toolTitle", theme.bold("webfetch "));
      text += theme.fg("accent", redactUrlCredentialsForDisplay(args.url));
      if (args.format && args.format !== "markdown") {
        text += theme.fg("muted", ` (${args.format})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(
      result: {
        content: Array<{ type: string; text?: string }>;
        details?: WebFetchDetails;
        isError?: boolean;
      },
      options: { expanded: boolean; isPartial: boolean },
      theme: RenderTheme,
    ) {
      if (options.isPartial) {
        return new Text(theme.fg("warning", "Fetching..."), 0, 0);
      }
      if (result.isError) {
        return new Text(
          theme.fg("error", `✗ ${getTextContent(result.content) || "Fetch failed"}`),
          0,
          0,
        );
      }

      const details = result.details;
      let text = theme.fg("success", "✓ Fetched");
      if (details?.mime) {
        text += theme.fg("muted", ` (${details.mime})`);
      }
      if (details?.bytes) {
        text += theme.fg("dim", ` ${formatSize(details.bytes)}`);
      }
      if (details?.via) {
        text += theme.fg("warning", ` [via ${details.via}]`);
      }
      if (details?.truncated === true) {
        text += theme.fg("warning", " [truncated]");
      }
      if (details?.image === true) {
        text += theme.fg("muted", " [image]");
      }
      text = appendExpandHint(text, options.expanded);

      if (options.expanded) {
        if (details?.image === true) {
          text += `\n${theme.fg("dim", `Image URL: ${details.finalUrl ?? ""}`)}`;
        } else {
          text = appendExpandedPreview(text, getTextContent(result.content), theme, {
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

async function tryProviderRescue(
  url: PublicHttpUrl,
  composition: WebFetchToolComposition,
  signal: AbortSignal,
): Promise<ProviderFetchedPage | undefined> {
  for (const provider of composition.fetchProviders) {
    const markdown = await provider.fetchMarkdown(url, { signal });
    if (markdown !== undefined) {
      return { provider: provider.name, url, markdown };
    }
  }
  return undefined;
}

function toWebFetchError(
  error: FetchPageError,
  timeoutSeconds: number,
  outerSignal: AbortSignal | undefined,
  operationSignal: AbortSignal,
): Error {
  if (outerSignal?.aborted) {
    return new Error("Web fetch cancelled");
  }
  if (isOperationTimeoutError(operationSignal.reason)) {
    return new Error(`Web fetch timed out after ${timeoutSeconds}s`);
  }
  return new Error(renderFetchPageError(error));
}

/** Render a fetch failure as a safe user-facing message (no URLs, no causes, no response bodies). */
function renderFetchPageError(error: FetchPageError): string {
  switch (error._tag) {
    case "PublicWebRequestFailed":
      return "Request failed";
    case "PublicWebCancelled":
      return "Web fetch cancelled";
    case "PublicWebTimedOut":
      return `Web fetch timed out after ${error.timeoutSeconds}s`;
    case "PrivateHostBlocked":
      return "Blocked private or local host";
    case "PrivateIpBlocked":
      return "Blocked private or local IP address";
    case "UrlCredentialsUnsupported":
      return "URL credentials are not supported";
    case "RedirectLocationMissing":
      return "Redirect response was missing a Location header";
    case "RedirectLocationInvalid":
      return "Redirect response had an invalid Location header";
    case "RedirectLimitExceeded":
      return "Too many redirects while fetching URL";
    case "RedirectProtocolUnsupported":
      return "Redirected to unsupported protocol";
    case "HttpStatusRejected":
      return `Request failed (${error.status}${error.statusText ? ` ${error.statusText}` : ""})`;
    case "ResponseTooLarge":
      return `Response too large (${Math.floor(error.maxBytes / (1024 * 1024))}MB limit)`;
    case "UnsupportedBinaryContent":
      return `Unsupported binary content${error.mime ? ` (${error.mime})` : ""}. Try a more text-oriented URL.`;
    case "HtmlConversionFailed":
      return "HTML conversion failed";
  }
}

function renderDomainPolicyError(error: DomainPolicyError): string {
  switch (error._tag) {
    case "DomainDenied":
      return `Fetching from ${error.hostname} is denied by the webfetch domain policy`;
    case "DomainNotAllowed":
      return `Fetching from ${error.hostname} is not in the webfetch allowed domains list`;
  }
}

function renderUrlParseError(error: { readonly _tag: string }): string {
  switch (error._tag) {
    case "EmptyUrl":
      return "URL cannot be empty";
    case "UnsupportedUrlProtocol":
      return "URL must start with http:// or https://";
    case "InvalidUrl":
      return "Invalid URL";
    case "UrlCredentialsUnsupported":
      return "URL credentials are not supported";
    default:
      return "Invalid URL";
  }
}
