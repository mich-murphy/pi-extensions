/**
 * HTML sanitization and conversion to markdown or plain text.
 *
 * Adapted from dmmulroy/pi-web-tools (MIT): readable-root extraction, boilerplate
 * stripping, layout-table flattening, and URL attribute resolution that removes
 * javascript:/data: URLs before conversion.
 *
 * linkedom compiles a css-select matcher and walks the whole subtree on every querySelectorAll,
 * matches, and closest call. The passes here walk the tree directly instead, with selectors compiled
 * once (element-selector.ts), and measure every readable-root candidate in one bottom-up walk. Each
 * pass reproduces the semantics of the selector queries it replaces, so the output is unchanged.
 */
// turndown's own HTML parser in Node; chunked conversion parses with it (see convertToMarkdown).
import { createDocument } from "@mixmark-io/domino";
import { Result } from "effect";
import { compile as compileHtmlToText } from "html-to-text";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
// turndown-plugin-gfm does not ship ESM-friendly typings (see vendor.d.ts).
import { gfm } from "turndown-plugin-gfm";
import { CollapsedTextLength, normalizedTextLength } from "./collapsed-text";
import { compileSelector, compileSelectorSet } from "./element-selector";
import { convertGuarded, EmptyHtmlDocument } from "./html-conversion";
import type { HtmlConversionError } from "./html-conversion";

const ELEMENT_NODE = 1;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const COMMENT_NODE = 8;

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

// Elements removed with their subtrees. Removing them in one document-order walk, together with
// boilerplate-attributed elements, leaves the same tree as separate passes: each removal depends only
// on the element's own tag and attributes.
const isRemovedElement = compileSelector(`${REMOVAL_SELECTOR}, ${LANDMARK_REMOVAL_SELECTOR}`);

// linkedom keeps these elements' markup as text and serializes it unescaped, so as the root their
// text would come back from sanitizeHtml as markup that was never sanitized.
const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);
const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const FALLBACK_CONTENT_TAGS: ReadonlySet<string> = new Set(["article", "main", "section", "div"]);
const EMPTY_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  "div",
  "section",
  "article",
  "main",
  "span",
]);
const TABLE_PART_TAGS: ReadonlySet<string> = new Set(["thead", "tbody", "tfoot", "tr", "td", "th"]);
const TABLE_HEADING_MARKUP_TAGS: ReadonlySet<string> = new Set(["caption", "thead", "th"]);
const TABLE_CELL_TAGS: ReadonlySet<string> = new Set(["td", "th"]);

