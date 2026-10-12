import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { htmlToText } from "../html";

describe("readable-root measurement", () => {
  test("equal-score candidates retain document order", () => {
    const html =
      '<div class="markdown-body"><p>first winner</p></div>' +
      '<div class="markdown-body"><p>other winner</p></div>';

    expect(htmlToText(html, "https://example.com")).toStrictEqual(Result.succeed("first winner"));
  });

  test("descendant templates do not contribute paragraph counts or readable-root candidates", () => {
    const templateParagraphs = "<p>x</p>".repeat(20);
    const visibleText = `second candidate ${"x".repeat(50)}`;
    const html =
      '<div class="markdown-body">first candidate<template>' +
      `<div class="markdown-body">hidden candidate${templateParagraphs}</div>` +
      `</template></div><div class="markdown-body"><p>${visibleText}</p></div>`;

    expect(htmlToText(html, "https://example.com")).toStrictEqual(Result.succeed(visibleText));
  });
});
