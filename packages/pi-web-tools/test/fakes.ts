import type { McpClient, McpToolCallResult } from "../mcp";
import type {
  PublicWebClient,
  PublicWebError,
  PublicWebRequest,
  PublicWebResponse,
} from "../network";
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResponse,
} from "../provider-http";
import type { ProviderError } from "../provider-types";
import type { Result } from "../result";
import { ok } from "../result";
import { parseSettings } from "../settings";
import type { WebToolsSettings } from "../settings";
import { parsePublicHttpUrl, parseSearchQuery } from "../types";
import type { PublicHttpUrl, SearchQuery } from "../types";

/** The WHATWG name of UTF-8, which parsed charsets and decoders report. */
export const UTF8 = "utf-8";

/** Parse a test URL through the real parser; an invalid one is a broken test. */
export function publicUrl(input: string): PublicHttpUrl {
  const parsed = parsePublicHttpUrl(input);
  if (parsed._tag === "err") {
    throw new Error(`Invalid test URL: ${input}`);
  }
  return parsed.value;
}

/** Parse test settings from an environment through the real parser; invalid ones are a broken test. */
export function settingsFrom(
  environment: Readonly<Record<string, string | undefined>> = {},
): WebToolsSettings {
  const parsed = parseSettings(environment);
  if (parsed._tag === "err") {
    throw new Error(`Invalid test settings: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** Parse a test query through the real parser; an invalid one is a broken test. */
export function searchQuery(input: string): SearchQuery {
  const parsed = parseSearchQuery(input);
  if (parsed._tag === "err") {
    throw new Error(`Invalid test query: ${input}`);
  }
  return parsed.value;
}

/** Recorded MCP call for assertions. */
type RecordedMcpCall = {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
};

/** Fake MCP client returning programmed results in order. */
export function fakeMcpClient(results: readonly Result<McpToolCallResult, ProviderError>[]) {
  const calls: RecordedMcpCall[] = [];
  let index = 0;
  const client: McpClient = {
    callTool: async (name, args) => {
      calls.push({ name, args });
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result ?? ok({ text: [] });
    },
  };
  return { client, calls };
}

/** Fake provider HTTP client returning programmed results in order. */
export function fakeProviderHttp(results: readonly Result<ProviderHttpResponse, ProviderError>[]) {
  const requests: ProviderHttpRequest[] = [];
  let index = 0;
  const respond = (request: ProviderHttpRequest) => {
    requests.push(request);
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result ?? ok({ bodyText: "{}" });
  };
  const client: ProviderHttpClient = {
    postJson: async (request) => respond(request),
    getJson: async (request) => respond(request),
  };
  return { client, requests };
}

/** Fake public web client returning a programmed result. */
export function fakePublicWeb(result: Result<PublicWebResponse, PublicWebError>) {
  const requests: PublicWebRequest[] = [];
  const client: PublicWebClient = {
    get: async (request) => {
      requests.push(request);
      return result;
    },
  };
  return { client, requests };
}

/** Extract the joined text of a pi tool result for assertions. */
export function textOf(result: {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

/** Render a pi-tui Text component to a string for assertions. */
export function renderText(component: {
  readonly render: (width: number) => readonly string[];
}): string {
  return component.render(200).join("\n");
}

/** Build a text public-web response. */
export function textWebResponse(
  text: string,
  contentType = "text/html; charset=utf-8",
): PublicWebResponse {
  return {
    requestedUrl: publicUrl("https://example.com/page"),
    finalUrl: publicUrl("https://example.com/page"),
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: Buffer.from(text, "utf8"),
  };
}
