/**
 * HTML sanitization and conversion to markdown or plain text.
 *
 * Adapted from dmmulroy/pi-web-tools (MIT): readable-root extraction, boilerplate
 * stripping, layout-table flattening, and URL attribute resolution that removes
 * javascript:/data: URLs before conversion.
 */
import { compile as compileHtmlToText } from "html-to-text";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
// turndown-plugin-gfm does not ship ESM-friendly typings (see vendor.d.ts).
import { gfm } from "turndown-plugin-gfm";

const REMOVAL_SELECTOR = [
  "head",
  "title",
  "script",
  "style",
  "noscript",
  "template",
  "meta",
  "link",
  "iframe",
  "object",
  "embed",
  "canvas",
  "svg",
  "video",
  "audio",
  "source",
  "picture",
  "button",
  "input",
  "select",
  "textarea",
].join(", ");

const RAW_TEXT_SELECTOR = "script, style, textarea, title";

const LANDMARK_REMOVAL_SELECTOR = [
  "header",
  "footer",
  "nav",
  "aside",
  "dialog",
  "menu",
  "[role='banner']",
  "[role='navigation']",
  "[role='complementary']",
  "[role='contentinfo']",
  "[aria-modal='true']",
  "[hidden]",
  "[aria-hidden='true']",
].join(", ");

// Readable-root selectors in the order extractReadableRoot tries them. A candidate's score also gains
// the bonus of every group it matches, which ranks candidates that one selector returns.
const CONTENT_SELECTOR_GROUPS: ReadonlyArray<{
  readonly bonus: number;
  readonly selectors: ReadonlyArray<string>;
}> = [
  // Repository READMEs.
  {
    bonus: 1_500,
    selectors: [
      "#readme",
      "[data-testid='repository-readme-content']",
      "article.markdown-body",
      ".markdown-body",
    ],
  },
  // Hacker News.
  { bonus: 1_000, selectors: ["#bigbox"] },
  // Semantic and conventional main-content containers.
  {
    bonus: 500,
    selectors: ["article", "main", "[role='main']", "#content", "#main-content", ".main-content"],
  },
  // CMS and feed content wrappers: tried last, no bonus.
  {
    bonus: 0,
    selectors: [
      ".content",
      ".post-content",
      ".entry-content",
      ".article-content",
      ".story-list",
      ".story",
    ],
  },
];

const PREFERRED_CONTENT_SELECTORS = CONTENT_SELECTOR_GROUPS.flatMap((group) => group.selectors);

// Each bonus group's selectors joined into one selector list, so scoring runs one match per group.
const CONTENT_SELECTOR_BONUSES = CONTENT_SELECTOR_GROUPS.filter((group) => group.bonus !== 0).map(
  (group) => ({ bonus: group.bonus, selector: group.selectors.join(", ") }),
);

/** Resolves an attribute value against the page URL; undefined means the attribute is removed. */
type UrlAttributeResolver = (value: string, baseUrl: string) => string | undefined;

// URL-bearing attributes that sanitizeHtml rewrites. Links may not carry data: URLs; media may.
const URL_ATTRIBUTE_RESOLVERS: Readonly<Record<string, UrlAttributeResolver>> = {
  href: (value, baseUrl) => resolveAttributeUrl(value, baseUrl, "reject"),
  src: (value, baseUrl) => resolveAttributeUrl(value, baseUrl, "allow"),
  poster: (value, baseUrl) => resolveAttributeUrl(value, baseUrl, "allow"),
  srcset: resolveSrcSet,
};

const URL_ATTRIBUTE_SELECTOR = Object.keys(URL_ATTRIBUTE_RESOLVERS)
  .map((attribute) => `[${attribute}]`)
  .join(", ");

const BOILERPLATE_TOKEN_RE =
  /(^|[-_\s])(nav(?:igation)?|header|footer|sidebar|aside|menu|dialog|modal|cookie|consent|promo|advert|social|share|breadcrumb|pagination|pager|toolbar|search|newsletter|subscribe|signup|login|banner|related|recommendation)s?($|[-_\s])/i;

const RAW_HTML_BLOCK_TAG_RE =
  /<(table|tbody|thead|tfoot|tr|td|th|div|section|article|main|header|footer|nav|aside)\b/gi;

