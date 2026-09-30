import { describe, expect, test } from "vitest";
import { htmlToMarkdown, htmlToText, isPoorMarkdownConversion, sanitizeHtml } from "../html";

describe("htmlToMarkdown", () => {
  test("converts headings, links, and lists", () => {
    const html = `<html><body><article>
      <h1>Title</h1>
      <p>Some <a href="/relative">link</a> text</p>
      <ul><li>one</li><li>two</li></ul>
    </article></body></html>`;
    const markdown = htmlToMarkdown(html, "https://example.com/docs/");
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("[link](https://example.com/relative)");
    expect(markdown).toMatch(/-\s+one/);
  });

  test("strips scripts, styles, and boilerplate chrome", () => {
    const html = `<html><head><script>alert(1)</script></head><body>
      <nav>Home | Away</nav>
      <article><p>the actual article body text here</p></article>
      <footer>copyright</footer>
    </body></html>`;
    const markdown = htmlToMarkdown(html, "https://example.com");
    expect(markdown).toContain("the actual article body text");
    expect(markdown).not.toContain("alert(1)");
    expect(markdown).not.toContain("copyright");
  });

  test("removes javascript: URLs from links", () => {
    const sanitized = sanitizeHtml(
      '<html><body><article><p><a href="javascript:alert(1)">x</a></p></article></body></html>',
      "https://example.com",
    );
    expect(sanitized).not.toContain("javascript:");
  });
});

describe("htmlToText", () => {
  test("produces readable plain text", () => {
    const text = htmlToText(
      "<html><body><article><h1>Hi</h1><p>words here</p></article></body></html>",
      "https://example.com",
    );
    expect(text).toContain("Hi");
    expect(text).toContain("words here");
    expect(text).not.toContain("<p>");
  });
});

describe("isPoorMarkdownConversion", () => {
  test("detects raw-HTML-dominated conversions", () => {
    expect(
      isPoorMarkdownConversion(
        "<div><div><div><table><tr><td>x</td></tr></table></div></div></div>",
      ),
    ).toBe(true);
    expect(isPoorMarkdownConversion("# Real markdown\n\nSome text content.")).toBe(false);
  });
});

describe("readable root extraction", () => {
  // Every preferred selector in priority order, with an element that matches it.
  const preferredRoots = [
    ["#readme", "div", 'id="readme"'],
    ["[data-testid='repository-readme-content']", "div", 'data-testid="repository-readme-content"'],
    ["article.markdown-body", "article", 'class="markdown-body"'],
    [".markdown-body", "div", 'class="markdown-body"'],
    ["#bigbox", "div", 'id="bigbox"'],
    ["article", "article", ""],
    ["main", "main", ""],
    ["[role='main']", "div", 'role="main"'],
    ["#content", "div", 'id="content"'],
    ["#main-content", "div", 'id="main-content"'],
    [".main-content", "div", 'class="main-content"'],
    [".content", "div", 'class="content"'],
    [".post-content", "div", 'class="post-content"'],
    [".entry-content", "div", 'class="entry-content"'],
    [".article-content", "div", 'class="article-content"'],
    [".story-list", "div", 'class="story-list"'],
    [".story", "div", 'class="story"'],
  ] as const;

  for (const [index, [earlier, earlierTag, earlierAttributes]] of preferredRoots.entries()) {
    const next = preferredRoots[index + 1];
    if (!next) continue;
    const [later, laterTag, laterAttributes] = next;
    test(`prefers ${earlier} over ${later}, whatever the order and length`, () => {
      const html = `<html><body>
        <${laterTag} ${laterAttributes}><p>later root ${"filler ".repeat(200)}</p></${laterTag}>
        <${earlierTag} ${earlierAttributes}><p>earlier root</p></${earlierTag}>
      </body></html>`;
      const text = htmlToText(html, "https://example.com");
      expect(text).toContain("earlier root");
      expect(text).not.toContain("later root");
    });
  }

  // Both candidates match .markdown-body (+1500). The shorter one wins only if its bonus from a
  // second group is added on top: the filler outweighs half that bonus.
  const bonusCases = [
    ["main-content", 'class="markdown-body main-content"', 500],
    ["#bigbox", 'class="markdown-body" id="bigbox"', 1_000],
  ] as const;
  for (const [label, attributes, bonus] of bonusCases) {
    test(`adds the ${label} bonus to a .markdown-body candidate`, () => {
      const filler = "x".repeat(bonus / 2);
      const html = `<html><body>
        <div class="markdown-body"><p>plain candidate ${filler}</p></div>
        <div ${attributes}><p>bonus candidate</p></div>
      </body></html>`;
      const text = htmlToText(html, "https://example.com");
      expect(text).toContain("bonus candidate");
      expect(text).not.toContain("plain candidate");
    });
  }
});

