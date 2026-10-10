import { Duration, Effect, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import type { FetchPage } from "../fetch-page";
import {
  HttpStatusRejected,
  PrivateHostBlocked,
  PrivateIpBlocked,
  PublicWebRequestFailed,
  RedirectLimitExceeded,
  RedirectLocationInvalid,
  RedirectLocationMissing,
  RedirectProtocolUnsupported,
  ResponseTooLarge,
  UrlCredentialsUnsupported,
} from "../network";
import type { PublicWebClient, PublicWebError } from "../network";
import { ExaMcpFetchProvider } from "../provider-exa";
import { ProviderStatusRejected } from "../provider-types";
import type { FetchProvider } from "../provider-types";
import {
  createWebFetchTool,
  InvalidFetchUrlInput,
  isRescueEligible,
  parseWebFetchParams,
} from "../webfetch";
import {
  fakeMcpClient,
  fakePublicWeb,
  publicUrl,
  renderText,
  settingsFrom,
  settleOnTestClock,
  textOf,
  textWebResponse,
  fetchPageWith,
  toolRuntimeWith,
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
    fetchMarkdown: (url) =>
      Effect.sync(() => {
        calls.push(url);
        return markdown;
      }),
  };
}

function fetchPageFor(outcome: Parameters<typeof fakePublicWeb>[0]): FetchPage["Service"] {
  return fetchPageWith(fakePublicWeb(outcome).client);
}

function articleResponse(paragraph: string) {
  return textWebResponse(`<html><body><article><p>${paragraph}</p></article></body></html>`);
}

function makeTool(
  env: Readonly<Record<string, string>>,
  fetchOutcome: Parameters<typeof fakePublicWeb>[0],
  providers: readonly FetchProvider[],
) {
  const settings = settingsFrom(env);
  return createWebFetchTool({
    settings,
    runtime: toolRuntimeWith({
      settings,
      secret: "sekrit-key",
      fetchPage: fetchPageFor(fetchOutcome),
      fetchProviders: providers,
    }),
  });
}

function inputErrorFor(url: string): string {
  const parsed = parseWebFetchParams({ url }, DEFAULT_SETTINGS);
  assert(Result.isFailure(parsed));
  expect(parsed.failure).toBeInstanceOf(InvalidFetchUrlInput);
  return parsed.failure.message;
}

function timeoutFor(timeout: number): number {
  const parsed = parseWebFetchParams({ url: "https://example.com", timeout }, DEFAULT_SETTINGS);
  assert(Result.isSuccess(parsed));
  return parsed.success.timeoutSeconds;
}

async function fetchShort(contentType: string) {
  const page = fetchPageFor(Result.succeed(textWebResponse("<p>hi</p>", contentType)));
  return Effect.runPromise(
    Effect.result(
      page.fetch({ url: publicUrl("https://short.example"), format: "markdown" }, FETCH_OPTIONS),
    ),
  );
}

/** A public web client whose request never settles until it is interrupted. */
const hangingWeb: PublicWebClient["Service"] = { get: () => Effect.never };

