import assert from "node:assert/strict";
import {
  arrays,
  booleans,
  composite,
  integers,
  just,
  oneOf,
  sampledFrom,
  tuples,
  weightedBooleans,
} from "@hegeldev/hegel/generators";
import { Effect, Result, Schema } from "effect";
import { describe, test } from "vitest";
import { propertySettings, assertHegel } from "../../../test-support/hegel-settings";
import { FetchPageBody } from "../fetch-page";
import type { FetchPageResult } from "../fetch-page";
import { STRUCTURED_OUTPUT_MAX_BYTES, projectFetchResult, redactSecrets } from "../tool-output";
import type { ToolOutputStore } from "../tool-output";
import { parsePublicHttpUrl } from "../types";
import { UTF8, publicUrl } from "./fakes";
import { observableText } from "./leaks";

const settings = propertySettings(50);
const fastSettings = propertySettings();

const store: ToolOutputStore["Service"] = {
  writeTextFile: () => Effect.succeed("/fake/output.txt"),
};

function textResult(text: string): FetchPageResult {
  return {
    meta: {
      requestedUrl: publicUrl("https://example.com"),
      finalUrl: publicUrl("https://example.com/final"),
      format: "text",
      status: 200,
      mime: "text/plain",
      contentType: "text/plain",
      charset: UTF8,
      bytes: text.length,
    },
    body: FetchPageBody.Text({ kind: "text", text, decoder: UTF8 }),
  };
}

const PIECES = ["abc", "é", "😀", "日本語", "\r\n", "", "line with spaces"];

const baseText = arrays(sampledFrom(PIECES), { minSize: 1, maxSize: 6 }).map((parts) =>
  parts.join(""),
);

const LONG_LINE = "é".repeat(30_000);

const pagedText = composite((tc) => {
  const lines = tc.draw(arrays(baseText, { minSize: 1, maxSize: 20 }), "lines");
  const repeat = tc.draw(integers({ minValue: 1, maxValue: 150 }), "repeat");
  const longLine = tc.draw(booleans(), "longLine");
  const body = Array.from({ length: repeat }, () => lines.join("\n")).join("\n");
  const manyLines = tc.draw(weightedBooleans(0.8), "manyLines");
  const filler = manyLines ? "ab\n".repeat(2100) : "";

  return `${filler}${longLine ? `${LONG_LINE}\n${body}` : body}`;
});

const NOTICE = /Showing bytes (?<from>\d+)–(?<to>\d+) of (?<total>\d+)/u;

function run(text: string, offset: number) {
  return Effect.runSync(projectFetchResult(textResult(text), { store, secrets: [], offset }));
}

function boundaryAtOrAfter(bytes: Buffer, offset: number): number {
  let at = Math.min(offset, bytes.length);

  while (at < bytes.length && ((bytes[at] ?? 0) & 0xc0) === 0x80) {
    at += 1;
  }

  return at;
}

function shownText(result: ReturnType<typeof run>): string {
  const [first] = result.content;
  assert.ok(first?.type === "text");

  return first.text;
}

const decodeContent = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }));

function structuredBytes(result: ReturnType<typeof run>): number {
  const { content } = decodeContent(result.structuredContent);

  return Buffer.byteLength(content);
}

function checkPaging(text: string, startAt: number): void {
  const firstOffset = startAt >= Buffer.byteLength(text) ? 0 : startAt;
  const all = Buffer.from(text, "utf8");
  const first = firstOffset > 0 ? boundaryAtOrAfter(all, firstOffset) : 0;
  const collected: Array<Buffer> = [];
  let offset = firstOffset;
  let expectedStart = first;
  let finished = false;

  for (let page = 0; page < 40 && !finished; page += 1) {
    const result = run(text, offset);
    assert.ok(structuredBytes(result) <= STRUCTURED_OUTPUT_MAX_BYTES);
    const shown = shownText(result);

    if (result.details.truncated !== true) {
      collected.push(Buffer.from(all.subarray(expectedStart)));
      assert.ok(shown.startsWith(all.subarray(expectedStart).toString("utf8")));
      finished = true;
      continue;
    }

    const to = checkWindow(shown, all, expectedStart, collected);
    expectedStart = to;
    offset = to;
    finished = to >= all.length;
  }

  assert.ok(finished, "paging did not finish within the page cap");
  assert.ok(Buffer.concat(collected).equals(all.subarray(first)), "no gap and no overlap");
}

function checkWindow(shown: string, all: Buffer, expectedStart: number, collected: Array<Buffer>) {
  const match = NOTICE.exec(shown)?.groups;
  assert.ok(match);
  const { from: fromText, to: toText } = match;
  const from = Number(fromText);
  const to = Number(toText);
  assert.equal(from, expectedStart);
  assert.ok(to > from, "next_offset strictly increases");
  assert.ok(to === all.length || ((all[to] ?? 0) & 0xc0) !== 0x80, "offset on a char boundary");
  const body = shown.slice(0, shown.lastIndexOf("\n\n["));
  const bodyBytes = Buffer.from(body, "utf8");
  const skipped = to - from - bodyBytes.length;
  assert.ok(skipped === 0 || (skipped === 1 && all[from + bodyBytes.length] === 0x0a));
  collected.push(bodyBytes, all.subarray(from + bodyBytes.length, to));

  return to;
}

