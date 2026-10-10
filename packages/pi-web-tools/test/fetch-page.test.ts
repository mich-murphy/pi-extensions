import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { UnsupportedBinaryContent } from "../fetch-page";
import { EmptyHtmlDocument, HtmlConversionFailed } from "../html-conversion";
import { UTF8, fakePublicWeb, publicUrl, textWebResponse, fetchPageWith } from "./fakes";

const URL = "https://example.com/page";
const OPTIONS = { maxRedirects: 5, maxResponseBytes: 1024 * 1024, blockPrivateHosts: true };

describe("fetchPage", () => {
  it.effect("converts HTML to markdown by default", () =>
    Effect.gen(function* () {
      const { client } = fakePublicWeb(
        Result.succeed(
          textWebResponse(
            "<html><body><article><h1>Hello</h1><p>World</p></article></body></html>",
          ),
        ),
      );
      const page = fetchPageWith(client);
      const result = yield* Effect.result(
        page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS),
      );

      assert(Result.isSuccess(result));
      assert(result.success.body._tag === "Text");
      expect(result.success.body.text).toContain("# Hello");
      expect(result.success.body.kind).toBe("html");
      expect(result.success.meta).toStrictEqual({
        requestedUrl: "https://example.com/page",
        finalUrl: "https://example.com/page",
        format: "markdown",
        status: 200,
        mime: "text/html",
        contentType: "text/html; charset=utf-8",
        charset: UTF8,
        bytes: 71,
      });
    }),
  );

  it.effect("returns raster images inline", () =>
    Effect.gen(function* () {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const { client } = fakePublicWeb(
        Result.succeed({
          requestedUrl: publicUrl(URL),
          finalUrl: publicUrl(URL),
          status: 200,
          headers: new Headers({ "content-type": "image/png" }),
          body: png,
        }),
      );
      const page = fetchPageWith(client);
      const result = yield* Effect.result(
        page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS),
      );

      assert(Result.isSuccess(result));
      expect(result.success.body).toStrictEqual({ _tag: "Image", data: png });
      expect(result.success.meta.bytes).toBe(png.byteLength);
    }),
  );

  it.effect("rejects unsupported binary content", () =>
    Effect.gen(function* () {
      const { client } = fakePublicWeb(
        Result.succeed(textWebResponse(String.raw`PK\u0003\u0004`, "application/zip")),
      );
      const page = fetchPageWith(client);
      const result = yield* Effect.result(
        page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS),
      );

      assert(Result.isFailure(result));
      assert(result.failure instanceof UnsupportedBinaryContent);
      expect(result.failure.mime).toBe("application/zip");
    }),
  );

  it.effect("leaves the mime off binary errors when the response has no content type", () =>
    Effect.gen(function* () {
      const { client } = fakePublicWeb(Result.succeed(textWebResponse("?", "")));
      const page = fetchPageWith(client);
      const result = yield* Effect.result(
        page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS),
      );

      assert(Result.isFailure(result));
      assert(result.failure instanceof UnsupportedBinaryContent);
      expect(result.failure.mime).toBe("");
      expect(result.failure.message).toBe(
        "Unsupported binary content. Try a more text-oriented URL.",
      );
    }),
  );

  it.effect("passes through plain text for text format", () =>
    Effect.gen(function* () {
      const { client } = fakePublicWeb(
        Result.succeed(textWebResponse("plain words", "text/plain")),
      );
      const page = fetchPageWith(client);
      const result = yield* Effect.result(
        page.fetch({ url: publicUrl(URL), format: "text" }, OPTIONS),
      );

      assert(Result.isSuccess(result));
      expect(result.success.body).toStrictEqual({
        _tag: "Text",
        kind: "text",
        text: "plain words",
        decoder: UTF8,
      });
    }),
  );
});

describe("fetchPage conversion failures", () => {
  it.effect("an HTML response without elements is EmptyHtmlDocument", () =>
    Effect.gen(function* () {
      const { client } = fakePublicWeb(Result.succeed(textWebResponse("   <!-- nothing -->  ")));
      const page = fetchPageWith(client);
      const result = yield* Effect.result(
        page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS),
      );

      assert(Result.isFailure(result));
      expect(result.failure).toBeInstanceOf(EmptyHtmlDocument);
    }),
  );

  it.effect("deeply nested HTML is HtmlConversionFailed", () =>
    Effect.gen(function* () {
      const deep = `${"<div>".repeat(5000)}x${"</div>".repeat(5000)}`;
      const { client } = fakePublicWeb(Result.succeed(textWebResponse(deep)));
      const page = fetchPageWith(client);
      const result = yield* Effect.result(
        page.fetch({ url: publicUrl(URL), format: "text" }, OPTIONS),
      );

      assert(Result.isFailure(result));
      expect(result.failure).toBeInstanceOf(HtmlConversionFailed);
    }),
  );
});
