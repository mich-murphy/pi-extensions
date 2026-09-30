import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { compileSelector, compileSelectorSet } from "../element-selector";

// Elements exercising tag, id, class-token, attribute-presence, and attribute-value matching,
// including whitespace-separated and repeated class tokens and case variations.
const DOCUMENT = `<html><body>
  <article class="markdown-body">a</article>
  <article class="x markdown-body" id="readme">b</article>
  <div class="\tmarkdown-body\n main-content  content">c</div>
  <div class="content content">d</div>
  <div class="Content">e</div>
  <div id="Content">f</div>
  <div id="bigbox" role="main">g</div>
  <div role="MAIN">h</div>
  <div data-testid="repository-readme-content">i</div>
  <div aria-hidden="true" hidden>j</div>
  <div aria-hidden="TRUE" aria-modal="true">k</div>
  <table align="LEFT"><tr><td>l</td></tr></table>
  <section class="story-list story">m</section>
  <main>n</main>
  <p class="post-content entry-content">o</p>
  <span>p</span>
  <svg class="content"><g class="story"></g></svg>
</body></html>`;

const SELECTORS = [
  "#readme",
  "[data-testid='repository-readme-content']",
  "article.markdown-body",
  ".markdown-body",
  "#bigbox",
  "article",
  "main",
  "[role='main']",
  "#content",
  "#main-content",
  ".main-content",
  ".content",
  ".post-content",
  ".entry-content",
  ".article-content",
  ".story-list",
  ".story",
  "[hidden]",
  "[aria-hidden='true']",
  "[aria-modal='true']",
  '[align="left"]',
  "header, footer, nav, [role='banner'], [hidden]",
  "#readme, [data-testid='repository-readme-content'], article.markdown-body, .markdown-body",
];

const elements = () => Array.from(parseHTML(DOCUMENT).document.querySelectorAll("*"));

describe("compileSelector", () => {
  test.each(SELECTORS)("matches %s exactly as linkedom does", (selector) => {
    const matches = compileSelector(selector);
    for (const element of elements()) {
      expect(matches(element), element.outerHTML).toBe(element.matches(selector));
    }
  });

  test.each(["div > p", "*", ":not(p)", "[class='x']", "[href^='x']", "DIV", ""])(
    "rejects the unsupported selector %j",
    (selector) => {
      expect(() => compileSelector(selector)).toThrow("Unsupported selector");
    },
  );
});

describe("compileSelectorSet", () => {
  test("reports every matching list once, as linkedom's matches would", () => {
    const match = compileSelectorSet(SELECTORS);
    for (const element of elements()) {
      const reported: number[] = [];
      match(element, (index) => reported.push(index));
      const expected = SELECTORS.flatMap((selector, index) =>
        element.matches(selector) ? [index] : [],
      );
      expect(
        reported.sort((a, b) => a - b),
        element.outerHTML,
      ).toEqual(expected);
    }
  });
});
