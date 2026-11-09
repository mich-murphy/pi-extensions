import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Effect, Result } from "effect";
import { describe, test } from "vitest";
import {
  classifyMimeType,
  decodeTextBuffer,
  parseContentType,
  readResponseBodyWithLimit,
} from "../network";
import type { PublicWebRequest } from "../network";
import { publicUrl, publicWebClientWith } from "./fakes";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };

// ---- M3: mime classification and charset decoding ----

// Independent table of mime types with a fixed kind, whatever the casing or surrounding space.
const KNOWN_KINDS: readonly (readonly [string, string])[] = [
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
  ["image/png", "raster-image"],
  ["image/jpeg", "raster-image"],
  ["image/gif", "raster-image"],
  ["image/webp", "raster-image"],
  ["image/svg+xml", "svg"],
  ["application/json", "text"],
  ["application/xml", "text"],
  ["application/javascript", "text"],
  ["application/x-javascript", "text"],
  ["application/ecmascript", "text"],
  ["application/pdf", "binary"],
  ["application/octet-stream", "binary"],
  ["video/mp4", "binary"],
  ["", "binary"],
];
const TABLE_MIMES = new Set(KNOWN_KINDS.map(([mime]) => mime));
const KINDS = new Set(["html", "raster-image", "svg", "text", "binary"]);
const PADDING = ["", " ", "\t", " \r\n "];
const TOKEN = gs.text({
  alphabet: "abcdefghijklmnopqrstuvwxyz0123456789.-",
  minSize: 1,
  maxSize: 12,
});
const caseFlags = gs.arrays(gs.booleans(), { minSize: 40, maxSize: 40 });
const padding = gs.tuples(gs.sampledFrom(PADDING), gs.sampledFrom(PADDING));

function mixCase(value: string, flags: readonly boolean[]): string {
  return value
    .split("")
    .map((char, index) => (flags[index] === true ? char.toUpperCase() : char))
    .join("");
}

function assertKind(
  mime: string,
  expected: string,
  flags: readonly boolean[],
  [left, right]: readonly [string, string],
): void {
  assert.equal(classifyMimeType(`${left}${mixCase(mime, flags)}${right}`), expected, mime);
}

const SUFFIX_FAMILIES: readonly (readonly [string, string])[] = [
  ["text/", ""],
  ["application/", "+xml"],
  ["application/", "+json"],
];

function assertSuffixIsText(
  family: readonly [string, string],
  token: string,
  flags: readonly boolean[],
  pad: readonly [string, string],
): void {
  const mime = `${family[0]}${token}${family[1]}`;
  // The exact-table rows text/html and application/xhtml+xml win over the suffix rules.
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    assertKind(mime, "html", flags, pad);
    return;
  }
  assertKind(mime, "text", flags, pad);
}

function assertUnlistedIsBinary(
  token: string,
  flags: readonly boolean[],
  pad: readonly [string, string],
): void {
  const mime = `application/${token}`;
  if (!TABLE_MIMES.has(mime) && !token.endsWith("+xml") && !token.endsWith("+json")) {
    assertKind(mime, "binary", flags, pad);
  }
}

function assertContentTypeTotal(header: string | null): void {
  const parsed = parseContentType(header ?? undefined);
  assert.ok(KINDS.has(parsed.kind));
  assert.ok(!parsed.mime.includes(";"));
  assert.equal(parsed.mime, parsed.mime.trim());
  assert.equal(parsed.mime, parsed.mime.toLowerCase());
  assert.equal(parsed.kind, classifyMimeType(parsed.mime));
}

function assertDecodeTotal(bytes: Uint8Array, charset: string | null, partial: boolean): void {
  const decoded = decodeTextBuffer(Buffer.from(bytes), charset ?? undefined, { partial });
  assert.equal(typeof decoded.text, "string");
  assert.doesNotThrow(() => new TextDecoder(decoded.decoder));
}

