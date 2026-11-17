import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseHTML } from "linkedom";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { compileSelector, compileSelectorSet } from "../element-selector";

const settings = propertySettings(300);
const { document } = parseHTML("<html><body></body></html>");

const TAGS = ["div", "p", "a", "span", "article", "main"];
const IDS = ["a", "b", "Main"];
const TOKENS = ["a", "b", "A", "x-y"];
// Names include ones css-select compares case-insensitively (role is not, lang, type, dir are).
const ATTRIBUTES = ["role", "type", "lang", "data-x", "dir", "hidden", "title"];
const VALUES = ["main", "MAIN", "a", "A", "x-y", "true", "TRUE", ""];
const BARE_VALUES = VALUES.filter((value) => value !== "");

const attributePair = gs.tuples(gs.sampledFrom(ATTRIBUTES), gs.sampledFrom(VALUES));
const classValue = gs.tuples(
  gs.arrays(gs.sampledFrom(TOKENS), { minSize: 0, maxSize: 4 }),
  gs.sampledFrom([" ", "  ", "\t", "\n "]),
  gs.sampledFrom(["", " "]),
);

const elementGen = gs.composite((tc) => {
  const element = document.createElement(tc.draw(gs.sampledFrom(TAGS), "tag"));
  const id = tc.draw(gs.optional(gs.sampledFrom(IDS)), "id");
  if (id !== null) {
    element.setAttribute("id", id);
  }
  const [tokens, separator, pad] = tc.draw(classValue, "classes");
  if (tc.draw(gs.booleans(), "hasClass")) {
    element.setAttribute("class", `${pad}${tokens.join(separator)}${pad}`);
  }
  for (const [name, value] of tc.draw(gs.arrays(attributePair, { maxSize: 4 }), "attributes")) {
    element.setAttribute(name, value);
  }
  return element;
});

const partGen = gs.composite((tc) => {
  const kind = tc.draw(gs.sampledFrom(["id", "class", "has", "equals"]), "part");
  const name = tc.draw(gs.sampledFrom(ATTRIBUTES), "name");
  if (kind === "id") {
    return `#${tc.draw(gs.sampledFrom(IDS), "id")}`;
  }
  if (kind === "class") {
    return `.${tc.draw(gs.sampledFrom(TOKENS), "token")}`;
  }
  if (kind === "has") {
    return tc.draw(gs.booleans(), "class") ? "[class]" : `[${name}]`;
  }
  const quote = tc.draw(gs.sampledFrom(["", "'", '"']), "quote");
  const value = tc.draw(gs.sampledFrom(quote === "" ? BARE_VALUES : VALUES), "value");
  return `[${name}=${quote}${value}${quote}]`;
});

const compoundGen = gs.composite((tc) => {
  const tag = tc.draw(gs.optional(gs.sampledFrom(TAGS)), "tag") ?? "";
  const parts = tc.draw(gs.arrays(partGen, { maxSize: 3 }), "parts");
  tc.assume(tag !== "" || parts.length > 0);
  return `${tag}${parts.join("")}`;
});

const listGen = gs.composite((tc) => {
  const compounds = tc.draw(gs.arrays(compoundGen, { minSize: 1, maxSize: 3 }), "compounds");
  return compounds.join(tc.draw(gs.sampledFrom([",", ", ", " ,  "]), "separator"));
});

function assertListsAgree(element: Element, lists: readonly string[]): void {
  const expectedIndexes: number[] = [];
  for (const [index, list] of lists.entries()) {
    const expected = element.matches(list);
    assert.equal(compileSelector(list)(element), expected, `compileSelector ${list}`);
    if (expected) {
      expectedIndexes.push(index);
    }
  }
  const reported: number[] = [];
  compileSelectorSet(lists)(element, (index) => reported.push(index));
  assert.deepEqual(
    reported.toSorted((a, b) => a - b),
    expectedIndexes,
    `set matcher over ${JSON.stringify(lists)} for ${element.outerHTML}`,
  );
}

const recaseFlags = gs.arrays(gs.booleans(), { minSize: 8, maxSize: 8 });
function recase(value: string, flags: readonly boolean[]): string {
  return Array.from({ length: value.length }, (_, i) =>
    flags[i] === true ? value.charAt(i).toUpperCase() : value.charAt(i).toLowerCase(),
  ).join("");
}

// Same attribute on both sides with independently re-cased values, so the case-insensitive
// attribute list (type, lang, dir, ...) is exercised on every draw.
function assertAttributeCase(name: string, elementValue: string, selectorValue: string): void {
  const element = document.createElement("div");
  element.setAttribute(name, elementValue);
  const list = `[${name}='${selectorValue}']`;
  assert.equal(compileSelector(list)(element), element.matches(list), `${list} on ${elementValue}`);
}

describe("selector properties", () => {
  test("attribute equality case rules agree with linkedom", () => {
    new Hegel((tc) => {
      assertAttributeCase(
        tc.draw(gs.sampledFrom(ATTRIBUTES), "name"),
        recase(tc.draw(gs.sampledFrom(VALUES), "value"), tc.draw(recaseFlags, "elementCase")),
        recase(tc.draw(gs.sampledFrom(VALUES), "value2"), tc.draw(recaseFlags, "selectorCase")),
      );
    })
      .settings(settings)
      .runSync();
  });

  test("compiled selectors and sets agree with linkedom Element.matches", () => {
    new Hegel((tc) => {
      assertListsAgree(
        tc.draw(elementGen, "element"),
        tc.draw(gs.arrays(listGen, { minSize: 1, maxSize: 4 }), "lists"),
      );
    })
      .settings(settings)
      .runSync();
  });
});
