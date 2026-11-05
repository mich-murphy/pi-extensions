import { Effect, Result } from "effect";
import { Value } from "typebox/value";
import { assert, describe, expect, test } from "vitest";
import { HttpStatusRejected } from "../network";
import type { PublicWebError, PublicWebResponse } from "../network";
import type { FetchProvider, SearchProvider } from "../provider-types";
import {
  projectFetchResult,
  STRUCTURED_OUTPUT_MAX_BYTES,
  WEB_FETCH_OUTPUT_SCHEMA,
  WEB_SEARCH_OUTPUT_SCHEMA,
} from "../tool-output";
import { createWebFetchTool } from "../webfetch";
import { createWebSearchTool } from "../websearch";
import {
  fetchPageWith,
  fakePublicWeb,
  liveToolOutputStore,
  publicUrl,
  redactorFor,
  settingsFrom,
  textWebResponse,
  toolRuntimeWith,
} from "./fakes";

const SECRET = "sekrit-key";
const SETTINGS = settingsFrom({ EXA_API_KEY: SECRET });

function fetchTool(
  outcome: Result.Result<PublicWebResponse, PublicWebError>,
  fetchProviders: readonly FetchProvider[] = [],
) {
  return createWebFetchTool({
    settings: SETTINGS,
    redactText: redactorFor(SECRET),
    runtime: toolRuntimeWith({
      settings: SETTINGS,
      secret: SECRET,
      fetchPage: fetchPageWith(fakePublicWeb(outcome).client),
      fetchProviders,
    }),
  });
}

function searchTool(snippet: string) {
  const provider: SearchProvider = {
    name: "exa",
    transport: "mcp",
    search: () =>
      Effect.succeed([
        {
          title: "A title",
          url: publicUrl("https://example.com/"),
          snippet,
          publishedAt: "2026-01-01",
          source: "Example",
          score: 0.5,
        },
      ]),
  };
  return createWebSearchTool({
    settings: SETTINGS,
    redactText: redactorFor(SECRET),
    runtime: toolRuntimeWith({ settings: SETTINGS, secret: SECRET, searchProviders: [provider] }),
  });
}

function jsonBody(bytes: number): string {
  return `{"data":"${"x".repeat(bytes - 11)}"}`;
}

function textPage(structured: unknown): { content: string; truncated: boolean } {
  assert(typeof structured === "object" && structured !== null);
  assert("content" in structured && typeof structured.content === "string");
  assert("truncated" in structured && typeof structured.truncated === "boolean");
  return { content: structured.content, truncated: structured.truncated };
}

function plainResponse(body: string, url = "https://example.com/page"): PublicWebResponse {
  return { ...textWebResponse(body, "text/plain"), finalUrl: publicUrl(url) };
}

