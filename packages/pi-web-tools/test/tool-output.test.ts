import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, expect, it, test } from "@effect/vitest";
import { Effect, Result } from "effect";
import type { FetchPageResult } from "../fetch-page";
import { OutputStoreError, writeTempTextFile } from "../temp";
import {
  formatSearchResults,
  projectFetchResult,
  projectProviderFetchedPage,
  projectSearchResults,
} from "../tool-output";
import type { ToolOutputStore } from "../tool-output";
import { UTF8, publicUrl, textOf, liveToolOutputStore } from "./fakes";

/** Permission bits of a file mode: its low nine bits. */
function permissionBits(mode: number): number {
  return mode & 0o777;
}

const failingStore: ToolOutputStore["Service"] = {
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
  it.effect("passes through small content untruncated with the response metadata as details", () =>
    Effect.gen(function* () {
      const projected = yield* Effect.result(
        projectFetchResult(textResult("small page"), {
          store: liveToolOutputStore(),
          secrets: [],
        }),
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
    }),
  );

  test("truncates large output and spills the full text to a private temp file", async () => {
    const large = `line\n`.repeat(300_000);
    const projected = await Effect.runPromise(
      Effect.result(
        projectFetchResult(textResult(large), {
          store: liveToolOutputStore(),
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

  it.effect("projects images as inline content", () =>
    Effect.gen(function* () {
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
      const projected = yield* Effect.result(
        projectFetchResult(image, {
          store: liveToolOutputStore(),
          secrets: [],
        }),
      );
      assert(Result.isSuccess(projected));
      expect(projected.success.details).toStrictEqual({ ...image.meta, image: true });
      expect(projected.success.content).toContainEqual({
        type: "image",
        data: "AQIDBA==",
        mimeType: "image/png",
      });
    }),
  );

  it.effect("surfaces store failures", () =>
    Effect.gen(function* () {
      const projected = yield* Effect.result(
        projectFetchResult(textResult("x\n".repeat(300_000)), {
          store: failingStore,
          secrets: [],
        }),
      );
      assert(Result.isFailure(projected));
      expect(projected.failure.message).toBe(
        "Could not save full output to /tmp/x/output.txt: no space left on device (ENOSPC)",
      );
    }),
  );
});

describe("projectProviderFetchedPage", () => {
  it.effect("notes the provider and records only what the rescue knows", () =>
    Effect.gen(function* () {
      const projected = yield* Effect.result(
        projectProviderFetchedPage(
          { provider: "exa", url: publicUrl("https://blocked.example"), markdown: "# Rescued é" },
          { store: liveToolOutputStore(), secrets: [] },
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
    }),
  );
});

describe("projectSearchResults", () => {
  it.effect("redacts secrets from output text", () =>
    Effect.gen(function* () {
      const projected = yield* Effect.result(
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
          { store: liveToolOutputStore(), secrets: ["sekrit"] },
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
    }),
  );
});

describe("writeTempTextFile", () => {
  it.effect("classifies Node filesystem errors as OutputStoreError", () =>
    Effect.gen(function* () {
      const prefix = join("pi-web-tools-missing-dir", "sub-");
      const written = yield* Effect.result(writeTempTextFile(prefix, "output.txt", "x"));
      assert(Result.isFailure(written));
      expect(written.failure._tag).toBe("OutputStoreError");
      expect(written.failure.operation).toBe("mkdtemp");
      expect(written.failure.path).toBe(join(tmpdir(), prefix));
      expect(written.failure.reason).toBe("directory does not exist (ENOENT)");
    }),
  );
});