const turndown = createTurndownService();
const compiledHtmlToText = compileHtmlToText({
  baseElements: {
    selectors: ["body", "main", "article", "div"],
    returnDomByDefault: true,
  },
  wordwrap: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "table", format: "dataTable", options: { uppercaseHeaderCells: false } },
    { selector: "h1", options: { uppercase: false } },
    { selector: "h2", options: { uppercase: false } },
    { selector: "h3", options: { uppercase: false } },
    { selector: "h4", options: { uppercase: false } },
    { selector: "h5", options: { uppercase: false } },
    { selector: "h6", options: { uppercase: false } },
  ],
});

/** Strip boilerplate and unsafe URL attributes, returning sanitized HTML rooted at the readable content. */
export function sanitizeHtml(rawHtml: string, baseUrl: string): string {
  const { document } = parseHTML(rawHtml);
  const root = extractReadableRoot(document);

  for (const element of root.querySelectorAll(REMOVAL_SELECTOR)) {
    element.remove();
  }
  for (const element of root.querySelectorAll(LANDMARK_REMOVAL_SELECTOR)) {
    element.remove();
  }
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (isBoilerplateElement(element)) {
      element.remove();
    }
  }

  flattenLayoutTables(root);
  normalizeBlockLinks(root);
  removeEmptyContainers(root);

  for (const element of root.querySelectorAll(URL_ATTRIBUTE_SELECTOR)) {
    for (const [attribute, resolve] of Object.entries(URL_ATTRIBUTE_RESOLVERS)) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const resolved = resolve(value, baseUrl);
      if (resolved) {
        element.setAttribute(attribute, resolved);
      } else {
        element.removeAttribute(attribute);
      }
    }
  }

  return `<div>${root.innerHTML}</div>`;
}

/** Convert raw HTML to markdown, sanitized and with URLs resolved against baseUrl. */
export function htmlToMarkdown(rawHtml: string, baseUrl: string): string {
  const sanitizedHtml = sanitizeHtml(rawHtml, baseUrl);
  const markdown = turndown.turndown(sanitizedHtml);
  return cleanupMarkdown(markdown);
}

/** Convert raw HTML to plain text, sanitized and with URLs resolved against baseUrl. */
export function htmlToText(rawHtml: string, baseUrl: string): string {
  const sanitizedHtml = sanitizeHtml(rawHtml, baseUrl);
  const text = compiledHtmlToText(sanitizedHtml);
  return cleanupText(text);
}

/** Returns true when a markdown conversion is dominated by raw HTML blocks (JS-heavy pages). */
export function isPoorMarkdownConversion(markdown: string): boolean {
  const rawBlockTags = markdown.match(RAW_HTML_BLOCK_TAG_RE)?.length ?? 0;
  if (rawBlockTags >= 6) return true;
  if (/^\s*<(table|tbody|thead|tfoot|tr|td|th|div|section|article|main)\b/i.test(markdown))
    return true;
  return false;
}

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  service.use(gfm as never);
  // turndown-plugin-gfm reads every table's first row without checking that one exists, and turndown
  // never treats a table as blank, so a table without rows throws. Such tables reach turndown because
  // role and heading markup exempt a rowless table from flattening, and because turndown re-parses
  // the sanitized HTML with an HTML5 parser that moves misnested content out of tables. A rule added
  // later is tried first, so this one takes those tables before the plugin's rules and keeps their
  // content as plain blocks. Tables with rows never match it and convert as before.
  service.addRule("tableWithoutRows", {
    filter: (node) =>
      // SAFETY: turndown's parser gives TABLE elements the HTMLTableElement interface; the plugin
      // reads the same rows property.
      node.nodeName === "TABLE" && (node as HTMLTableElement).rows.length === 0,
    replacement: (content) => `\n\n${content}\n\n`,
  });
  return service;
}

function extractReadableRoot(document: Document): Element {
  for (const selector of PREFERRED_CONTENT_SELECTORS) {
    const match = pickBestCandidate(Array.from(document.querySelectorAll(selector)));
    if (match) {
      return cloneElement(match);
    }
  }

  const body = document.querySelector("body") ?? document.documentElement;
  const fallbackCandidates = [
    ...Array.from(body.querySelectorAll("article, main, section, div")),
    body,
  ];
  return cloneElement(pickBestCandidate(fallbackCandidates) ?? body);
}

