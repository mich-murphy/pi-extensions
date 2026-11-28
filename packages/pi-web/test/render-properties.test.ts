import assert from "node:assert/strict";
import { initTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import { arrays, booleans, sampledFrom, text } from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { displayText } from "../render";
import { createWebFetchTool } from "../webfetch";
import { createWebSearchTool } from "../websearch";
import { redactorFor, renderText, settingsFrom, toolRuntimeWith } from "./fakes";

initTheme("dark");

const settings = propertySettings(200);
const SETTINGS = settingsFrom();
const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value };

const fetchTool = createWebFetchTool({
  settings: SETTINGS,
  redactText: redactorFor(),
  runtime: toolRuntimeWith({ settings: SETTINGS }),
});

const searchTool = createWebSearchTool({
  settings: SETTINGS,
  redactText: redactorFor(),
  runtime: toolRuntimeWith({ settings: SETTINGS }),
});

const FRAGMENTS = [
  "page text",
  "\u001B[2J",
  "\u001B]0;title\u0007",
  "\u001B[31m",
  "\u009B2J",
  "\u0008",
  "\r",
  "\n",
  "\t",
  "\u007F",
  "‮",
  "⁦",
  "‏",
  "漢字",
  "é",
];

const UNSAFE = /(?!\n)[\p{Cc}\p{Bidi_Control}]/u;

function hostile(tc: TestCase, label: string): string {
  const fragments = tc.draw(arrays(sampledFrom(FRAGMENTS), { maxSize: 8 }), label);

  return fragments.join("") + tc.draw(text({ maxSize: 20 }), `${label}-text`);
}

const EXPAND_HINT = keyHint("app.tools.expand", "for details");

function assertSafe(rendered: string): void {
  const untrusted = rendered.replaceAll(EXPAND_HINT, "");
  assert.doesNotMatch(untrusted, UNSAFE, JSON.stringify(untrusted));
}

describe("untrusted text reaches the terminal without control or bidi characters", () => {
  test("displayText keeps newlines and printable text and drops the rest", () => {
    new Hegel((tc) => {
      const value = hostile(tc, "value");
      const shown = displayText(value);
      assertSafe(shown);
      assert.equal(shown.split("\n").length, value.split("\n").length);
      assert.equal(displayText(shown), shown);
    })
      .settings(settings)
      .runSync();
  });

  test("webfetch call and result rendering", () => {
    new Hegel((tc) => {
      const body = hostile(tc, "body");
      const options = { expanded: tc.draw(booleans(), "expanded"), isPartial: false };

      const details = {
        requestedUrl: "https://example.com/",
        finalUrl: `https://example.com/${hostile(tc, "url")}`,
        format: "markdown" as const,
        status: 200,
        mime: hostile(tc, "mime"),
        contentType: "text/html",
        bytes: 10,
        image: tc.draw(booleans(), "image"),
      };

      const content = [{ type: "text", text: body }];
      assertSafe(
        renderText(
          fetchTool.renderResult({ content, details }, options, theme, { isError: false }),
        ),
      );
      const error = renderText(
        fetchTool.renderResult({ content }, options, theme, { isError: true }),
      );
      assert.match(error, /^✗/u);
      assertSafe(error);
      assertSafe(renderText(fetchTool.renderCall({ url: `https://example.com/${body}` }, theme)));
    })
      .settings(settings)
      .runSync();
  });

  test("websearch call and result rendering", () => {
    new Hegel((tc) => {
      const body = hostile(tc, "body");
      const options = { expanded: tc.draw(booleans(), "expanded"), isPartial: false };

      const details = {
        query: "q",
        maxResults: 8,
        resultCount: 1,
        provider: "exa" as const,
        attemptedProviders: ["exa" as const],
        truncated: false,
      };

      const content = [{ type: "text", text: body }];
      assertSafe(
        renderText(
          searchTool.renderResult({ content, details }, options, theme, { isError: false }),
        ),
      );
      const error = renderText(
        searchTool.renderResult({ content }, options, theme, { isError: true }),
      );
      assert.match(error, /^✗/u);
      assertSafe(error);
      assertSafe(renderText(searchTool.renderCall({ query: body }, theme)));
    })
      .settings(settings)
      .runSync();
  });
});
