import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import { assert, describe, expect, test } from "vitest";
import { FetchPage } from "../fetch-page";
import type { PublicWebError } from "../network";
import type { FetchProvider } from "../provider-types";
import { err, ok } from "../result";
import { tempFileToolOutputStore } from "../tool-output";
import { createWebFetchTool, isRescueEligible, parseWebFetchParams } from "../webfetch";
import {
  fakePublicWeb,
  publicUrl,
  renderText,
  settingsFrom,
  textOf,
  textWebResponse,
} from "./fakes";

const DEFAULT_SETTINGS = settingsFrom();
const FETCH_OPTIONS = { maxRedirects: 5, maxResponseBytes: 1024 * 1024, blockPrivateHosts: true };

function fakeFetchProvider(
  name: "exa" | "parallel",
  markdown: string | undefined,
): FetchProvider & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    fetchMarkdown: async (url) => {
      calls.push(url);
      return markdown;
    },
  };
}

function fetchPageFor(outcome: Parameters<typeof fakePublicWeb>[0]): FetchPage {
  return new FetchPage(fakePublicWeb(outcome).client);
}

function articleResponse(paragraph: string) {
  return textWebResponse(`<html><body><article><p>${paragraph}</p></article></body></html>`);
}

function makeTool(
  env: Readonly<Record<string, string>>,
  fetchOutcome: Parameters<typeof fakePublicWeb>[0],
  providers: readonly FetchProvider[],
) {
  return createWebFetchTool({
    settings: settingsFrom(env),
    fetchPage: fetchPageFor(fetchOutcome),
    fetchProviders: providers,
    outputStore: tempFileToolOutputStore,
    secrets: ["sekrit-key"],
  });
}

function inputErrorFor(url: string): string {
  const parsed = parseWebFetchParams({ url }, DEFAULT_SETTINGS);
  assert(parsed._tag === "err");
  return parsed.error.message;
}

function timeoutFor(timeout: number): number {
  const parsed = parseWebFetchParams({ url: "https://example.com", timeout }, DEFAULT_SETTINGS);
  assert(parsed._tag === "ok");
  return parsed.value.timeoutSeconds;
}

async function fetchShort(contentType: string) {
  return fetchPageFor(ok(textWebResponse("<p>hi</p>", contentType))).fetch(
    { url: publicUrl("https://short.example"), format: "markdown" },
    FETCH_OPTIONS,
  );
}

describe("webfetch parameter schema", () => {
  const tool = makeTool({}, ok(textWebResponse("x")), []);

  function validate(args: unknown): unknown {
    return validateToolArguments(tool, {
      type: "toolCall",
      id: "t",
      name: tool.name,
      arguments: args as JsonObject,
    });
  }

  test("rejects structurally invalid arguments before execute runs", () => {
    expect(() => validate({ url: "https://example.com", bogus: 1 })).toThrow("bogus");
    expect(() => validate({ url: "https://example.com", format: "yaml" })).toThrow("format");
    expect(() => validate({ url: "https://example.com", timeout: "soon" })).toThrow("timeout");
    expect(() => validate({})).toThrow("url");
    expect(() => validate("nope")).toThrow("must be object");
  });

  test("converts numeric strings, so a string timeout reaches execute as a number", () => {
    expect(validate({ url: "https://example.com", timeout: "30" })).toStrictEqual({
      url: "https://example.com",
      timeout: 30,
    });
  });
});

describe("parseWebFetchParams", () => {
  test("parses a minimal url with settings defaults", () => {
    expect(parseWebFetchParams({ url: " https://example.com " }, DEFAULT_SETTINGS)).toStrictEqual(
      ok({ url: "https://example.com/", format: "markdown", timeoutSeconds: 30 }),
    );
  });

  test("rejects empty, non-http, and credentialed URLs", () => {
    expect(inputErrorFor("   ")).toBe("URL cannot be empty");
    expect(inputErrorFor("ftp://example.com")).toBe("URL must start with http:// or https://");
    expect(inputErrorFor("https://user:pass@example.com")).toBe(
      "URL credentials are not supported",
    );
  });

  test("clamps and rounds the timeout", () => {
    expect(timeoutFor(9999)).toBe(120);
    expect(timeoutFor(0)).toBe(1);
    expect(timeoutFor(4.6)).toBe(5);
  });
});

