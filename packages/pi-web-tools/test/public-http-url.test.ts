import { describe, expect, test } from "@effect/vitest";
import { Result } from "effect";
import { isPublicHttpUrl, parsePublicHttpUrl } from "../types";

describe("public HTTP URL construction", () => {
  test.each([
    [" HTTPS://EXAMPLE.COM:443/a/../b ", "https://example.com/b"],
    ["http://example.com", "http://example.com/"],
    ["https://example.com/a b?q=hello world", "https://example.com/a%20b?q=hello%20world"],
  ])("normalizes %s once into a canonical branded URL", (input, canonical) => {
    const parsed = parsePublicHttpUrl(input);
    expect(parsed).toStrictEqual(Result.succeed(canonical));
    expect(isPublicHttpUrl(canonical)).toBe(true);
    expect(isPublicHttpUrl(input)).toBe(input === canonical);
    expect(Result.flatMap(parsed, parsePublicHttpUrl)).toStrictEqual(parsed);
  });

  test.each([
    ["", "EmptyUrl"],
    ["https:example.com", "UnsupportedUrlProtocol"],
    ["ftp://example.com/", "UnsupportedUrlProtocol"],
    ["//example.com/", "UnsupportedUrlProtocol"],
    ["https://[invalid]/", "InvalidUrl"],
    ["https://user:secret@example.com/", "UrlCredentialsUnsupported"],
    ["https://user@example.com/", "UrlCredentialsUnsupported"],
  ])("rejects %s without constructing a branded value", (input, tag) => {
    expect(Result.mapError(parsePublicHttpUrl(input), (error) => error._tag)).toStrictEqual(
      Result.fail(tag),
    );
    expect(isPublicHttpUrl(input)).toBe(false);
  });
});