// The longest prefix of whole characters whose UTF-8 encoding fits in `cutBytes`.
function wholeCharPrefix(text: string, cutBytes: number): string {
  let used = 0;
  let prefix = "";
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > cutBytes) {
      break;
    }
    prefix += char;
  }
  return prefix;
}

function assertPartialCut(text: string, requestedCut: number, charset: string | undefined): void {
  const encoded = Buffer.from(text);
  const cut = Math.min(requestedCut, encoded.length);
  const { text: decoded } = decodeTextBuffer(encoded.subarray(0, cut), charset, { partial: true });
  assert.ok(!decoded.includes("�"), "partial decoding produced a replacement character");
  assert.equal(decoded, wholeCharPrefix(text, cut));
}

describe("content type properties", () => {
  test("classification ignores case and surrounding whitespace for known types", () => {
    new Hegel((tc) => {
      const [mime, kind] = tc.draw(gs.sampledFrom(KNOWN_KINDS), "row");
      assertKind(mime, kind, tc.draw(caseFlags, "case"), tc.draw(padding, "padding"));
    })
      .databaseKey("pi-web-tools/classify-known")
      .settings(settings)
      .runSync();
  });

  test("text/*, +xml and +json classify as text, whatever the casing", () => {
    new Hegel((tc) => {
      assertSuffixIsText(
        tc.draw(gs.sampledFrom(SUFFIX_FAMILIES), "family"),
        tc.draw(TOKEN, "token"),
        tc.draw(caseFlags, "case"),
        tc.draw(padding, "padding"),
      );
    })
      .databaseKey("pi-web-tools/classify-suffix")
      .settings(settings)
      .runSync();
  });

  test("unlisted application types without a text suffix are binary", () => {
    new Hegel((tc) => {
      const token = tc.draw(TOKEN, "token");
      assertUnlistedIsBinary(token, tc.draw(caseFlags, "case"), tc.draw(padding, "padding"));
    })
      .databaseKey("pi-web-tools/classify-binary")
      .settings(settings)
      .runSync();
  });

  test("parsing arbitrary headers never throws and stays normalized", () => {
    new Hegel((tc) => {
      assertContentTypeTotal(tc.draw(gs.optional(gs.text({ maxSize: 60 })), "header"));
    })
      .databaseKey("pi-web-tools/parse-total")
      .settings(settings)
      .runSync();
  });

  test("decoding arbitrary bytes with arbitrary labels never throws", () => {
    new Hegel((tc) => {
      assertDecodeTotal(
        tc.draw(gs.binary({ maxSize: 64 }), "bytes"),
        tc.draw(gs.optional(gs.text({ maxSize: 20 })), "charset"),
        tc.draw(gs.booleans(), "partial"),
      );
    })
      .databaseKey("pi-web-tools/decode-total")
      .settings(settings)
      .runSync();
  });

  test("partial UTF-8 cut at any byte decodes to the whole-character prefix", () => {
    new Hegel((tc) => {
      assertPartialCut(
        tc.draw(gs.text({ maxSize: 30, excludeCharacters: "�﻿" }), "text"),
        tc.draw(gs.integers({ minValue: 0, maxValue: 130 }), "cut"),
        tc.draw(gs.sampledFrom([undefined, "utf8", " UTF-8 ", "no-such-label"]), "charset"),
      );
    })
      .databaseKey("pi-web-tools/decode-partial")
      .settings(settings)
      .runSync();
  });
});

// ---- M4: capped body reads under random chunking ----

const bodyBytes = gs.binary({ maxSize: 80 });
const chunkSizes = gs.arrays(gs.integers({ minValue: 0, maxValue: 30 }), { maxSize: 12 });
const cap = gs.integers({ minValue: 0, maxValue: 40 });

// Chunks are views into larger buffers, so a wrong byteOffset or byteLength would read neighbours.
function chunkViews(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const views: Uint8Array[] = [];
  let position = 0;
  for (const size of [...sizes, bytes.length]) {
    const slice = bytes.subarray(position, position + size);
    const padded = new Uint8Array(slice.length + 6).fill(0xaa);
    padded.set(slice, 3);
    views.push(padded.subarray(3, 3 + slice.length));
    position += slice.length;
  }
  return views;
}