// Readable-root selectors in the order extractReadableRoot tries them. A candidate's score also gains
// the bonus of every group it matches, which ranks candidates that one selector returns.
const CONTENT_SELECTOR_GROUPS: readonly {
  readonly bonus: number;
  readonly selectors: readonly string[];
}[] = [
  // Repository READMEs.
  {
    bonus: 1500,
    selectors: [
      "#readme",
      "[data-testid='repository-readme-content']",
      "article.markdown-body",
      ".markdown-body",
    ],
  },
  // Hacker News.
  { bonus: 1000, selectors: ["#bigbox"] },
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

const PREFERRED_CONTENT_SELECTORS: readonly string[] = CONTENT_SELECTOR_GROUPS.flatMap(
  (group) => group.selectors,
);
// All preferred selectors tested together; a match reports the selector's index.
const matchPreferredContent = compileSelectorSet(PREFERRED_CONTENT_SELECTORS);

// Each bonus group's selectors compiled into one predicate, so scoring runs one match per group.
const CONTENT_SELECTOR_BONUSES = CONTENT_SELECTOR_GROUPS.filter((group) => group.bonus !== 0).map(
  (group) => ({ bonus: group.bonus, matches: compileSelector(group.selectors.join(", ")) }),
);

/** Resolves an attribute value against the page URL; undefined means the attribute is removed. */
type UrlAttributeResolver = (value: string, baseUrl: string) => string | undefined;

// URL-bearing attributes that sanitizeHtml rewrites, in rewrite order. Links may not carry data:
// URLs; media may.
const URL_ATTRIBUTE_RESOLVERS: readonly (readonly [string, UrlAttributeResolver])[] = [
  ["href", (value, baseUrl) => resolveAttributeUrl(value, baseUrl, "reject")],
  ["src", (value, baseUrl) => resolveAttributeUrl(value, baseUrl, "allow")],
  ["poster", (value, baseUrl) => resolveAttributeUrl(value, baseUrl, "allow")],
  ["srcset", resolveSrcSet],
];

const BOILERPLATE_TOKEN_RE =
  /(?:^|[-_\s])(?:nav(?:igation)?|header|footer|sidebar|aside|menu|dialog|modal|cookie|consent|promo|advert|social|share|breadcrumb|pagination|pager|toolbar|search|newsletter|subscribe|signup|login|banner|related|recommendation)s?(?:$|[-_\s])/iu;

const RAW_HTML_BLOCK_TAG_RE =
  /<(?:table|tbody|thead|tfoot|tr|td|th|div|section|article|main|header|footer|nav|aside)\b/giu;

// turndown joins each node's replacement onto the accumulated output, flattening it every time, so
// converting a large flat document is quadratic in its size. Past this input size the sanitized
// root is converted in chunks of about the target text size (see convertToMarkdown).
const TURNDOWN_CHUNK_MIN_INPUT_BYTES = 128 * 1024;
const TURNDOWN_CHUNK_TARGET_CHARS = 16 * 1024;
// The join's cost grows with the number of children one container accumulates. Below this many
// children in the chunked container, parsing for chunks costs more than the join it saves.
const TURNDOWN_CHUNK_MIN_CHILDREN = 400;

// Children a chunk may start with: blocks whose every replacement (rule, blank, or keep) starts
// with "\n\n", so the join before them does not depend on what precedes them. Left out: li, tr, td,
// th, table sections, dd, and dt, whose replacements do not start with "\n\n" or depend on their
// siblings; html, body, frameset, and form.
const CHUNK_BOUNDARY_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "dir",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

// A private-use character that marks chunk edges; documents that contain it are not chunked.
const CHUNK_SENTINEL = "\uE000";

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
export function sanitizeHtml(
  rawHtml: string,
  baseUrl: string,
): Result.Result<string, EmptyHtmlDocument> {
  const root = sanitizeToReadableRoot(rawHtml, baseUrl);
  return root === undefined
    ? Result.fail(new EmptyHtmlDocument())
    : Result.succeed(`<div>${root.innerHTML}</div>`);
}

/** Convert raw HTML to markdown, sanitized and with URLs resolved against baseUrl. */
export function htmlToMarkdown(
  rawHtml: string,
  baseUrl: string,
): Result.Result<string, HtmlConversionError> {
  const root = sanitizeToReadableRoot(rawHtml, baseUrl);
  if (root === undefined) {
    return Result.fail(new EmptyHtmlDocument());
  }
  return Result.map(
    convertGuarded(() => convertToMarkdown(root.innerHTML, root)),
    cleanupMarkdown,
  );
}

/** Convert raw HTML to plain text, sanitized and with URLs resolved against baseUrl. */
export function htmlToText(
  rawHtml: string,
  baseUrl: string,
): Result.Result<string, HtmlConversionError> {
  const sanitized = sanitizeHtml(rawHtml, baseUrl);
  if (Result.isFailure(sanitized)) {
    return Result.fail(sanitized.failure);
  }
  return Result.map(
    convertGuarded(() => compiledHtmlToText(sanitized.success)),
    cleanupText,
  );
}

/**
 * Convert raw HTML to markdown, falling back to plain text when the markdown is dominated by raw
 * HTML blocks (JS-heavy pages). Sanitizes once and reuses the result for the fallback.
 */
export function htmlToMarkdownWithTextFallback(
  rawHtml: string,
  baseUrl: string,
): Result.Result<string, HtmlConversionError> {
  const root = sanitizeToReadableRoot(rawHtml, baseUrl);
  if (root === undefined) {
    return Result.fail(new EmptyHtmlDocument());
  }
  const html = root.innerHTML;
  const markdown = convertGuarded(() => convertToMarkdown(html, root));
  if (Result.isFailure(markdown)) {
    return Result.fail(markdown.failure);
  }
  const cleaned = cleanupMarkdown(markdown.success);
  if (!isPoorMarkdownConversion(cleaned)) {
    return Result.succeed(cleaned);
  }
  return Result.map(
    convertGuarded(() => compiledHtmlToText(`<div>${html}</div>`)),
    cleanupText,
  );
}

// True when a markdown conversion is dominated by raw HTML blocks (JS-heavy pages).
function isPoorMarkdownConversion(markdown: string): boolean {
  const rawBlockTags = markdown.match(RAW_HTML_BLOCK_TAG_RE)?.length ?? 0;
  if (rawBlockTags >= 6) {
    return true;
  }
  if (/^\s*<(?:table|tbody|thead|tfoot|tr|td|th|div|section|article|main)\b/iu.test(markdown)) {
    return true;
  }
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
  service.use(gfm);
  // turndown-plugin-gfm reads every table's first row without checking that one exists, and turndown
  // never treats a table as blank, so a table without rows throws. Such tables reach turndown because
  // role and heading markup exempt a rowless table from flattening, and because turndown re-parses
  // the sanitized HTML with an HTML5 parser that moves misnested content out of tables. A rule added
  // later is tried first, so this one takes those tables before the plugin's rules and keeps their
  // content as plain blocks. Tables with rows never match it and convert as before.
  service.addRule("tableWithoutRows", {
    filter: (node) => isTableElement(node) && node.rows.length === 0,
    replacement: (content) => `\n\n${content}\n\n`,
  });
  return service;
}

/**
 * Parse, pick the readable root, and strip boilerplate and unsafe URL attributes from it. The root
 * stays attached to its parsed document, which is local to this call, so it is mutated in place.
 */
function sanitizeToReadableRoot(rawHtml: string, baseUrl: string): Element | undefined {
  const { document } = parseHTML(rawHtml);
  const root = extractReadableRoot(document);
  if (root === undefined) {
    return undefined;
  }
  const { tables, links } = removeBoilerplate(root);
  flattenLayoutTables(tables, root);
  normalizeBlockLinks(links);
  removeEmptyContainersAndResolveUrls(root, baseUrl);
  return root;
}

// Candidates come from querySelectorAll, which skips template contents, and are tried selector by
// selector; the first selector with a scoring candidate decides. Without one, body (or the document
// element) and its article, main, section, and div descendants compete.
/** Pick the readable root, or undefined when the document has no elements at all. */
function extractReadableRoot(document: Document): Element | undefined {
  const buckets: Element[][] = PREFERRED_CONTENT_SELECTORS.map(() => []);
  let body: Element | undefined;
  for (const element of document.querySelectorAll("*")) {
    if (body === undefined && element.localName === "body") {
      body = element;
    }
    matchPreferredContent(element, (index) => {
      buckets[index]?.push(element);
    });
  }

  for (const candidates of buckets) {
    const match = pickPreferredCandidate(candidates);
    if (match) {
      return match;
    }
  }

  const fallbackRoot: Element | null = body ?? document.documentElement;
  if (fallbackRoot === null) {
    return undefined;
  }
  const { candidates, stats } = measureContent(
    fallbackRoot,
    (element, inTemplateContent) =>
      !inTemplateContent && FALLBACK_CONTENT_TAGS.has(element.localName),
  );
  candidates.push(fallbackRoot);
  return pickBestCandidate(candidates, stats) ?? fallbackRoot;
}

function pickPreferredCandidate(candidates: readonly Element[]): Element | undefined {
  const [only] = candidates;
  if (only === undefined) {
    return undefined;
  }
  if (candidates.length === 1) {
    // A lone candidate wins whenever it scores at all: it is not raw text and has visible text.
    return !RAW_TEXT_TAGS.has(only.localName) && /\S/u.test(only.textContent ?? "")
      ? only
      : undefined;
  }

  // Measure each outermost candidate's subtree once; nested candidates are measured on the way.
  const wanted = new Set(candidates);
  const stats = new Map<Element, ContentStats>();
  let outermost: Element | undefined;
  for (const candidate of candidates) {
    if (outermost?.contains(candidate) === true) {
      continue;
    }
    outermost = candidate;
    const measured = measureContent(candidate, (element) => wanted.has(element));
    for (const [element, elementStats] of measured.stats) {
      stats.set(element, elementStats);
    }
  }
  return pickBestCandidate(candidates, stats);
}

function pickBestCandidate(
  candidates: readonly Element[],
  stats: ReadonlyMap<Element, ContentStats>,
): Element | undefined {
  let best: Element | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const candidateStats = stats.get(candidate);
    if (!candidateStats) {
      continue;
    }
    const score = scoreContentCandidate(candidate, candidateStats);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function scoreContentCandidate(element: Element, stats: Readonly<ContentStats>): number {
  if (RAW_TEXT_TAGS.has(element.localName)) {
    return Number.NEGATIVE_INFINITY;
  }
  const textLength = stats.text.trimmedLength();
  if (textLength === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const ownPenalty = isBoilerplateElement(element) ? 800 : 0;
  const linkDensity = textLength > 0 ? stats.linkTextLength / textLength : 1;

  let score = textLength;
  score -= linkDensity * 500;
  score += stats.paragraphs * 120;
  score += stats.listItems * 45;
  score += stats.headings * 80;
  score -= stats.tables * 15;
  score -= ownPenalty;

  for (const { bonus, matches } of CONTENT_SELECTOR_BONUSES) {
    if (matches(element)) {
      score += bonus;
    }
  }

  return score;
}

/**
 * What scoring needs to know about an element's subtree. Text is the element's textContent, which
 * includes template contents. The link text and counts are over the descendants querySelectorAll
 * would return from the element, which skips the contents of descendant templates.
 */
class ContentStats {
  readonly text = new CollapsedTextLength();
  /** Sum of the normalized text lengths of descendant links. */
  linkTextLength = 0;
  paragraphs = 0;
  listItems = 0;
  headings = 0;
  tables = 0;

  /**
   * @param element - The measured element.
   * @param hidesContent - The element is a template below the measured root, so its contents stay
   *   out of its ancestors' counts.
   * @param inTemplateContent - The element is inside a descendant template's contents.
   */
  constructor(
    readonly element: Element,
    readonly hidesContent: boolean,
    readonly inTemplateContent: boolean,
  ) {}

  /** Add a finished child's stats to this element's. */
  addChild(child: Readonly<ContentStats>): void {
    this.text.append(child.text);
    const name = child.element.localName;
    if (name === "a") {
      this.linkTextLength += child.text.trimmedLength();
    } else if (name === "p") {
      this.paragraphs += 1;
    } else if (name === "li") {
      this.listItems += 1;
    } else if (name === "table") {
      this.tables += 1;
    } else if (HEADING_TAGS.has(name)) {
      this.headings += 1;
    }
    if (child.hidesContent) {
      return;
    }
    this.linkTextLength += child.linkTextLength;
    this.paragraphs += child.paragraphs;
    this.listItems += child.listItems;
    this.headings += child.headings;
    this.tables += child.tables;
  }
}

/**
 * Measure root's subtree in one iterative post-order walk, returning the stats of root and of every
 * descendant `isCandidate` selects, plus those descendants in document order.
 */
function measureContent(root: Element, isCandidate: CandidateFilter): MeasuredContent {
  const rootStats = new ContentStats(root, false, false);
  const candidates: Element[] = [];
  const stats = new Map([[root, rootStats]]);
  // Iterative, since documents can nest deeper than the call stack allows.
  const stack: ContentStats[] = [rootStats];

  // Start measuring an element, recording it when it is a candidate.
  const openElement = (element: Element, parent: Readonly<ContentStats>): ContentStats => {
    const inTemplateContent = parent.inTemplateContent || parent.hidesContent;
    const elementStats = new ContentStats(
      element,
      element.localName === "template",
      inTemplateContent,
    );
    if (isCandidate(element, inTemplateContent)) {
      candidates.push(element);
      stats.set(element, elementStats);
    }
    return elementStats;
  };

  // Finish the element on top of the stack, adding its stats to its parent's. Returns the node
  // after it, or undefined once the measured root is finished.
  const closeElement = (): ChildNode | null | undefined => {
    const finished = stack.pop();
    const parent = stack.at(-1);
    if (finished === undefined || parent === undefined) {
      return undefined;
    }
    parent.addChild(finished);
    return finished.element.nextSibling;
  };

  // `undefined` ends the walk; `null` means the element on top of the stack has no more children.
  let node: ChildNode | null | undefined = root.firstChild;
  while (node !== undefined) {
    const current = stack.at(-1);
    if (current === undefined) {
      break;
    }
    if (node === null) {
      node = closeElement();
    } else if (isElementNode(node)) {
      stack.push(openElement(node, current));
      node = node.firstChild;
    } else {
      if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
        current.text.appendText(node.nodeValue ?? "");
      }
      node = node.nextSibling;
    }
  }

  return { candidates, stats };
}

/** The candidates measureContent found, in document order, and the stats it recorded. */
type MeasuredContent = {
  readonly candidates: Element[];
  readonly stats: Map<Element, ContentStats>;
};

/** Selects the descendants measureContent reports, given whether they are in template contents. */
type CandidateFilter = (element: Element, inTemplateContent: boolean) => boolean;

/**
 * Remove removal-selector and boilerplate subtrees from root's descendants, returning the tables and
 * the links with an href that remain, in document order.
 */
function removeBoilerplate(root: Element): {
  readonly tables: Element[];
  readonly links: Element[];
} {
  const tables: Element[] = [];
  const links: Element[] = [];
  let element = root.firstElementChild;
  while (element !== null) {
    if (isRemovedElement(element) || isBoilerplateElement(element)) {
      const next = nextElementAfterSubtree(element, root);
      element.remove();
      element = next;
      continue;
    }
    const name = element.localName;
    if (name === "table") {
      tables.push(element);
    } else if (name === "a" && element.hasAttribute("href")) {
      links.push(element);
    }
    element = element.firstElementChild ?? nextElementAfterSubtree(element, root);
  }
  return { tables, links };
}

/** The next element in document order after element's subtree, staying inside root. */
function nextElementAfterSubtree(element: Element, root: Element): Element | null {
  let current: Element | null = element;
  while (current !== null && current !== root) {
    const sibling: Element | null = current.nextElementSibling;
    if (sibling !== null) {
      return sibling;
    }
    current = current.parentElement;
  }
  return null;
}

// Innermost tables first, each inspected in the tree as earlier flattening left it.
function flattenLayoutTables(tables: readonly Element[], root: Element): void {
  for (let index = tables.length - 1; index >= 0; index -= 1) {
    const table = tables[index];
    if (table === undefined) {
      continue;
    }
    const shape = inspectTable(table, root);
    if (!isLikelyLayoutTable(shape)) {
      continue;
    }
    // Only this table's own parts: flattening a nested data table's rows would leave it an empty
    // table shell once turndown's parser moves the resulting divs out of it.
    for (let partIndex = shape.ownParts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = shape.ownParts[partIndex];
      if (part !== undefined) {
        replaceTag(part, "div");
      }
    }
    replaceTag(table, "div");
  }
}

function isLikelyLayoutTable(shape: TableShape): boolean {
  for (const rule of LAYOUT_TABLE_RULES) {
    const verdict = rule(shape);
    if (verdict !== undefined) {
      return verdict === "layout";
    }
  }
  return false;
}

/**
 * What the layout-table rules read about a table. A table's own descendants are those whose nearest
 * table ancestor is this table rather than one nested inside it.
 */
type TableShape = {
  readonly table: Element;
  /** The readable root being sanitized; rules must not look at ancestors outside it. */
  readonly root: Element;
  /** A caption, thead, or th anywhere below the table, nested tables included. */
  readonly hasHeadingMarkup: boolean;
  readonly hasNestedTable: boolean;
  /** Own rows, each as its td/th children; rows without cells are left out. */
  readonly rows: readonly (readonly Element[])[];
  /** Own links, with or without an href. */
  readonly ownLinkCount: number;
  /** Own thead, tbody, tfoot, tr, td, and th elements in document order. */
  readonly ownParts: readonly Element[];
};

/** A layout-table rule's verdict; undefined leaves the decision to the next rule. */
type TableVerdict = "layout" | "data" | undefined;

// Tried in order; the first verdict decides, and a table no rule decides is a data table.
const LAYOUT_TABLE_RULES: readonly ((shape: TableShape) => TableVerdict)[] = [
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

/** Gather a table's shape in one walk of its subtree. */
function inspectTable(table: Element, root: Element): TableShape {
  const draft: TableShapeDraft = {
    hasHeadingMarkup: false,
    hasNestedTable: false,
    ownLinkCount: 0,
    rows: [],
    ownParts: [],
  };
  const recordOwnElement = (element: Element): void => {
    const name = element.localName;
    if (TABLE_HEADING_MARKUP_TAGS.has(name)) {
      draft.hasHeadingMarkup = true;
    }
    if (TABLE_PART_TAGS.has(name)) {
      draft.ownParts.push(element);
    }
    if (name === "tr") {
      const cells = childCells(element);
      if (cells.length > 0) {
        draft.rows.push(cells);
      }
    } else if (name === "a") {
      draft.ownLinkCount += 1;
    }
  };

  let element = table.firstElementChild;
  while (element !== null) {
    if (element.localName === "table") {
      // A nested table's descendants are not this table's own, but its heading markup counts.
      draft.hasNestedTable = true;
      draft.hasHeadingMarkup ||= hasDescendant(element, (descendant) =>
        TABLE_HEADING_MARKUP_TAGS.has(descendant.localName),
      );
      element = nextElementAfterSubtree(element, table);
    } else {
      recordOwnElement(element);
      element = element.firstElementChild ?? nextElementAfterSubtree(element, table);
    }
  }
  return { table, root, ...draft };
}

/** The parts of a TableShape gathered while walking the table. */
type TableShapeDraft = {
  hasHeadingMarkup: boolean;
  hasNestedTable: boolean;
  ownLinkCount: number;
  readonly rows: Element[][];
  readonly ownParts: Element[];
};

function hasDescendant(root: Element, predicate: (element: Element) => boolean): boolean {
  let element = root.firstElementChild;
  while (element !== null) {
    if (predicate(element)) {
      return true;
    }
    element = element.firstElementChild ?? nextElementAfterSubtree(element, root);
  }
  return false;
}

function childCells(row: Element): Element[] {
  const cells: Element[] = [];
  for (let child = row.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (TABLE_CELL_TAGS.has(child.localName)) {
      cells.push(child);
    }
  }
  return cells;
}

function headingMarkupRule({ hasHeadingMarkup }: TableShape): TableVerdict {
  return hasHeadingMarkup ? "data" : undefined;
}

function tableRoleRule({ table }: TableShape): TableVerdict {
  const role = table.getAttribute("role");
  return role === "table" || role === "grid" ? "data" : undefined;
}

// Hacker News lays out its pages with tables. The root stays attached to its parsed document, so
// only the table itself and its ancestors up to and including the root count.
function hackerNewsRule({ table, root }: TableShape): TableVerdict {
  for (let current: Element | null = table; current !== null; current = current.parentElement) {
    const id = current.getAttribute("id");
    if (id === "hnmain" || id === "bigbox") {
      return "layout";
    }
    if (current === root) {
      break;
    }
  }
  return undefined;
}

function nestedTableRule({ hasNestedTable }: TableShape): TableVerdict {
  return hasNestedTable ? "layout" : undefined;
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
function linkListRule({ rows, ownLinkCount }: TableShape): TableVerdict {
  const cells = rows.flat();
  if (ownLinkCount <= cells.length * 0.6) {
    return undefined;
  }
  const averageCellTextLength =
    cells.reduce((total, cell) => total + normalizedTextLength(cell.textContent ?? ""), 0) /
    Math.max(1, cells.length);
  return averageCellTextLength < 120 ? "layout" : undefined;
}

// Links whose only element child is a heading become headings that contain the link.
function normalizeBlockLinks(links: readonly Element[]): void {
  for (const link of links) {
    const onlyChild = link.firstElementChild;
    if (onlyChild === null || onlyChild.nextElementSibling !== null) {
      continue;
    }
    if (!HEADING_TAGS.has(onlyChild.localName)) {
      continue;
    }

    const replacementLink = link.ownerDocument.createElement("a");
    for (const attribute of ["href", "title"] as const) {
      const value = link.getAttribute(attribute);
      if (value !== null && value !== "") {
        replacementLink.setAttribute(attribute, value);
      }
    }
    while (onlyChild.firstChild) {
      replacementLink.append(onlyChild.firstChild);
    }
    onlyChild.append(replacementLink);
    link.replaceWith(onlyChild);
  }
}

// One reverse document-order pass. Removing an empty container can empty its parent, which comes
// earlier. URL rewriting shares the pass: an element that is rewritten keeps an element child in
// every ancestor, so no rewritten element is removed later, and no removed one is rewritten.
function removeEmptyContainersAndResolveUrls(root: Element, baseUrl: string): void {
  const elements = root.querySelectorAll("*");
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    if (element === undefined) {
      continue;
    }
    if (
      EMPTY_CONTAINER_TAGS.has(element.localName) &&
      element.firstElementChild === null &&
      !/\S/u.test(element.textContent ?? "")
    ) {
      element.remove();
      continue;
    }
    if (element.hasAttributes()) {
      resolveUrlAttributes(element, baseUrl);
    }
  }
}

function resolveUrlAttributes(element: Element, baseUrl: string): void {
  for (const [attribute, resolve] of URL_ATTRIBUTE_RESOLVERS) {
    const value = element.getAttribute(attribute);
    if (value === null || value === "") {
      continue;
    }
    const resolved = resolve(value, baseUrl);
    if (resolved !== undefined && resolved !== "") {
      element.setAttribute(attribute, resolved);
    } else {
      element.removeAttribute(attribute);
    }
  }
}

// The class attribute is read raw rather than through classList (which builds a token set): the
// token regex treats any whitespace run as a boundary, so the raw value tests the same.
function isBoilerplateElement(element: Element): boolean {
  if (!element.hasAttributes()) {
    return false;
  }
  let tokens = "";
  for (const value of [
    element.getAttribute("id"),
    element.getAttributeNode("class")?.value,
    element.getAttribute("role"),
    element.getAttribute("aria-label"),
  ]) {
    if (value !== null && value !== undefined && value !== "") {
      tokens = tokens ? `${tokens} ${value}` : value;
    }
  }
  return BOILERPLATE_TOKEN_RE.test(tokens);
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

// Per the DOM, every element in the HTML namespace implements HTMLElement.
function isHtmlElement(element: Element): element is HTMLElement {
  return element.namespaceURI === HTML_NAMESPACE;
}

// turndown's parser gives HTML TABLE elements the HTMLTableElement interface; the gfm plugin reads
// the same rows property.
function isTableElement(node: Element): node is HTMLTableElement {
  return node.nodeName === "TABLE";
}

// domino elements, which turndown's parse produces, implement appendChild but not append.
function appendDominoChild(parent: Element, child: Node): void {
  parent.appendChild(child);
}

/**
 * Convert the sanitized root's innerHTML to markdown.
 *
 * turndown parses its input with domino and joins each node's replacement onto the accumulated
 * output, flattening the string every time, so large flat documents convert in quadratic time.
 * Large inputs are therefore parsed here, exactly as turndown parses a string, and the parsed tree
 * is converted in chunks: runs of the children of the innermost lone wrapper (see
 * loneWrapperChild), each run after the first starting at a block child (CHUNK_BOUNDARY_TAGS).
 * Chunking the parsed tree rather than the markup matters: the HTML parser can close misnested
 * markup differently in a fragment than in the whole document.
 *
 * Each chunk is moved into shallow clones of its ancestors, bracketed by sentinel paragraphs, and
 * converted as a node. A sentinel block next to a chunk edge takes part in turndown's whitespace
 * collapsing, sibling checks, and block join exactly as the neighbouring real block would, and stops
 * turndown's final trim from eating whitespace at the edge. Removing the sentinels, trimming the
 * newlines before each trailing one, and trimming the whole as turndown does reproduces the
 * single-pass output.
 */
function convertToMarkdown(html: string, sanitizedRoot: Element): string {
  const input = `<div>${html}</div>`;
  const chunked = shouldTryChunking(html, sanitizedRoot) ? convertInChunks(input) : undefined;
  return chunked ?? turndown.turndown(input);
}

function shouldTryChunking(html: string, sanitizedRoot: Element): boolean {
  return (
    html.length >= TURNDOWN_CHUNK_MIN_INPUT_BYTES &&
    !html.includes(CHUNK_SENTINEL) &&
    hasManyChunkableChildren(sanitizedRoot)
  );
}

/** Convert the input in chunks, or return undefined when it must be converted in one pass. */
function convertInChunks(input: string): string | undefined {
  // turndown's own string parsing (turndown.cjs.js RootNode) when no DOMParser is global.
  const root = createDocument(`<x-turndown id="turndown-root">${input}</x-turndown>`).querySelector(
    "#turndown-root",
  );
  if (root === null) {
    return undefined;
  }
  const { levels, container } = wrapperChain(root);
  // turndown converts an element whose text is all whitespace as blank, dropping its content, but a
  // chunk shell holds a sentinel and is never blank. Such documents convert in one pass.
  if (!/\S/u.test(container.textContent ?? "")) {
    return undefined;
  }

  const chunks = splitIntoChunks(container);
  if (chunks.length < 2) {
    return undefined;
  }
  detachChildren(container);

  let markdown = "";
  for (const [index, chunk] of chunks.entries()) {
    const edges = { sentinelBefore: index > 0, sentinelAfter: index < chunks.length - 1 };
    const shell = buildChunkShell(levels, chunk, edges);
    if (shell === undefined) {
      return undefined;
    }
    const piece = stripChunkSentinels(turndown.turndown(shell), edges);
    if (piece === undefined) {
      return undefined;
    }
    markdown += piece;
  }
  // turndown's own postProcess trim, applied to the joined output.
  return markdown.replace(/^[\t\r\n]+/u, "").replace(/[\t\r\n\s]+$/u, "");
}

/** Which edges of a chunk carry a sentinel block. */
type ChunkEdges = {
  readonly sentinelBefore: boolean;
  readonly sentinelAfter: boolean;
};

/**
 * Remove a converted chunk's sentinels, and the newlines before a trailing one. Defensive: the
 * sentinels always survive conversion, but a missing one returns undefined rather than misjoin.
 */
function stripChunkSentinels(piece: string, edges: ChunkEdges): string | undefined {
  let text = piece;
  if (edges.sentinelBefore) {
    if (!text.startsWith(CHUNK_SENTINEL)) {
      return undefined;
    }
    text = text.slice(CHUNK_SENTINEL.length);
  }
  if (edges.sentinelAfter) {
    if (!text.endsWith(CHUNK_SENTINEL)) {
      return undefined;
    }
    text = trimTrailingNewlines(text.slice(0, -CHUNK_SENTINEL.length));
  }
  return text;
}

/** The root and its chain of lone wrappers (see loneWrapperChild), outermost first. */
function wrapperChain(root: Element): {
  readonly levels: readonly Element[];
  readonly container: Element;
} {
  const levels: Element[] = [root];
  let container = root;
  for (let wrapper = loneWrapperChild(root); wrapper !== undefined;) {
    levels.push(wrapper);
    container = wrapper;
    wrapper = loneWrapperChild(wrapper);
  }
  return { levels, container };
}

/**
 * Whether the innermost lone wrapper of the sanitized (linkedom) root has enough children for
 * chunking to pay off. This only decides whether to try chunking: the chunks themselves come from
 * turndown's parse, which may nest misnested markup differently.
 */
function hasManyChunkableChildren(root: Element): boolean {
  const { container } = wrapperChain(root);
  let count = 0;
  for (let child = container.firstElementChild; child !== null; child = child.nextElementSibling) {
    count += 1;
    if (count >= TURNDOWN_CHUNK_MIN_CHILDREN) {
      return true;
    }
  }
  return false;
}

// turndown converts these with its default block rule, "\n\n" + content + "\n\n", whatever their
// parent. gfm's highlighted-code rule takes some divs, so divs with its class are not wrappers.
const WRAPPER_TAGS: ReadonlySet<string> = new Set(["div", "section", "article", "main"]);
const GFM_HIGHLIGHT_CLASS_RE = /highlight-(?:text|source)-/u;
const COLLAPSIBLE_WHITESPACE_RE = /^[ \t\r\n]*$/u;

/**
 * The container's only element child when it is a wrapper whose siblings turndown drops: comments,
 * and text of only the whitespace it collapses next to a block. Converting such a wrapper gives its
 * content's conversion wrapped in block newlines, so chunks of its content, each in a clone of the
 * wrapper, convert as the content would inside the whole wrapper.
 */
function loneWrapperChild(container: Element): Element | undefined {
  const wrapper = soleElementChild(container);
  if (wrapper === undefined || !WRAPPER_TAGS.has(wrapper.localName)) {
    return undefined;
  }
  const classes = wrapper.getAttribute("class");
  return classes !== null && GFM_HIGHLIGHT_CLASS_RE.test(classes) ? undefined : wrapper;
}

/** The container's only element child, when every other child is a node turndown drops. */
function soleElementChild(container: Element): Element | undefined {
  let sole: Element | undefined;
  for (let node = container.firstChild; node !== null; node = node.nextSibling) {
    if (isElementNode(node)) {
      if (sole !== undefined) {
        return undefined;
      }
      sole = node;
    } else if (!isDroppedByTurndown(node)) {
      return undefined;
    }
  }
  return sole;
}

// Comments, and text of only the whitespace turndown collapses away next to a block.
function isDroppedByTurndown(node: ChildNode): boolean {
  if (node.nodeType === COMMENT_NODE) {
    return true;
  }
  return node.nodeType === TEXT_NODE && COLLAPSIBLE_WHITESPACE_RE.test(node.nodeValue ?? "");
}

/** Split the container's children into runs of about TURNDOWN_CHUNK_TARGET_CHARS of text. */
function splitIntoChunks(container: Element): readonly (readonly ChildNode[])[] {
  const chunks: ChildNode[][] = [];
  let current: ChildNode[] = [];
  let size = 0;
  for (let node = container.firstChild; node !== null; node = node.nextSibling) {
    if (
      current.length > 0 &&
      size >= TURNDOWN_CHUNK_TARGET_CHARS &&
      isElementNode(node) &&
      CHUNK_BOUNDARY_TAGS.has(node.localName)
    ) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(node);
    size += node.textContent?.length ?? 0;
  }
  chunks.push(current);
  return chunks;
}

/**
 * Detach every child of the container, last first. domino keeps a parent's children in an array and
 * splices a removed child out of it, re-indexing the later siblings, so removing from the front is
 * linear per child. Removing the last child each time costs constant time after one indexing pass,
 * which keeps moving the children into the chunk shells linear overall.
 */
function detachChildren(container: Element): void {
  for (let child = container.lastChild; child !== null; child = container.lastChild) {
    child.remove();
  }
}

/**
 * Move a chunk into shallow clones of the levels, outermost first, returning the outermost clone.
 * Defensive: the outermost level is the x-turndown root, an HTML element, but a clone that is not
 * an HTML element returns undefined rather than convert.
 */
function buildChunkShell(
  levels: readonly Element[],
  chunk: readonly ChildNode[],
  sentinels: { readonly sentinelBefore: boolean; readonly sentinelAfter: boolean },
): HTMLElement | undefined {
  let top: Element | undefined;
  let parent: Element | undefined;
  for (const level of levels) {
    const clone = level.cloneNode(false);
    if (!isElementNode(clone)) {
      return undefined;
    }
    if (parent !== undefined) {
      appendDominoChild(parent, clone);
    }
    top ??= clone;
    parent = clone;
  }
  if (top === undefined || parent === undefined) {
    throw new Error("Chunk shell needs at least one level");
  }
  const document = parent.ownerDocument;
  const sentinel = () => {
    const paragraph = document.createElement("p");
    paragraph.textContent = CHUNK_SENTINEL;
    return paragraph;
  };
  if (sentinels.sentinelBefore) {
    appendDominoChild(parent, sentinel());
  }
  for (const node of chunk) {
    appendDominoChild(parent, node);
  }
  if (sentinels.sentinelAfter) {
    appendDominoChild(parent, sentinel());
  }
  return isHtmlElement(top) ? top : undefined;
}

function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.codePointAt(end - 1) === 10) {
    end -= 1;
  }
  return text.slice(0, end);
}

function replaceTag(element: Element, tagName: string): Element {
  const replacement = element.ownerDocument.createElement(tagName);
  while (element.firstChild) {
    replacement.append(element.firstChild);
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
  if (!trimmed) {
    return undefined;
  }
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
      const [urlPart, descriptor] = entry.split(/\s+/u, 2);
      const resolved = resolveAttributeUrl(urlPart, baseUrl, "allow");
      if (resolved === undefined) {
        return undefined;
      }
      return descriptor === undefined ? resolved : `${resolved} ${descriptor}`;
    })
    .filter((entry): entry is string => Boolean(entry));
  return candidates.length > 0 ? candidates.join(", ") : undefined;
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replaceAll("\r\n", "\n")
    .replaceAll(
      /\[\s*\n+(?<hashes>#{1,6})\s+(?<text>[^\n]+?)\s*\n+\s*\]\((?<url>[^)]+)\)/gu,
      (_match, hashes: string, text: string, url: string) => `${hashes} [${text.trim()}](${url})`,
    )
    .replaceAll(/^\[\]\([^)]+\)\n?/gmu, "")
    .replaceAll(/(?<link>\]\([^)]+\))(?=\[)/gu, "$<link> ")
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

function cleanupText(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll(/[ \t]+\n/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}