describe("htmlToMarkdown block links", () => {
  test.each([
    [
      "moves a link wrapping only a heading inside the heading",
      '<a href="/x" title="T"><h2>Heading <em>one</em></h2></a><p>body</p>',
      '## [Heading *one*](https://example.com/x "T")\n\nbody',
    ],
    [
      "ignores whitespace around the heading",
      '<a href="/w">\n  <h4>Spaced</h4>\n</a>',
      "#### [Spaced](https://example.com/w)",
    ],
    [
      "leaves a link with several element children",
      '<a href="/y"><h3>A</h3><p>b</p></a>',
      "[\n\n### A\n\nb\n\n](https://example.com/y)",
    ],
    [
      "leaves a link whose only child is not a heading",
      '<a href="/z"><span>not heading</span></a>',
      "[not heading](https://example.com/z)",
    ],
  ])("%s", (_label, content, expected) => {
    const html = `<html><body><article>${content}</article></body></html>`;
    expect(htmlToMarkdown(html, "https://example.com")).toBe(expected);
  });
});

describe("htmlToMarkdown on large documents", () => {
  // Large enough, with enough children in one container, that the conversion runs in chunks.
  const paragraphs = Array.from(
    { length: 3_000 },
    (_, index) => `Paragraph ${index} with some words to fill the line out.`,
  );

  test("converts a large flat document as a single pass would", () => {
    const html = `<html><body><article><section>\n${paragraphs
      .map((text) => `<p>${text}</p>`)
      .join("\n")}\n</section></article></body></html>`;
    expect(html.length).toBeGreaterThan(128 * 1024);
    expect(htmlToMarkdown(html, "https://example.com")).toBe(paragraphs.join("\n\n"));
  });

  test("keeps edge whitespace, preformatted text, and misnested lists across chunk edges", () => {
    const blocks = paragraphs.map((text, index) => {
      if (index % 500 === 499) return `<pre>\tcode ${index}</pre>`;
      if (index % 700 === 699) return `<ol><li><div><li>nested ${index}</li></div></li></ol>`;
      return `<p>${text}&nbsp;</p>`;
    });
    // What a single pass produces for each block: a bare pre keeps its leading tab unfenced, the
    // HTML parser closes the outer list item before the misnested one, and the trailing
    // no-break space survives.
    const expected = paragraphs.map((text, index) => {
      if (index % 500 === 499) return `\tcode ${index}`;
      if (index % 700 === 699) return `2.  nested ${index}`;
      return `${text} `;
    });
    const markdown = htmlToMarkdown(
      `<html><body><article>${blocks.join("")}</article></body></html>`,
      "https://example.com",
    );
    expect(markdown).toBe(expected.join("\n\n").trim());
  });
});

describe("htmlToMarkdown tables", () => {
  const inArticle = (content: string) => `<html><body><article>${content}</article></body></html>`;

  test("converts a table with a heading row to a GFM table", () => {
    const markdown = htmlToMarkdown(
      inArticle(`<table>
        <thead><tr><th>Name</th><th align="right">Count</th></tr></thead>
        <tbody><tr><td>apples</td><td>3</td></tr><tr><td>pears</td><td>5</td></tr></tbody>
      </table>`),
      "https://example.com",
    );
    expect(markdown).toBe("| Name | Count |\n| --- | --: |\n| apples | 3 |\n| pears | 5 |");
  });

  // Reduced from generated documents on which turndown-plugin-gfm threw reading a missing first row.
  test.each([
    ["a caption and no rows", "<table><caption>Totals</caption></table>", "Totals"],
    ["an ARIA grid role and no rows", '<table role="grid">loose text</table>', "loose text"],
    [
      "rows the HTML5 parser moves out of it",
      "<table><math><tr><td>a</td><td>b</td></tr></math></table>",
      "| a | b |",
    ],
  ])("keeps the content of a table with %s", (_label, table, content) => {
    const markdown = htmlToMarkdown(
      inArticle(`<p>before</p>${table}<p>after</p>`),
      "https://example.com",
    );
    expect(markdown).toBe(`before\n\n${content}\n\nafter`);
  });

  test("keeps a data table nested in a layout table", () => {
    const markdown = htmlToMarkdown(
      inArticle(`<table><tr>
        <td><table><tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td><td>delta</td></tr></table></td>
        <td>sidebar</td>
      </tr></table>`),
      "https://example.com",
    );
    expect(markdown).toBe(
      "<table><tbody><tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td><td>delta</td></tr></tbody></table>\n\nsidebar",
    );
  });

  test.each(["script", "style", "textarea", "title"])(
    "never takes a %s as the readable root",
    (tag) => {
      const html = `<html><body><p>visible</p>
        <${tag} id="content"><table><tr><td><a href="javascript:alert(1)">run</a></td></tr></table></${tag}>
      </body></html>`;
      expect(sanitizeHtml(html, "https://example.com")).not.toContain("javascript:");
      expect(htmlToMarkdown(html, "https://example.com")).toBe("visible");
    },
  );
});