function chunkedResponse(
  bytes: Uint8Array,
  sizes: readonly number[],
  contentType: string,
): Response {
  const views = chunkViews(bytes, sizes);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const view of views) {
        controller.enqueue(view);
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

async function assertFailModeRead(
  bytes: Uint8Array,
  sizes: readonly number[],
  max: number,
): Promise<void> {
  const response = chunkedResponse(bytes, sizes, "application/octet-stream");
  const result = await Effect.runPromise(Effect.result(readResponseBodyWithLimit(response, max)));
  if (bytes.length <= max) {
    assert.ok(Result.isSuccess(result));
    assert.deepEqual(new Uint8Array(result.success), bytes);
  } else {
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure._tag, "ResponseBodyTooLarge");
  }
}

function requestWithCap(maxResponseBytes: number): PublicWebRequest {
  return {
    url: publicUrl("https://example.com/"),
    accept: "*/*",
    userAgent: "test-agent",
    fallbackUserAgent: "fallback-agent",
    maxRedirects: 0,
    maxResponseBytes,
    blockPrivateHosts: true,
    domainPolicy: { allow: [], deny: [] },
    allowPartialText: true,
  };
}

async function readThroughClient(
  bytes: Uint8Array,
  sizes: readonly number[],
  max: number,
  contentType: string,
) {
  const client = publicWebClientWith({
    fetchImpl: async () => chunkedResponse(bytes, sizes, contentType),
    lookup: async () => [{ address: "93.184.216.34" }],
  });
  return Effect.runPromise(Effect.result(client.get(requestWithCap(max))));
}

async function assertTruncateModeRead(
  bytes: Uint8Array,
  sizes: readonly number[],
  max: number,
): Promise<void> {
  const result = await readThroughClient(bytes, sizes, max, "text/plain");
  assert.ok(Result.isSuccess(result));
  const expected = bytes.subarray(0, Math.min(bytes.length, max));
  assert.ok(result.success.body.byteLength <= max);
  assert.deepEqual(new Uint8Array(result.success.body), expected);
  assert.equal(result.success.responseTruncated === true, bytes.length > max);
}

async function assertBinaryKeepsHardCap(
  bytes: Uint8Array,
  sizes: readonly number[],
  max: number,
): Promise<void> {
  const result = await readThroughClient(bytes, sizes, max, "image/png");
  if (bytes.length > max) {
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure._tag, "ResponseTooLarge");
  } else {
    assert.ok(Result.isSuccess(result));
    assert.deepEqual(new Uint8Array(result.success.body), bytes);
  }
}

describe("capped body read properties", () => {
  test("fail mode returns every byte or fails, whatever the chunking", async () => {
    await new Hegel(async (tc) => {
      await assertFailModeRead(
        tc.draw(bodyBytes, "bytes"),
        tc.draw(chunkSizes, "sizes"),
        tc.draw(cap, "max"),
      );
    })
      .databaseKey("pi-web-tools/read-fail-mode")
      .settings(settings)
      .run();
  });

  test("truncate mode keeps exactly the first min(len, max) bytes", async () => {
    await new Hegel(async (tc) => {
      await assertTruncateModeRead(
        tc.draw(bodyBytes, "bytes"),
        tc.draw(chunkSizes, "sizes"),
        tc.draw(cap, "max"),
      );
    })
      .databaseKey("pi-web-tools/read-truncate-mode")
      .settings(settings)
      .run();
  });

  test("non-text bodies keep the hard cap even when partial text is allowed", async () => {
    await new Hegel(async (tc) => {
      await assertBinaryKeepsHardCap(
        tc.draw(bodyBytes, "bytes"),
        tc.draw(chunkSizes, "sizes"),
        tc.draw(cap, "max"),
      );
    })
      .databaseKey("pi-web-tools/read-binary-cap")
      .settings(settings)
      .run();
  });
});