function pickBestCandidate(elements: Element[]): Element | undefined {
  let best: Element | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    const score = scoreContentCandidate(element);
    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  }

  return best;
}

function scoreContentCandidate(element: Element): number {
  // linkedom keeps these elements' markup as text and serializes it unescaped, so as the root their
  // text would come back from sanitizeHtml as markup that was never sanitized.
  if (element.matches(RAW_TEXT_SELECTOR)) return Number.NEGATIVE_INFINITY;
  const textLength = getNormalizedText(element).length;
  if (textLength === 0) return Number.NEGATIVE_INFINITY;

  const linkTextLength = Array.from(element.querySelectorAll("a"))
    .map((link) => getNormalizedText(link).length)
    .reduce((total, value) => total + value, 0);
  const paragraphCount = element.querySelectorAll("p").length;
  const listItemCount = element.querySelectorAll("li").length;
  const headingCount = element.querySelectorAll("h1, h2, h3, h4, h5, h6").length;
  const tableCount = element.querySelectorAll("table").length;
  const ownPenalty = isBoilerplateElement(element) ? 800 : 0;
  const linkDensity = textLength > 0 ? linkTextLength / textLength : 1;

  let score = textLength;
  score -= linkDensity * 500;
  score += paragraphCount * 120;
  score += listItemCount * 45;
  score += headingCount * 80;
  score -= tableCount * 15;
  score -= ownPenalty;

  for (const { bonus, selector } of CONTENT_SELECTOR_BONUSES) {
    if (matchesAnySelector(element, selector)) {
      score += bonus;
    }
  }

  return score;
}

function flattenLayoutTables(root: Element): void {
  const tables = Array.from(root.querySelectorAll("table"));
  for (const table of tables.reverse()) {
    if (!isLikelyLayoutTable(table)) continue;
    // Only this table's own parts: flattening a nested data table's rows would leave it an empty
    // table shell once turndown's parser moves the resulting divs out of it.
    for (const child of ownTableDescendants(table, "thead, tbody, tfoot, tr, td, th").reverse()) {
      replaceTag(child, "div");
    }
    replaceTag(table, "div");
  }
}

function isLikelyLayoutTable(table: Element): boolean {
  const shape: TableShape = { table, rows: ownTableRows(table) };
  for (const rule of LAYOUT_TABLE_RULES) {
    const verdict = rule(shape);
    if (verdict !== undefined) return verdict === "layout";
  }
  return false;
}

/** A table and its own rows, each row as its td/th cells, shared by the layout-table rules. */
type TableShape = {
  readonly table: Element;
  /** Rows that belong to this table rather than to a nested one; rows without cells are left out. */
  readonly rows: ReadonlyArray<ReadonlyArray<Element>>;
};

/** A layout-table rule's verdict; undefined leaves the decision to the next rule. */
type TableVerdict = "layout" | "data" | undefined;

// Tried in order; the first verdict decides, and a table no rule decides is a data table.
const LAYOUT_TABLE_RULES: ReadonlyArray<(shape: TableShape) => TableVerdict> = [
  headingMarkupRule,
  tableRoleRule,
  hackerNewsRule,
  nestedTableRule,
  presentationalAttributeRule,
  irregularGridRule,
  linkListRule,
];

const PRESENTATIONAL_TABLE_ATTRIBUTES = [
  "align",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "width",
] as const;

function headingMarkupRule({ table }: TableShape): TableVerdict {
  return table.querySelector("caption, thead, th") ? "data" : undefined;
}

function tableRoleRule({ table }: TableShape): TableVerdict {
  const role = table.getAttribute("role");
  return role === "table" || role === "grid" ? "data" : undefined;
}

// Hacker News lays out its pages with tables.
function hackerNewsRule({ table }: TableShape): TableVerdict {
  return table.closest("#hnmain, #bigbox") ? "layout" : undefined;
}

function nestedTableRule({ table }: TableShape): TableVerdict {
  return table.querySelector("table") ? "layout" : undefined;
}

function presentationalAttributeRule({ table }: TableShape): TableVerdict {
  return PRESENTATIONAL_TABLE_ATTRIBUTES.some((attribute) => table.hasAttribute(attribute))
    ? "layout"
    : undefined;
}