describe("parseWebFetchParams", () => {
  test("parses a minimal url with settings defaults", () => {
    expect(parseWebFetchParams({ url: " https://example.com " }, DEFAULT_SETTINGS)).toStrictEqual(
      Result.succeed({ url: "https://example.com/", format: "markdown", timeoutSeconds: 30 }),
    );
  });

  test("rejects empty, non-http, and credentialed URLs", () => {
    expect(inputErrorFor("   ")).toBe("URL cannot be empty");
    expect(inputErrorFor("ftp://example.com")).toBe(
      "Unsupported URL protocol ftp:; URL must start with http:// or https://",
    );
    expect(inputErrorFor("example.com")).toBe("URL must start with http:// or https://");
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
      expect(
        isRescueEligible(Result.fail(new HttpStatusRejected({ status, statusText: "" }))),
      ).toBe(true);
    }
    expect(
      isRescueEligible(Result.fail(new HttpStatusRejected({ status: 500, statusText: "" }))),
    ).toBe(false);
    expect(isRescueEligible(Result.fail(new PrivateIpBlocked()))).toBe(false);
  });

  test("flags unusable HTML shells but not real content", async () => {
    const thinShell = fetchPageFor(
      Result.succeed(textWebResponse('<html><body><div id="app"></div></body></html>')),
    );
    const thin = await Effect.runPromise(
      Effect.result(
        thinShell.fetch(
          { url: publicUrl("https://spa.example"), format: "markdown" },
          FETCH_OPTIONS,
        ),
      ),
    );
    expect(isRescueEligible(thin)).toBe(true);

    const substantial = "substantial content ".repeat(40);
    const realPage = fetchPageFor(Result.succeed(articleResponse(substantial)));
    const real = await Effect.runPromise(
      Effect.result(
        realPage.fetch(
          { url: publicUrl("https://blog.example"), format: "markdown" },
          FETCH_OPTIONS,
        ),
      ),
    );
    expect(isRescueEligible(real)).toBe(false);
  });

  test("judges short bodies by content kind, so only HTML shells qualify", async () => {
    expect(isRescueEligible(await fetchShort("application/xhtml+xml"))).toBe(true);
    expect(isRescueEligible(await fetchShort("text/plain"))).toBe(false);
    expect(isRescueEligible(await fetchShort("image/png"))).toBe(false);
  });
});

describe("webfetch call rendering", () => {
  const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value };
  const fetchPage = fetchPageFor(Result.succeed(textWebResponse("x")));
  const tool = createWebFetchTool({
    settings: DEFAULT_SETTINGS,
    runtime: toolRuntimeWith({ settings: DEFAULT_SETTINGS, fetchPage }),
  });

  test("never shows URL credentials", () => {
    const component = tool.renderCall(
      { url: "https://user:pass@example.com/x", format: "text" },
      theme,
    );
    const rendered = renderText(component);
    expect(rendered).toContain("webfetch");
    expect(rendered).not.toContain("pass");
    expect(rendered).toContain("(text)");
  });
});

describe("webfetch result rendering", () => {
  const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value };
  const tool = makeTool({}, Result.succeed(textWebResponse("x")), []);
  const meta = {
    requestedUrl: "https://example.com",
    finalUrl: "https://example.com/final",
    format: "markdown" as const,
    status: 200,
    mime: "text/html",
    contentType: "text/html",
    bytes: 2048,
  };
  const render = (
    result: Parameters<typeof tool.renderResult>[0],
    options: { readonly expanded: boolean; readonly isPartial: boolean },
  ) => renderText(tool.renderResult(result, options, theme));

  test("shows progress while fetching and the error text on failure", () => {
    expect(render({ content: [] }, { expanded: false, isPartial: true })).toBe("Fetching...");
    expect(
      render(
        { content: [{ type: "text", text: "Request failed (403)" }], isError: true },
        { expanded: false, isPartial: false },
      ),
    ).toBe("✗ Request failed (403)");
  });

  test("badges a rescued, truncated page and previews it with its spill file when expanded", () => {
    const expanded = render(
      {
        content: [{ type: "text", text: "page body" }],
        details: { ...meta, via: "exa", truncated: true, fullOutputPath: "/tmp/x" },
      },
      { expanded: true, isPartial: false },
    );
    expect(expanded.split("\n")).toStrictEqual([
      "✓ Fetched (text/html) 2.0KB [via exa] [truncated]",
      "page body",
      "Full output: /tmp/x",
    ]);
  });

  test("shows an image's URL instead of a text preview", () => {
    const expanded = render(
      {
        content: [{ type: "text", text: "Fetched image" }],
        details: { ...meta, mime: "image/png", image: true },
      },
      { expanded: true, isPartial: false },
    );
    expect(expanded.split("\n")).toStrictEqual([
      "✓ Fetched (image/png) 2.0KB [image]",
      "Image URL: https://example.com/final",
    ]);
  });

  test("renders a bare success when no details were recorded", () => {
    expect(render({ content: [] }, { expanded: true, isPartial: false })).toBe("✓ Fetched\n");
  });
});