describe("layout table detection", () => {
  // sanitizeHtml keeps a data table and flattens a layout table to divs. Each case is decided by
  // the named rule; where a later rule would decide otherwise, the case proves the rule order.
  const grid = "<tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td><td>delta</td></tr>";
  const longLink = (href: string) => `<a href="${href}">${"words ".repeat(25)}</a>`;
  const cases: ReadonlyArray<readonly [string, "data" | "layout", string]> = [
    ["a caption", "data", `<table border="1"><caption>c</caption>${grid}</table>`],
    ["a thead", "data", `<table border="1"><thead></thead>${grid}</table>`],
    ["a th", "data", `<table border="1"><tr><th>h</th><th>i</th></tr>${grid}</table>`],
    ["the table role", "data", `<table role="table" border="1">${grid}</table>`],
    ["the grid role", "data", `<table role="grid" border="1">${grid}</table>`],
    ["a Hacker News story box", "layout", `<div id="bigbox"><table>${grid}</table></div>`],
    ["the Hacker News main id", "layout", `<table id="hnmain">${grid}</table>`],
    ...["align", "bgcolor", "border", "cellpadding", "cellspacing", "width"].map(
      (attribute) =>
        [`a ${attribute} attribute`, "layout", `<table ${attribute}="1">${grid}</table>`] as const,
    ),
    ["no rows", "layout", "<table><tbody>text</tbody></table>"],
    ["rows without cells", "layout", "<table><tr></tr><tr>text</tr></table>"],
    ["a single column", "layout", "<table><tr><td>alpha</td></tr><tr><td>beta</td></tr></table>"],
    ["ragged rows", "layout", "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>"],
    [
      "short linked cells",
      "layout",
      '<table><tr><td><a href="/a">a</a></td><td><a href="/b">b</a></td></tr></table>',
    ],
    [
      "long linked cells",
      "data",
      `<table><tr><td>${longLink("/a")}</td><td>${longLink("/b")}</td></tr></table>`,
    ],
    ["few links", "data", '<table><tr><td><a href="/a">a</a></td><td>b</td></tr></table>'],
    ["a uniform grid", "data", `<table>${grid}</table>`],
  ];

  test.each(cases)("treats a table with %s as a %s table", (_label, verdict, table) => {
    const sanitized = sanitizeHtml(
      `<html><body><article>${table}</article></body></html>`,
      "https://example.com",
    );
    expect(sanitized.includes("<table")).toBe(verdict === "data");
  });

  test("ignores a Hacker News id on an ancestor outside the readable root", () => {
    const sanitized = sanitizeHtml(
      `<html><body><div id="hnmain"><article><table>${grid}</table></article></div></body></html>`,
      "https://example.com",
    );
    expect(sanitized).toBe(`<div><table>${grid}</table></div>`);
  });

  test("flattens a table that contains another table and keeps the inner one", () => {
    const sanitized = sanitizeHtml(
      `<html><body><article><table><tr><td><table>${grid}</table></td><td>side</td></tr></table></article></body></html>`,
      "https://example.com",
    );
    expect(sanitized.match(/<table/g)).toHaveLength(1);
    expect(sanitized).toContain(`<table>${grid}</table>`);
  });
});

describe("sanitizeHtml URL attributes", () => {
  test("resolves or removes href, src, and srcset", () => {
    const sanitized = sanitizeHtml(
      `<html><body><article><p>
        <a href="data:text/html,x">data link</a>
        <a href="/docs">relative link</a>
        <img src="data:image/png;base64,AAAA" srcset="/a.png 1x, javascript:alert(1) 2x">
        <img src="javascript:alert(1)" srcset="javascript:alert(1)">
      </p></article></body></html>`,
      "https://example.com/base/",
    );
    expect(sanitized).not.toContain("data:text/html");
    expect(sanitized).toContain('href="https://example.com/docs"');
    expect(sanitized).toContain('src="data:image/png;base64,AAAA"');
    expect(sanitized).toContain('srcset="https://example.com/a.png 1x"');
    expect(sanitized).not.toContain("javascript:");
  });
});