describe("isRescueEligible", () => {
  test("flags bot-wall statuses", () => {
    for (const status of [401, 403, 429]) {
      expect(isRescueEligible(err({ _tag: "HttpStatusRejected", status, statusText: "" }))).toBe(
        true,
      );
    }
    expect(isRescueEligible(err({ _tag: "HttpStatusRejected", status: 500, statusText: "" }))).toBe(
      false,
    );
    expect(isRescueEligible(err({ _tag: "PrivateIpBlocked" }))).toBe(false);
  });

  test("flags unusable HTML shells but not real content", async () => {
    const thinShell = fetchPageFor(
      ok(textWebResponse('<html><body><div id="app"></div></body></html>')),
    );
    const thin = await thinShell.fetch(
      { url: publicUrl("https://spa.example"), format: "markdown" },
      FETCH_OPTIONS,
    );
    expect(isRescueEligible(thin)).toBe(true);

    const substantial = "substantial content ".repeat(40);
    const realPage = fetchPageFor(ok(articleResponse(substantial)));
    const real = await realPage.fetch(
      { url: publicUrl("https://blog.example"), format: "markdown" },
      FETCH_OPTIONS,
    );
    expect(isRescueEligible(real)).toBe(false);
  });

  test("judges short bodies by content kind, so only HTML shells qualify", async () => {
    expect(isRescueEligible(await fetchShort("application/xhtml+xml"))).toBe(true);
    expect(isRescueEligible(await fetchShort("text/plain"))).toBe(false);
    expect(isRescueEligible(await fetchShort("image/png"))).toBe(false);
  });
});

describe("webfetch rendering", () => {
  const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value };
  const fetchPage = fetchPageFor(ok(textWebResponse("x")));
  const tool = createWebFetchTool({
    settings: DEFAULT_SETTINGS,
    fetchPage,
    fetchProviders: [],
    outputStore: tempFileToolOutputStore,
    secrets: [],
  });

  test("renderCall shows the url and redacts credentials", () => {
    const component = tool.renderCall(
      { url: "https://user:pass@example.com/x", format: "text" },
      theme,
    );
    const rendered = renderText(component);
    expect(rendered).toContain("webfetch");
    expect(rendered).not.toContain("pass");
    expect(rendered).toContain("(text)");
  });

  test("renderResult handles partial, error, and expanded states", () => {
    expect(
      renderText(tool.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme)),
    ).toContain("Fetching");
    expect(
      renderText(
        tool.renderResult(
          { content: [{ type: "text", text: "boom" }], isError: true },
          { expanded: false, isPartial: false },
          theme,
        ),
      ),
    ).toContain("boom");
    const expanded = renderText(
      tool.renderResult(
        {
          content: [{ type: "text", text: "body" }],
          details: {
            requestedUrl: "https://example.com",
            finalUrl: "https://example.com",
            format: "markdown" as const,
            status: 200,
            mime: "text/html",
            contentType: "text/html",
            bytes: 100,
            via: "exa",
            truncated: true,
            fullOutputPath: "/tmp/x",
          },
        },
        { expanded: true, isPartial: false },
        theme,
      ),
    );
    expect(expanded).toContain("via exa");
    expect(expanded).toContain("Full output: /tmp/x");
    expect(expanded).toContain("body");
  });
});