describe("webfetch tool", () => {
  test("fetches and converts directly without rescue", async () => {
    const realContent = "real content ".repeat(40);
    const tool = makeTool({}, Result.succeed(articleResponse(realContent)), []);
    const result = await tool.execute("t1", { url: "https://example.com" });
    expect(result.details.via).toBeUndefined();
    expect(textOf(result)).toContain("real content");
  });

  test("rescues bot-blocked pages through the provider chain and flags it", async () => {
    const provider = fakeFetchProvider("exa", "# Rescued content\n\nThis came from the provider.");
    const tool = makeTool(
      {},
      Result.fail(new HttpStatusRejected({ status: 403, statusText: "Forbidden" })),
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
      Result.succeed(textWebResponse('<html><body><div id="app"></div></body></html>')),
      [fakeFetchProvider("exa", undefined), provider],
    );

    const result = await tool.execute("t1", { url: "https://spa.example" });
    expect(result.details.via).toBe("parallel");
    expect(textOf(result)).toContain("Rendered by the provider");
  });

  test("returns the direct result when no provider can rescue it", async () => {
    const tool = makeTool(
      {},
      Result.succeed(textWebResponse('<html><body><div id="app"></div></body></html>')),
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
      Result.fail(new HttpStatusRejected({ status: 403, statusText: "" })),
      [provider],
    );

    await expect(tool.execute("t1", { url: "https://blocked.example" })).rejects.toThrow(
      "Request failed (403)",
    );
    expect(provider.calls).toHaveLength(0);
  });

  test("does not rescue non-markdown formats", async () => {
    const provider = fakeFetchProvider("exa", "# Rescued");
    const tool = makeTool(
      {},
      Result.fail(new HttpStatusRejected({ status: 403, statusText: "" })),
      [provider],
    );

    await expect(
      tool.execute("t1", { url: "https://blocked.example", format: "html" }),
    ).rejects.toThrow("Request failed");
    expect(provider.calls).toHaveLength(0);
  });

  test("does not rescue SSRF blocks", async () => {
    const provider = fakeFetchProvider("exa", "# Rescued");
    const tool = makeTool({}, Result.fail(new PrivateIpBlocked()), [provider]);

    await expect(tool.execute("t1", { url: "https://internal.example" })).rejects.toThrow(
      "Blocked private or local IP",
    );
    expect(provider.calls).toHaveLength(0);
  });

  test("redacts configured secrets from fetched content", async () => {
    const provider = fakeFetchProvider("exa", "leaked sekrit-key in page");
    const tool = makeTool(
      {},
      Result.fail(new HttpStatusRejected({ status: 403, statusText: "" })),
      [provider],
    );

    const result = await tool.execute("t1", { url: "https://blocked.example" });
    expect(textOf(result)).toContain("[redacted]");
    expect(textOf(result)).not.toContain("sekrit-key");
  });

  test("enforces the domain deny policy before fetching", async () => {
    const tool = makeTool(
      { PI_WEB_TOOLS_FETCH_DENY_DOMAINS: "evil.example" },
      Result.succeed(textWebResponse("x")),
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
      Result.succeed(articleResponse(allowedContent)),
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
    [
      new PublicWebRequestFailed({
        hostname: "example.com",
        cause: new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
      }),
      "Connection refused by example.com",
    ],
    [new PrivateHostBlocked(), "Blocked private or local host"],
    [new UrlCredentialsUnsupported(), "URL credentials are not supported"],
    [new RedirectLocationMissing(), "Redirect response was missing a Location header"],
    [new RedirectLocationInvalid(), "Redirect response had an invalid Location header"],
    [new RedirectLimitExceeded({ maxRedirects: 5 }), "Too many redirects while fetching URL"],
    [new RedirectProtocolUnsupported({ protocol: "ftp:" }), "Redirected to unsupported protocol"],
    [new HttpStatusRejected({ status: 500, statusText: "Oops" }), "Request failed (500 Oops)"],
    [new ResponseTooLarge({ maxBytes: 5 * 1024 * 1024 }), "Response too large (5MB limit)"],
  ])("renders %s as a safe message", async (error, message) => {
    const tool = makeTool({}, Result.fail(error), []);
    await expect(tool.execute("t1", { url: "https://example.com" })).rejects.toThrow(message);
  });

  test("renders unsupported binary content with its mime type", async () => {
    const tool = makeTool({}, Result.succeed(textWebResponse("PK", "application/zip")), []);
    await expect(tool.execute("t1", { url: "https://example.com" })).rejects.toThrow(
      "Unsupported binary content (application/zip). Try a more text-oriented URL.",
    );
  });

  test("surfaces parse errors as tool errors", async () => {
    const tool = makeTool({}, Result.succeed(textWebResponse("x")), []);
    await expect(tool.execute("t1", { url: "not a url" })).rejects.toThrow(
      "URL must start with http",
    );
  });
});

/** A webfetch tool whose direct fetch never settles. */
function hangingTool(providers: readonly FetchProvider[] = []) {
  return createWebFetchTool({
    settings: DEFAULT_SETTINGS,
    runtime: toolRuntimeWith({
      settings: DEFAULT_SETTINGS,
      fetchPage: fetchPageWith(hangingWeb),
      fetchProviders: providers,
    }),
  });
}

describe("webfetch deadline and cancellation", () => {
  test("a fetch outliving the timeout reports the timeout, not a cancellation", async () => {
    const runtime = toolRuntimeWith({
      settings: DEFAULT_SETTINGS,
      fetchPage: fetchPageWith(hangingWeb),
      testClock: true,
    });
    const tool = createWebFetchTool({ settings: DEFAULT_SETTINGS, runtime });
    const outcome = tool.execute("t1", { url: "https://slow.example", timeout: 1 });
    await settleOnTestClock(runtime, Duration.seconds(1), outcome);
    await expect(outcome).rejects.toThrow("Web fetch timed out after 1s");
    await expect(outcome).rejects.not.toThrow("cancelled");
  });

  test("a caller abort reports a cancellation", async () => {
    const controller = new AbortController();
    const outcome = hangingTool().execute(
      "t1",
      { url: "https://slow.example", timeout: 60 },
      controller.signal,
    );
    setTimeout(() => {
      controller.abort();
    }, 10);
    await expect(outcome).rejects.toThrow("Web fetch cancelled");
  });
});

describe("webfetch rescue chain", () => {
  test("a rescue provider whose call fails is skipped, and providers run in order", async () => {
    const { client: failingMcp, calls: failingCalls } = fakeMcpClient([
      Result.fail(new ProviderStatusRejected({ status: 500 })),
    ]);
    const empty = fakeFetchProvider("parallel", undefined);
    const answering = fakeFetchProvider("exa", "# Third time lucky");
    const never = fakeFetchProvider("parallel", "# Not reached");
    const tool = makeTool(
      {},
      Result.fail(new HttpStatusRejected({ status: 429, statusText: "" })),
      [new ExaMcpFetchProvider(failingMcp), empty, answering, never],
    );

    const result = await tool.execute("t1", { url: "https://blocked.example" });
    expect(textOf(result)).toContain("Third time lucky");
    expect(result.details.via).toBe("exa");
    expect(failingCalls).toHaveLength(1);
    expect(empty.calls).toHaveLength(1);
    expect(answering.calls).toHaveLength(1);
    expect(never.calls).toHaveLength(0);
  });

  test("when every rescue provider fails, the direct failure is reported", async () => {
    const { client: failingMcp } = fakeMcpClient([
      Result.fail(new ProviderStatusRejected({ status: 500 })),
    ]);
    const tool = makeTool(
      {},
      Result.fail(new HttpStatusRejected({ status: 403, statusText: "Forbidden" })),
      [new ExaMcpFetchProvider(failingMcp)],
    );
    await expect(tool.execute("t1", { url: "https://blocked.example" })).rejects.toThrow(
      "Request failed (403 Forbidden)",
    );
  });
});
