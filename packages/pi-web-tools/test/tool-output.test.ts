import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import type { FetchPageResult } from "../fetch-page";
import { OutputStoreError, writeTempTextFile } from "../temp";
import {
  formatSearchResults,
  projectFetchResult,
  projectProviderFetchedPage,
  projectSearchResults,
  tempFileToolOutputStore,
} from "../tool-output";
import type { ToolOutputStore } from "../tool-output";
import { UTF8, publicUrl, textOf } from "./fakes";

/** Permission bits of a file mode: its low nine bits. */
function permissionBits(mode: number): number {
  return mode & 0o777;
}

const failingStore: ToolOutputStore = {
  writeTextFile: () =>
    Effect.fail(
      new OutputStoreError({ operation: "write", path: "/tmp/x/output.txt", code: "ENOSPC" }),
    ),
};

function textResult(text: string): FetchPageResult {
  return {
    meta: {
      requestedUrl: publicUrl("https://example.com"),
      finalUrl: publicUrl("https://example.com/final"),
      format: "markdown",
      status: 200,
      mime: "text/html",
      contentType: "text/html; charset=utf-8",
      charset: UTF8,
      bytes: text.length,
    },
    body: { _tag: "Text", kind: "html", text, decoder: UTF8 },
  };
}

describe("formatSearchResults", () => {
  test("formats numbered results with metadata", () => {
    const output = formatSearchResults("query", [
      {
        title: "One",
        url: publicUrl("https://one.example"),
        snippet: "first",
        publishedAt: "2026-01-01",
        source: "Exa",
        score: 0.9,
      },
    ]);
    expect(output).toContain("Search results for: query");
    expect(output).toContain("1. One");
    expect(output).toContain("URL: https://one.example/");
    expect(output).toContain("Published: 2026-01-01");
    expect(output).toContain("Snippet: first");
  });

  test("handles empty results", () => {
    expect(formatSearchResults("query", [])).toContain("No results found");
  });
});

describe("projectFetchResult", () => {
  test("passes through small content untruncated with the response metadata as details", async () => {
    const projected = await Effect.runPromise(
      Effect.result(
        projectFetchResult(textResult("small page"), {
          store: tempFileToolOutputStore,
          secrets: [],
        }),
      ),
    );
    assert(Result.isSuccess(projected));
    expect(projected.success.details).toStrictEqual({
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/final",
      format: "markdown",
      status: 200,
      mime: "text/html",
      contentType: "text/html; charset=utf-8",
      charset: UTF8,
      decoder: UTF8,
      bytes: 10,
      truncated: false,
    });
    expect(textOf(projected.success)).toBe("small page");
  });

  test("truncates large output and spills the full text to a private temp file", async () => {
    const large = `line\n`.repeat(300_000);
    const projected = await Effect.runPromise(
      Effect.result(
        projectFetchResult(textResult(large), {
          store: tempFileToolOutputStore,
          secrets: [],
        }),
      ),
    );
    assert(Result.isSuccess(projected));
    expect(projected.success.details.truncated).toBe(true);
    const { fullOutputPath } = projected.success.details;
    assert(typeof fullOutputPath === "string");

    const fileStat = await stat(fullOutputPath);
    // 0600 on the file; 0700 on the containing directory.
    expect(permissionBits(fileStat.mode)).toBe(0o600);
    const dirStat = await stat(fullOutputPath.slice(0, fullOutputPath.lastIndexOf("/")));
    expect(permissionBits(dirStat.mode)).toBe(0o700);
    expect(textOf(projected.success)).toContain("Full output saved to:");
  });

  test("projects images as inline content", async () => {
    const image: FetchPageResult = {
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
    };
    const projected = await Effect.runPromise(
      Effect.result(
        projectFetchResult(image, {
          store: tempFileToolOutputStore,
          secrets: [],
        }),
      ),
    );
    assert(Result.isSuccess(projected));
    expect(projected.success.details).toStrictEqual({ ...image.meta, image: true });
    expect(projected.success.content).toContainEqual({
      type: "image",
      data: "AQIDBA==",
      mimeType: "image/png",
    });
  });

  test("surfaces store failures", async () => {
    const projected = await Effect.runPromise(
      Effect.result(
        projectFetchResult(textResult("x\n".repeat(300_000)), {
          store: failingStore,
          secrets: [],
        }),
      ),
    );
    assert(Result.isFailure(projected));
    expect(projected.failure.message).toBe(
      "Could not save full output to /tmp/x/output.txt: no space left on device (ENOSPC)",
    );
  });
});

describe("projectProviderFetchedPage", () => {
  test("notes the provider and records only what the rescue knows", async () => {
    const projected = await Effect.runPromise(
      Effect.result(
        projectProviderFetchedPage(
          { provider: "exa", url: publicUrl("https://blocked.example"), markdown: "# Rescued é" },
          { store: tempFileToolOutputStore, secrets: [] },
        ),
      ),
    );
    assert(Result.isSuccess(projected));
    expect(textOf(projected.success)).toMatch(
      /^\[Direct fetch was blocked or unusable; content retrieved via exa/u,
    );
    expect(textOf(projected.success)).toContain("# Rescued é");
    expect(projected.success.details).toStrictEqual({
      requestedUrl: "https://blocked.example/",
      format: "markdown",
      bytes: 12,
      via: "exa",
      truncated: false,
    });
  });
});

describe("projectSearchResults", () => {
  test("redacts secrets from output text", async () => {
    const projected = await Effect.runPromise(
      Effect.result(
        projectSearchResults(
          {
            query: "q",
            results: [{ title: "has sekrit inside", url: publicUrl("https://example.com") }],
            details: {
              query: "q",
              maxResults: 8,
              provider: "exa",
              attemptedProviders: ["exa"],
              resultCount: 1,
            },
          },
          { store: tempFileToolOutputStore, secrets: ["sekrit"] },
        ),
      ),
    );
    assert(Result.isSuccess(projected));
    expect(textOf(projected.success)).not.toContain("sekrit");
    expect(textOf(projected.success)).toContain("[redacted]");
    // Results live in the content text only; details stay a small summary.
    expect(projected.success.details).toStrictEqual({
      query: "q",
      maxResults: 8,
      provider: "exa",
      attemptedProviders: ["exa"],
      resultCount: 1,
      truncated: false,
    });
  });
});

describe("writeTempTextFile", () => {
  test("classifies Node filesystem errors as OutputStoreError", async () => {
    const prefix = join("pi-web-tools-missing-dir", "sub-");
    const written = await Effect.runPromise(
      Effect.result(writeTempTextFile(prefix, "output.txt", "x")),
    );
    assert(Result.isFailure(written));
    expect(written.failure._tag).toBe("OutputStoreError");
    expect(written.failure.operation).toBe("mkdtemp");
    expect(written.failure.path).toBe(join(tmpdir(), prefix));
    expect(written.failure.reason).toBe("directory does not exist (ENOENT)");
  });

  test("falls back to the bare code for unfamiliar errors", () => {
    const error = new OutputStoreError({ operation: "chmod", path: "/tmp/d", code: "EWEIRD" });
    expect(error.message).toBe("Could not save full output to /tmp/d: EWEIRD");
  });
});