describe("webfetch tool", () => {
  test("fetches and converts directly without rescue", async () => {
    const realContent = "real content ".repeat(40);
    const tool = makeTool({}, ok(articleResponse(realContent)), []);
    const result = await tool.execute("t1", { url: "https://example.com" });
    expect(result.details.via).toBeUndefined();
    expect(textOf(result)).toContain("real content");
  });

  test("rescues bot-blocked pages through the provider chain and flags it", async () => {
    const provider = fakeFetchProvider("exa", "# Rescued content\n\nThis came from the provider.");
    const tool = makeTool(
      {},
      err({ _tag: "HttpStatusRejected", status: 403, statusText: "Forbidden" }),
      [provider],
    );

    const result = await tool.execute("t1", { url: "https://blocked.example" });
    expect(textOf(result)).toContain("Direct fetch was blocked");
    expect(textOf(result)).toContain("Rescued content");
    // A rescue records no HTTP facts it did not observe.
    expect(result.details).toStrictEqual({
      requestedUrl: "https://blocked.example/",
      format: "markdown",
      bytes: 47,
      via: "exa",
      truncated: false,
    });
  });

  test("rescues JS-only HTML shells", async () => {
    const provider = fakeFetchProvider("parallel", "# Rendered by the provider");
    const tool = makeTool(
      {},
      ok(textWebResponse('<html><body><div id="app"></div></body></html>')),
      [fakeFetchProvider("exa", undefined), provider],
    );

    const result = await tool.execute("t1", { url: "https://spa.example" });
    expect(result.details.via).toBe("parallel");
    expect(textOf(result)).toContain("Rendered by the provider");
  });

  test("returns the direct result when no provider can rescue it", async () => {
    const tool = makeTool(
      {},
      ok(textWebResponse('<html><body><div id="app"></div></body></html>')),
      [fakeFetchProvider("exa", undefined)],
    );

    const result = await tool.execute("t1", { url: "https://spa.example" });
    expect(result.details.via).toBeUndefined();
    expect(result.details.status).toBe(200);
  });

  test("does not rescue when PI_WEB_TOOLS_FETCH_RESCUE=off", async () => {
    const provider = fakeFetchProvider("exa", "# Rescued");
    const tool = makeTool(
      { PI_WEB_TOOLS_FETCH_RESCUE: "off" },
      err({ _tag: "HttpStatusRejected", status: 403, statusText: "" }),
      [provider],
    );

    await expect(tool.execute("t1", { url: "https://blocked.example" })).rejects.toThrow(
      "Request failed (403)",
    );
    expect(provider.calls).toHaveLength(0);
  });

  test("does not rescue non-markdown formats", async () => {
    const provider = fakeFetchProvider("exa", "# Rescued");
    const tool = makeTool({}, err({ _tag: "HttpStatusRejected", status: 403, statusText: "" }), [
      provider,
    ]);

    await expect(
      tool.execute("t1", { url: "https://blocked.example", format: "html" }),
    ).rejects.toThrow("Request failed");
    expect(provider.calls).toHaveLength(0);
  });

  test("does not rescue SSRF blocks", async () => {
    const provider = fakeFetchProvider("exa", "# Rescued");
    const tool = makeTool({}, err({ _tag: "PrivateIpBlocked" }), [provider]);

    await expect(tool.execute("t1", { url: "https://internal.example" })).rejects.toThrow(
      "Blocked private or local IP",
    );
    expect(provider.calls).toHaveLength(0);
  });

  test("redacts configured secrets from fetched content", async () => {
    const provider = fakeFetchProvider("exa", "leaked sekrit-key in page");
    const tool = makeTool({}, err({ _tag: "HttpStatusRejected", status: 403, statusText: "" }), [
      provider,
    ]);

    const result = await tool.execute("t1", { url: "https://blocked.example" });
    expect(textOf(result)).toContain("[redacted]");
    expect(textOf(result)).not.toContain("sekrit-key");
  });

  test("enforces the domain deny policy before fetching", async () => {
    const tool = makeTool(
      { PI_WEB_TOOLS_FETCH_DENY_DOMAINS: "evil.example" },
      ok(textWebResponse("x")),
      [],
    );
    await expect(tool.execute("t1", { url: "https://sub.evil.example/page" })).rejects.toThrow(
      "denied",
    );
  });

  test("enforces the domain allow policy", async () => {
    const allowedContent = "allowed content ".repeat(40);
    const tool = makeTool(
      { PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS: "docs.example.com" },
      ok(articleResponse(allowedContent)),
      [],
    );
    await expect(tool.execute("t1", { url: "https://other.example" })).rejects.toThrow(
      "not in the webfetch allowed domains",
    );
    const allowed = await tool.execute("t1", { url: "https://docs.example.com" });
    expect(textOf(allowed)).toContain("allowed content");
  });
});

describe("webfetch error messages", () => {
  test.each<[PublicWebError, string]>([
    [{ _tag: "PublicWebRequestFailed" }, "Request failed"],
    [{ _tag: "PublicWebCancelled" }, "Web fetch cancelled"],
    [{ _tag: "PublicWebTimedOut", timeoutSeconds: 7 }, "Web fetch timed out after 7s"],
    [{ _tag: "PrivateHostBlocked" }, "Blocked private or local host"],
    [{ _tag: "UrlCredentialsUnsupported" }, "URL credentials are not supported"],
    [{ _tag: "RedirectLocationMissing" }, "Redirect response was missing a Location header"],
    [{ _tag: "RedirectLocationInvalid" }, "Redirect response had an invalid Location header"],
    [{ _tag: "RedirectLimitExceeded", maxRedirects: 5 }, "Too many redirects while fetching URL"],
    [
      { _tag: "RedirectProtocolUnsupported", protocol: "ftp:" },
      "Redirected to unsupported protocol",
    ],
    [{ _tag: "HttpStatusRejected", status: 500, statusText: "Oops" }, "Request failed (500 Oops)"],
    [{ _tag: "ResponseTooLarge", maxBytes: 5 * 1024 * 1024 }, "Response too large (5MB limit)"],
  ])("renders %o as a safe message", async (error, message) => {
    const tool = makeTool({}, err(error), []);
    await expect(tool.execute("t1", { url: "https://example.com" })).rejects.toThrow(message);
  });

  test("renders unsupported binary content with its mime type", async () => {
    const tool = makeTool({}, ok(textWebResponse("PK", "application/zip")), []);
    await expect(tool.execute("t1", { url: "https://example.com" })).rejects.toThrow(
      "Unsupported binary content (application/zip). Try a more text-oriented URL.",
    );
  });

  test("surfaces parse errors as tool errors", async () => {
    const tool = makeTool({}, ok(textWebResponse("x")), []);
    await expect(tool.execute("t1", { url: "not a url" })).rejects.toThrow(
      "URL must start with http",
    );
  });
});