function checkPastEnd(text: string, extra: number): void {
  const total = Buffer.byteLength(text);
  const result = run(text, total + extra + 1);
  assert.ok(shownText(result).includes("at or past the end of the content"));
}

describe("webfetch paging properties", () => {
  test("following next offsets reconstructs the text exactly", () => {
    assertHegel(settings, (tc) => {
      const text = tc.draw(pagedText, "text");
      const total = Buffer.byteLength(text);

      const startAt = tc.draw(oneOf(just(0), integers({ minValue: 0, maxValue: total })), "start");

      checkPaging(text, startAt);
    });
  });

  test("an offset at or past the end reports it without throwing", () => {
    assertHegel(fastSettings, (tc) => {
      checkPastEnd(
        tc.draw(baseText, "text"),
        tc.draw(integers({ minValue: 0, maxValue: 50 }), "extra"),
      );
    });
  });
});

const SECRETS = ["a.b", "a*b", "(x)", "[y]", "$&", "\\", " ", "p|q", "^s$", "k+", "k+k+", "a.bb"];
const SAFE = ["ab", "axb", "aab", "zz", "hello", "é😀"];

function checkRedaction(parts: Array<string>, secrets: Array<string>): void {
  const input = parts.join("");
  const output = redactSecrets(input, secrets);

  for (const secret of secrets) {
    assert.ok(!output.includes(secret), `secret ${JSON.stringify(secret)} survived`);
  }

  assert.equal(redactSecrets(input, []), input);
  assert.equal(redactSecrets(input, [undefined, ""]), input);

  for (const secret of secrets) {
    assert.equal(redactSecrets(secret, secrets), "[redacted]");
  }
}

function checkLiteral(parts: Array<string>, secrets: Array<string>): void {
  const input = parts.join("");
  assert.equal(redactSecrets(input, secrets), input);
}

function checkOverlap(reverse: boolean, parts: Array<string>): void {
  const base = ["k+", "k+k+", "a.b", "a.bb"];
  const secrets = reverse ? base.toReversed() : base;
  const input = parts.join("|");
  const expected = parts.map(() => "[redacted]").join("|");
  assert.equal(redactSecrets(input, secrets), expected);
}

describe("redactSecrets properties", () => {
  test("overlapping secrets are replaced whole regardless of order", () => {
    assertHegel(fastSettings, (tc) => {
      checkOverlap(
        tc.draw(booleans(), "reverse"),
        tc.draw(arrays(sampledFrom(["k+", "k+k+", "a.b", "a.bb"]), { maxSize: 6 }), "parts"),
      );
    });
  });

  test("no secret survives and nothing changes without secrets", () => {
    assertHegel(fastSettings, (tc) => {
      checkRedaction(
        tc.draw(arrays(sampledFrom([...SECRETS, ...SAFE]), { maxSize: 8 }), "parts"),
        tc.draw(arrays(sampledFrom(SECRETS), { maxSize: 3 }), "secrets"),
      );
    });
  });

  test("regex metacharacters match literally", () => {
    assertHegel(fastSettings, (tc) => {
      checkLiteral(
        tc.draw(arrays(sampledFrom(SAFE), { maxSize: 8 }), "parts"),
        tc.draw(
          arrays(sampledFrom(["a.b", "a*b", "k+", "^s$"]), { minSize: 1, maxSize: 3 }),
          "secrets",
        ),
      );
    });
  });
});

const PASSWORD = "s3cretpw";

const urlParts = tuples(
  sampledFrom(["http", "https", "HTTPS", "ftp", "file"]),
  sampledFrom(["", `user:${PASSWORD}@`, "u@"]),
  sampledFrom([
    "example.com",
    "EXAMPLE.com.",
    "a.b.c",
    "[::1]",
    "1.2.3.4",
    "xn--p1ai",
    "bad host",
    "[::",
  ]),
  sampledFrom(["", "/", "/a/../b?q=1#f", "/%41"]),
);

function checkUrl([scheme, userinfo, host, path]: [string, string, string, string]): void {
  const input = `${scheme}://${userinfo}${host}${path}`;
  const parsed = parsePublicHttpUrl(input);

  if (Result.isSuccess(parsed)) {
    const url = new URL(parsed.success);
    assert.ok(url.protocol === "http:" || url.protocol === "https:", url.protocol);
    assert.equal(url.username + url.password, "");
    assert.equal(parsed.success, url.toString());
    const again = parsePublicHttpUrl(parsed.success);
    assert.ok(Result.isSuccess(again));
    assert.equal(again.success, parsed.success);

    return;
  }

  assert.ok(!observableText(parsed.failure).includes(PASSWORD));
  assert.ok(!parsed.failure._tag.includes(PASSWORD));
  assert.ok(!String(Object.values(parsed.failure)).includes(PASSWORD));
}

describe("parsePublicHttpUrl properties", () => {
  test("successes are idempotent and credential-free; failures never leak the password", () => {
    assertHegel(fastSettings, (tc) => {
      checkUrl(tc.draw(urlParts, "parts"));
    });
  });
});