// Data rows share one width of at least two cells. No rows, one column, or ragged rows mean layout.
function irregularGridRule({ rows }: TableShape): TableVerdict {
  const widths = new Set(rows.map((cells) => cells.length));
  return widths.size === 1 && !widths.has(1) ? undefined : "layout";
}

// Short cells that are mostly links make a navigation list, not data.
function linkListRule({ table, rows }: TableShape): TableVerdict {
  const cells = rows.flat();
  const linkCount = ownTableDescendants(table, "a").length;
  if (linkCount <= cells.length * 0.6) return undefined;
  const averageCellTextLength =
    cells.reduce((total, cell) => total + getNormalizedText(cell).length, 0) /
    Math.max(1, cells.length);
  return averageCellTextLength < 120 ? "layout" : undefined;
}

function ownTableRows(table: Element): ReadonlyArray<ReadonlyArray<Element>> {
  return ownTableDescendants(table, "tr")
    .map((row) => Array.from(row.children).filter((child) => child.matches("td, th")))
    .filter((cells) => cells.length > 0);
}

// Descendants whose nearest table is this one, not one nested inside it.
function ownTableDescendants(table: Element, selector: string): Element[] {
  return Array.from(table.querySelectorAll(selector)).filter(
    (element) => element.closest("table") === table,
  );
}

function normalizeBlockLinks(root: Element): void {
  for (const link of Array.from(root.querySelectorAll("a[href]"))) {
    const elementChildren = Array.from(link.children);
    if (elementChildren.length !== 1) continue;
    const [onlyChild] = elementChildren;
    if (!onlyChild?.matches("h1, h2, h3, h4, h5, h6")) continue;

    const replacementLink = link.ownerDocument.createElement("a");
    for (const attribute of ["href", "title"] as const) {
      const value = link.getAttribute(attribute);
      if (value) replacementLink.setAttribute(attribute, value);
    }
    while (onlyChild.firstChild) {
      replacementLink.appendChild(onlyChild.firstChild);
    }
    onlyChild.appendChild(replacementLink);
    link.replaceWith(onlyChild);
  }
}

function removeEmptyContainers(root: Element): void {
  for (const element of Array.from(
    root.querySelectorAll("div, section, article, main, span"),
  ).reverse()) {
    if (element.children.length > 0) continue;
    if (getNormalizedText(element).length > 0) continue;
    element.remove();
  }
}

function isBoilerplateElement(element: Element): boolean {
  const tokens = [
    element.id,
    element.getAttribute("class"),
    element.getAttribute("role"),
    element.getAttribute("aria-label"),
  ]
    .filter(Boolean)
    .join(" ");
  return BOILERPLATE_TOKEN_RE.test(tokens);
}

function matchesAnySelector(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function getNormalizedText(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function cloneElement(element: Element): Element {
  // SAFETY: cloneNode returns the same element kind.
  return element.cloneNode(true) as Element;
}

function replaceTag(element: Element, tagName: string): Element {
  const replacement = element.ownerDocument.createElement(tagName);
  while (element.firstChild) {
    replacement.appendChild(element.firstChild);
  }
  element.replaceWith(replacement);
  return replacement;
}

function resolveAttributeUrl(
  value: string | undefined,
  baseUrl: string,
  dataUrls: "allow" | "reject",
): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return undefined;
  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol === "javascript:" || resolved.protocol === "vbscript:") {
      return undefined;
    }
    if (resolved.protocol === "data:" && dataUrls === "reject") {
      return undefined;
    }
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function resolveSrcSet(srcset: string, baseUrl: string): string | undefined {
  const candidates = srcset
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [urlPart, descriptor] = entry.split(/\s+/, 2);
      const resolved = resolveAttributeUrl(urlPart, baseUrl, "allow");
      if (!resolved) return undefined;
      return descriptor ? `${resolved} ${descriptor}` : resolved;
    })
    .filter((entry): entry is string => Boolean(entry));
  return candidates.length > 0 ? candidates.join(", ") : undefined;
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(
      /\[\s*\n+(#{1,6})\s+([^\n]+?)\s*\n+\s*\]\(([^)]+)\)/g,
      (_match, hashes: string, text: string, url: string) => {
        return `${hashes} [${text.trim()}](${url})`;
      },
    )
    .replace(/^\[\]\([^)]+\)\n?/gm, "")
    .replace(/(\]\([^)]+\))(?=\[)/g, "$1 ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanupText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
