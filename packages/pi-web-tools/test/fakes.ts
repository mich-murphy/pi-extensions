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

/** Recorded MCP call for assertions. */
interface RecordedMcpCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** Fake MCP client returning programmed results in order. */
export function fakeMcpClient(results: Array<Result<McpToolCallResult, ProviderError>>) {
  const calls: RecordedMcpCall[] = [];
  let index = 0;
  const client: McpClient = {
    callTool: (name, args) => {
      calls.push({ name, args });
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve(result ?? ok({ text: [] }));
    },
  };
  return { client, calls };
}

/** Fake provider HTTP client returning programmed results in order. */
export function fakeProviderHttp(results: Array<Result<ProviderHttpResponse, ProviderError>>) {
  const requests: ProviderHttpRequest[] = [];
  let index = 0;
  const client: ProviderHttpClient = {
    postJson: (request) => {
      requests.push(request);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve(result ?? ok({ bodyText: "{}" }));
    },
    getJson: (request) => {
      requests.push(request);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve(result ?? ok({ bodyText: "{}" }));
    },
  };
  return { client, requests };
}

/** Fake public web client returning a programmed result. */
export function fakePublicWeb(result: Result<PublicWebResponse, PublicWebError>) {
  const requests: PublicWebRequest[] = [];
  const client: PublicWebClient = {
    get: (request) => {
      requests.push(request);
      return Promise.resolve(result);
    },
  };
  return { client, requests };
}

/** Extract the joined text of a pi tool result for assertions. */
export function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

/** Render a pi-tui Text component to a string for assertions. */
export function renderText(component: unknown): string {
  if (typeof component === "object" && component !== null && "render" in component) {
    const renderable = component as { render: (width: number) => string[] };
    return renderable.render(200).join("\n");
  }
  return String(component);
}

/** Build a text public-web response. */
export function textWebResponse(
  text: string,
  contentType = "text/html; charset=utf-8",
): PublicWebResponse {
  return {
    requestedUrl: "https://example.com/page" as PublicWebResponse["requestedUrl"],
    finalUrl: "https://example.com/page" as PublicWebResponse["finalUrl"],
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: Buffer.from(text, "utf8"),
  };
}