describe("webfetch structuredContent", () => {
  test("a text page matches the output schema", async () => {
    const result = await fetchTool(Result.succeed(plainResponse("hello page"))).execute("t", {
      url: "https://example.com/page",
    });

    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toStrictEqual({
      url: "https://example.com/page",
      status: 200,
      mime_type: "text/plain",
      format: "markdown",
      bytes: 10,
      content: "hello page",
      truncated: false,
    });
  });

  test("an image matches the output schema in the shape Pi's read tool uses", async () => {
    const projected = await Effect.runPromise(
      Effect.result(
        projectFetchResult(
          {
            meta: {
              requestedUrl: publicUrl("https://example.com/i.png"),
              finalUrl: publicUrl("https://example.com/i.png"),
              format: "markdown",
              status: 200,
              mime: "image/png",
              contentType: "image/png",
              bytes: 4,
            },
            body: { _tag: "Image", data: Buffer.from([1, 2, 3, 4]) },
          },
          { store: liveToolOutputStore(), secrets: [] },
        ),
      ),
    );
    assert(Result.isSuccess(projected));

    const { structuredContent } = projected.success;
    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, structuredContent)).toBe(true);
    expect(structuredContent).toMatchObject({
      type: "image",
      data: "AQIDBA==",
      mimeType: "image/png",
    });
  });

  test("a provider-rescued page matches the output schema and names the provider", async () => {
    const provider: FetchProvider = {
      name: "exa",
      fetchMarkdown: () => Effect.succeed("# Rescued content"),
    };
    const result = await fetchTool(
      Result.fail(new HttpStatusRejected({ status: 403, statusText: "Forbidden" })),
      [provider],
    ).execute("t", { url: "https://blocked.example" });

    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toStrictEqual({
      url: "https://blocked.example/",
      format: "markdown",
      bytes: 17,
      content: "# Rescued content",
      truncated: false,
      via: "exa",
    });
  });

  test("a single-line body over the model limit keeps its full content and a spill path", async () => {
    const body = jsonBody(200_000);
    const result = await fetchTool(Result.succeed(plainResponse(body))).execute("t", {
      url: "https://example.com/page",
    });

    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toMatchObject({
      content: body,
      truncated: false,
      full_output_path: result.details.fullOutputPath,
    });
    expect(result.details.fullOutputPath).toBeTypeOf("string");
  });

  test("a body over 1 MiB is cut at 1 MiB and flagged truncated", async () => {
    const body = jsonBody(STRUCTURED_OUTPUT_MAX_BYTES + 1000);
    const result = await fetchTool(Result.succeed(plainResponse(body))).execute("t", {
      url: "https://example.com/page",
    });

    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    const structured = textPage(result.structuredContent);
    expect(structured.truncated).toBe(true);
    expect(Buffer.byteLength(structured.content, "utf8")).toBe(STRUCTURED_OUTPUT_MAX_BYTES);
    expect(body.startsWith(structured.content)).toBe(true);
  });

  test("never splits a multibyte character at the limit", async () => {
    const body = `x${"é".repeat(STRUCTURED_OUTPUT_MAX_BYTES)}`;
    const result = await fetchTool(Result.succeed(plainResponse(body))).execute("t", {
      url: "https://example.com/page",
    });

    const structured = textPage(result.structuredContent);
    expect(structured.truncated).toBe(true);
    expect(structured.content).not.toContain("�");
    expect(Buffer.byteLength(structured.content, "utf8")).toBeLessThanOrEqual(
      STRUCTURED_OUTPUT_MAX_BYTES,
    );
  });

  test("redacts secrets in the page body and the final URL", async () => {
    const result = await fetchTool(
      Result.succeed(plainResponse(`token=${SECRET} end`, `https://example.com/p?k=${SECRET}`)),
    ).execute("t", { url: "https://example.com/page" });

    expect(JSON.stringify(result.structuredContent)).not.toContain(SECRET);
    expect(result.structuredContent).toMatchObject({
      url: "https://example.com/p?k=[redacted]",
      content: "token=[redacted] end",
    });
  });

  test("redacts secrets in rescued content and the requested URL", async () => {
    const provider: FetchProvider = {
      name: "exa",
      fetchMarkdown: () => Effect.succeed(`leaked ${SECRET}`),
    };
    const result = await fetchTool(
      Result.fail(new HttpStatusRejected({ status: 403, statusText: "Forbidden" })),
      [provider],
    ).execute("t", { url: `https://blocked.example/?k=${SECRET}` });

    expect(JSON.stringify(result.structuredContent)).not.toContain(SECRET);
  });
});

describe("websearch structuredContent", () => {
  test("matches the output schema", async () => {
    const result = await searchTool("a snippet").execute("t", { query: "pi agent" });

    expect(Value.Check(WEB_SEARCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    expect(result.structuredContent).toStrictEqual({
      query: "pi agent",
      provider: "exa",
      results: [
        {
          title: "A title",
          url: "https://example.com/",
          snippet: "a snippet",
          published_at: "2026-01-01",
          source: "Example",
          score: 0.5,
        },
      ],
    });
  });

  test("redacts secrets in snippets and the query", async () => {
    const result = await searchTool(`key ${SECRET}`).execute("t", { query: `find ${SECRET}` });

    expect(JSON.stringify(result.structuredContent)).not.toContain(SECRET);
    expect(result.structuredContent).toMatchObject({ query: "find [redacted]" });
  });
});
