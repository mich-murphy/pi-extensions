import assert from "node:assert/strict";
import { basename } from "node:path";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { instructionHeading } from "../instruction-heading";
import { assertProperty } from "./hegel-property";

const path = "/repo/README.md";

const words = gs
  .text({ alphabet: "abcd ", minSize: 1, maxSize: 12 })
  .map((text) => text.trim())
  .filter((text) => text !== "" && text.toLowerCase() !== basename(path).toLowerCase());

/** Blocks that hold `#` lines but must not be read as the heading. */
const PREFIXES: readonly string[] = [
  "```\n# Fenced\n```\n",
  "~~~~\n# Tilde\n~~~~\n",
  "<!--\n# Commented\n-->\n",
  "<!-- # inline -->\n",
  "---\n# not-a-heading\ntitle: x\n---\n",
];

function assertWellFormed(heading: string): void {
  assert.ok(!/[\r\n]/u.test(heading), JSON.stringify(heading));
  assert.equal(heading, heading.trim());
  assert.notEqual(heading.toLowerCase(), basename(path).toLowerCase());
}

function assertStable(heading: string, prefix: number, bom: boolean, crlf: boolean): void {
  let content = `${PREFIXES[prefix] ?? ""}# ${heading}\nbody\n`;
  content = crlf ? content.replaceAll("\n", "\r\n") : content;
  content = bom ? `﻿${content}` : content;
  assert.equal(instructionHeading(content, path), heading, JSON.stringify(content));
}

describe("instruction heading properties", () => {
  test("never throws and returns a clean heading for arbitrary text", () => {
    assertProperty(
      "instruction-heading",
      "never throws and returns a clean heading for arbitrary text",
      (tc) => {
        const content = tc.draw(
          gs.text({ alphabet: "#=- \t\r\n`~<!>ab.md", maxSize: 60 }),
          "content",
        );
        assertWellFormed(instructionHeading(content, path));
      },
    );
  });

  test("prefixes, CRLF and a BOM do not change the heading", () => {
    assertProperty(
      "instruction-heading",
      "prefixes, CRLF and a BOM do not change the heading",
      (tc) => {
        const heading = tc.draw(words, "heading");
        const prefix = tc.draw(gs.integers({ minValue: 0, maxValue: PREFIXES.length }), "prefix");
        assertStable(
          heading,
          prefix,
          tc.draw(gs.booleans(), "bom"),
          tc.draw(gs.booleans(), "crlf"),
        );
      },
    );
  });
});
