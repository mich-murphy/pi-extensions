import { assert, describe, expect, test } from "vitest";
import { FetchPage, getAcceptHeader } from "../fetch-page";
import { err } from "../result";
import { UTF8, fakePublicWeb, publicUrl, textWebResponse } from "./fakes";

const URL = "https://example.com/page";
const OPTIONS = { maxRedirects: 5, maxResponseBytes: 1024 * 1024, blockPrivateHosts: true };

describe("fetchPage", () => {
  test("converts HTML to markdown by default", async () => {
    const { client } = fakePublicWeb({
      _tag: "ok",
      value: textWebResponse(
        "<html><body><article><h1>Hello</h1><p>World</p></article></body></html>",
      ),
    });
    const page = new FetchPage(client);
    const result = await page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS);

    assert(result._tag === "ok");
    assert(result.value.body._tag === "Text");
    expect(result.value.body.text).toContain("# Hello");
    expect(result.value.body.kind).toBe("html");
    expect(result.value.meta).toStrictEqual({
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
    const { client } = fakePublicWeb({
      _tag: "ok",
      value: {
        requestedUrl: publicUrl(URL),
        finalUrl: publicUrl(URL),
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        body: png,
      },
    });
    const page = new FetchPage(client);
    const result = await page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS);

    assert(result._tag === "ok");
    expect(result.value.body).toStrictEqual({ _tag: "Image", data: png });
    expect(result.value.meta.bytes).toBe(png.byteLength);
  });

  test("rejects unsupported binary content", async () => {
    const { client } = fakePublicWeb({
      _tag: "ok",
      value: textWebResponse(String.raw`PK\u0003\u0004`, "application/zip"),
    });
    const page = new FetchPage(client);
    const result = await page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS);

    expect(result).toStrictEqual(
      err({ _tag: "UnsupportedBinaryContent", mime: "application/zip" }),
    );
  });

  test("leaves the mime off binary errors when the response has no content type", async () => {
    const { client } = fakePublicWeb({ _tag: "ok", value: textWebResponse("?", "") });
    const page = new FetchPage(client);
    const result = await page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS);

    expect(result).toStrictEqual(err({ _tag: "UnsupportedBinaryContent" }));
  });

  test("passes through plain text for text format", async () => {
    const { client } = fakePublicWeb({
      _tag: "ok",
      value: textWebResponse("plain words", "text/plain"),
    });
    const page = new FetchPage(client);
    const result = await page.fetch({ url: publicUrl(URL), format: "text" }, OPTIONS);

    assert(result._tag === "ok");
    expect(result.value.body).toStrictEqual({
      _tag: "Text",
      kind: "text",
      text: "plain words",
      decoder: UTF8,
    });
  });

  test("propagates public web failures", async () => {
    const { client } = fakePublicWeb(
      err({ _tag: "HttpStatusRejected", status: 500, statusText: "Server Error" }),
    );
    const page = new FetchPage(client);
    const result = await page.fetch({ url: publicUrl(URL), format: "markdown" }, OPTIONS);

    assert(result._tag === "err");
    expect(result.error._tag).toBe("HttpStatusRejected");
  });
});

describe("getAcceptHeader", () => {
  test("prefers the requested format", () => {
    expect(getAcceptHeader("markdown")).toContain("text/markdown;q=1.0");
    expect(getAcceptHeader("text")).toContain("text/plain;q=1.0");
    expect(getAcceptHeader("html")).toContain("text/html;q=1.0");
  });
});
