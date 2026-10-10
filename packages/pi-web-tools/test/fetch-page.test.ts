import { Effect, Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import { FetchPage, getAcceptHeader, UnsupportedBinaryContent } from "../fetch-page";
import { EmptyHtmlDocument, HtmlConversionFailed } from "../html-conversion";
import { HttpStatusRejected } from "../network";
import { UTF8, fakePublicWeb, publicUrl, textWebResponse } from "./fakes";

const URL = "https://example.com/page";
const OPTIONS = { maxRedirects: 5, maxResponseBytes: 1024 * 1024, blockPrivateHosts: true };

describe("fetchPage", () => {
  test("converts HTML to markdown by default", async () => {
    const { client } = fakePublicWeb(
      Result.succeed(
        textWebResponse("<html><body><article><h1>Hello</h1><p>World</p></article></body></html>"),
      ),
    );
    const page = new FetchPage(client);
    const result = await Effect.runPromise(
      Effect.result(page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS)),
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
  });

  test("returns raster images inline", async () => {
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
    const page = new FetchPage(client);
    const result = await Effect.runPromise(
      Effect.result(page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS)),
    );

    assert(Result.isSuccess(result));
    expect(result.success.body).toStrictEqual({ _tag: "Image", data: png });
    expect(result.success.meta.bytes).toBe(png.byteLength);
  });

  test("rejects unsupported binary content", async () => {
    const { client } = fakePublicWeb(
      Result.succeed(textWebResponse(String.raw`PK\u0003\u0004`, "application/zip")),
    );
    const page = new FetchPage(client);
    const result = await Effect.runPromise(
      Effect.result(page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS)),
    );

    assert(Result.isFailure(result));
    assert(result.failure instanceof UnsupportedBinaryContent);
    expect(result.failure.mime).toBe("application/zip");
  });

  test("leaves the mime off binary errors when the response has no content type", async () => {
    const { client } = fakePublicWeb(Result.succeed(textWebResponse("?", "")));
    const page = new FetchPage(client);
    const result = await Effect.runPromise(
      Effect.result(page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS)),
    );

    assert(Result.isFailure(result));
    assert(result.failure instanceof UnsupportedBinaryContent);
    expect(result.failure.mime).toBe("");
    expect(result.failure.message).toBe(
      "Unsupported binary content. Try a more text-oriented URL.",
    );
  });

  test("passes through plain text for text format", async () => {
    const { client } = fakePublicWeb(Result.succeed(textWebResponse("plain words", "text/plain")));
    const page = new FetchPage(client);
    const result = await Effect.runPromise(
      Effect.result(page.fetch({ url: publicUrl(URL), format: "text" }, OPTIONS)),
    );

    assert(Result.isSuccess(result));
    expect(result.success.body).toStrictEqual({
      _tag: "Text",
      kind: "text",
      text: "plain words",
      decoder: UTF8,
    });
  });

  test("propagates public web failures", async () => {
    const { client } = fakePublicWeb(
      Result.fail(new HttpStatusRejected({ status: 500, statusText: "Server Error" })),
    );
    const page = new FetchPage(client);
    const result = await Effect.runPromise(
      Effect.result(page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS)),
    );

    assert(Result.isFailure(result));
    expect(result.failure._tag).toBe("HttpStatusRejected");
  });
});

describe("fetchPage conversion failures", () => {
  test("an HTML response without elements is EmptyHtmlDocument", async () => {
    const { client } = fakePublicWeb(Result.succeed(textWebResponse("   <!-- nothing -->  ")));
    const page = new FetchPage(client);
    const result = await Effect.runPromise(
      Effect.result(page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS)),
    );

    assert(Result.isFailure(result));
    expect(result.failure).toBeInstanceOf(EmptyHtmlDocument);
  });

  test("deeply nested HTML is HtmlConversionFailed", async () => {
    const deep = `${"<div>".repeat(5000)}x${"</div>".repeat(5000)}`;
    const { client } = fakePublicWeb(Result.succeed(textWebResponse(deep)));
    const page = new FetchPage(client);
    const result = await Effect.runPromise(
      Effect.result(page.fetch({ url: publicUrl(URL), format: "text" }, OPTIONS)),
    );

    assert(Result.isFailure(result));
    expect(result.failure).toBeInstanceOf(HtmlConversionFailed);
  });
});

describe("getAcceptHeader", () => {
  test("prefers the requested format", () => {
    expect(getAcceptHeader("markdown")).toContain("text/markdown;q=1.0");
    expect(getAcceptHeader("text")).toContain("text/plain;q=1.0");
    expect(getAcceptHeader("html")).toContain("text/html;q=1.0");
  });
});
