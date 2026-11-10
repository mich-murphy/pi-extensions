import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Result } from "effect";
import { describe, test } from "vitest";
import { htmlToMarkdown, htmlToText } from "../html";

// Each case parses and converts a document of up to 64 elements twice. 300 cases are needed to
// reliably hit a link-wrapped raw-text-only div (60 missed it); the file still runs well under 3s.
const settings = { testCases: 300, seed: 12_345n, database: Database.disabled };
const MARKER = "ZQSCRIPTMARKERQZ";
const VISIBLE = "ZQVISIBLEMARKERQZ";
const BASE_URL = "https://example.com/";
const ALLOWED_FAILURES = new Set(["EmptyHtmlDocument", "HtmlConversionFailed"]);
const NODE_KINDS = ["p", "div", "table", "script", "template", "a", "text"];
const WORDS = ["hello world", "alpha beta gamma delta", "x", " "];
const HREFS = [
  "/x",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " java\tscript:alert(1)",
  "vbscript:msgbox(1)",
  "https://e.com/y",
  "",
];
const SCRIPT_URL = /(?:java|vb)\s*script:/iu;

function renderNode(tc: TestCase, depth: number): string {
  const kind = tc.draw(gs.sampledFrom(NODE_KINDS), "kind");
  if (kind === "text") {
    return tc.draw(gs.sampledFrom(WORDS), "text");
  }
  if (kind === "script") {
    return `<script>${MARKER}</script>`;
  }
  const count = depth <= 1 ? 0 : tc.draw(gs.integers({ minValue: 0, maxValue: 2 }), "children");
  const inner = Array.from({ length: count }, () => renderNode(tc, depth - 1)).join("");
  const attributes = kind === "a" ? ` href="${tc.draw(gs.sampledFrom(HREFS), "href")}"` : "";
  return `<${kind}${attributes}>${inner}</${kind}>`;
}

// Depth at most 6. The tree is followed by a paragraph carrying VISIBLE, and may follow a leading
// raw-text element; half the documents are wrapped in html/body, the rest are bare fragments
// (the shape linkedom used to cut off after the first element).
const documentGen = gs.composite((tc) => {
  const lead = tc.draw(
    gs.sampledFrom(["", `<script>${MARKER}</script>`, "<style>x{}</style>"]),
    "lead",
  );
  const content = `${lead}${renderNode(tc, 6)}<p>${VISIBLE}</p>`;
  return tc.draw(gs.booleans(), "wrapped") ? `<html><body>${content}</body></html>` : content;
});

function assertAllowedOutcome(
  result: Result.Result<string, { readonly _tag: string }>,
  html: string,
): void {
  if (Result.isFailure(result)) {
    assert.ok(
      ALLOWED_FAILURES.has(result.failure._tag),
      `unexpected failure ${result.failure._tag}`,
    );
    return;
  }
  assert.equal(typeof result.success, "string");
  assert.ok(!result.success.includes(MARKER), "script text leaked into the output");
  assert.ok(!SCRIPT_URL.test(result.success), "a script URL survived link sanitising");
  // Readable-root extraction legitimately keeps only the best-scoring div and drops its siblings,
  // so visible text is only promised to survive when no div with visible text competes for the
  // root. A div holding only raw text never competes (it has no visible text).
  if (hasDivWithVisibleText(html)) {
    return;
  }
  assert.ok(result.success.includes(VISIBLE), "visible text was lost");
}

// True when some div's content up to its first closing tag has visible text once raw-text
// elements and tags are removed.
function hasDivWithVisibleText(html: string): boolean {
  const withoutRawText = html.replaceAll(/<(?:script|style)>.*?<\/(?:script|style)>/gu, "");
  return [...withoutRawText.matchAll(/<div>(?<inner>.*?)<\/div>/gu)].some((match) =>
    /\S/u.test((match.groups?.inner ?? "").replaceAll(/<[^>]*>/gu, "")),
  );
}

function assertConversionsSafe(html: string): void {
  assertAllowedOutcome(htmlToText(html, BASE_URL), html);
  assertAllowedOutcome(htmlToMarkdown(html, BASE_URL), html);
}

describe("html conversion fuzz", () => {
  test("random trees convert or fail with an expected error, and never leak script text", () => {
    new Hegel((tc) => {
      assertConversionsSafe(tc.draw(documentGen, "html"));
    })
      .databaseKey("pi-web-tools/html-fuzz")
      .settings(settings)
      .runSync();
  });
});
