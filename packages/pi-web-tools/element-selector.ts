/**
 * Selector matching for a small CSS subset, compiled once into plain predicates.
 *
 * linkedom compiles a selector with css-select on every querySelectorAll, matches, and closest
 * call. The sanitizer's selectors are constants, so compiling them once and testing elements with
 * direct attribute reads avoids that cost. Predicates follow css-select's semantics for elements of
 * linkedom HTML documents: tag names compare against the (lowercase) local name, ids and class
 * tokens compare case-sensitively (css-select's no-quirks default), attribute names match exactly,
 * and attribute values compare case-insensitively only for the attributes css-select treats as
 * case-insensitive in HTML.
 */

/** A compiled selector: returns true when the element matches. */
export type ElementPredicate = (element: Element) => boolean;

// css-select's caseInsensitiveAttributes (css-select/dist/attributes.js): in HTML, [name='value']
// compares these attributes' values case-insensitively.
const CASE_INSENSITIVE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "accept",
  "accept-charset",
  "align",
  "alink",
  "axis",
  "bgcolor",
  "charset",
  "checked",
  "clear",
  "codetype",
  "color",
  "compact",
  "declare",
  "defer",
  "dir",
  "direction",
  "disabled",
  "enctype",
  "face",
  "frame",
  "hreflang",
  "http-equiv",
  "lang",
  "language",
  "link",
  "media",
  "method",
  "multiple",
  "nohref",
  "noresize",
  "noshade",
  "nowrap",
  "readonly",
  "rel",
  "rev",
  "rules",
  "scope",
  "scrolling",
  "selected",
  "shape",
  "target",
  "text",
  "type",
  "valign",
  "valuetype",
  "vlink",
]);

// Lowercase tag and attribute names only, which sidesteps css-what's name case folding.
const COMPOUND_RE =
  /^(?<tag>[a-z][a-z0-9-]*)?(?<parts>(?:#[\w-]+|\.[\w-]+|\[[a-z][a-z0-9-]*(?:=(?:'[^']*'|"[^"]*"|[\w-]+))?\])*)$/u;
const PART_RE =
  /#(?<id>[\w-]+)|\.(?<className>[\w-]+)|\[(?<attribute>[a-z][a-z0-9-]*)(?:=(?:'(?<singleQuoted>[^']*)'|"(?<doubleQuoted>[^"]*)"|(?<bare>[\w-]+)))?\]/gu;

/** A parsed compound selector: an optional tag name plus attribute conditions, all required. */
type Compound = {
  readonly tag: string | undefined;
  /** The id the compound requires, if any. */
  readonly id: string | undefined;
  /** The first class token the compound requires, if any. */
  readonly className: string | undefined;
  readonly conditions: readonly ElementPredicate[];
};

/**
 * A compiled set of selector lists, tested together: calls `onMatch` once with the index of every
 * list the element matches.
 */
export type SelectorSetMatcher = (element: Element, onMatch: (index: number) => void) => void;

const CLASS_TOKEN_SEPARATOR_RE = /\s+/u;

/**
 * Compile selector lists (see compileSelector) into one matcher. Each compound is indexed under the
 * id, class token, or tag it requires, so an element is tested only against compounds its own id,
 * class tokens, and tag could satisfy, plus the compounds that require none of them. The element's
 * id and class are read once per test instead of once per compound.
 *
 * @param selectorLists - Selector lists; a match reports the list's index.
 * @returns A matcher reporting each matching list's index once.
 * @throws Error for unsupported syntax. Selectors are module constants, so this is a defect.
 */
export function compileSelectorSet(selectorLists: readonly string[]): SelectorSetMatcher {
  type Entry = { readonly index: number; readonly matches: ElementPredicate };
  const byId = new Map<string, Entry[]>();
  const byClass = new Map<string, Entry[]>();
  const byTag = new Map<string, Entry[]>();
  const unindexed: Entry[] = [];
  const add = (map: Map<string, Entry[]>, key: string, entry: Entry) => {
    const entries = map.get(key);
    if (entries) {
      entries.push(entry);
    } else {
      map.set(key, [entry]);
    }
  };

  for (const [index, selectorList] of selectorLists.entries()) {
    for (const source of selectorList.split(",")) {
      const compound = parseCompound(source.trim(), selectorList);
      const entry = { index, matches: compoundPredicate(compound) };
      if (compound.id !== undefined) {
        add(byId, compound.id, entry);
      } else if (compound.className !== undefined) {
        add(byClass, compound.className, entry);
      } else if (compound.tag === undefined) {
        unindexed.push(entry);
      } else {
        add(byTag, compound.tag, entry);
      }
    }
  }

  return (element, onMatch) => {
    // A list can match through several compounds or repeated class tokens; report it once.
    const reported: number[] = [];
    const test = (entries: readonly Entry[] | undefined) => {
      if (entries === undefined) {
        return;
      }
      for (const { index, matches } of entries) {
        if (!reported.includes(index) && matches(element)) {
          reported.push(index);
          onMatch(index);
        }
      }
    };

    test(byTag.get(element.localName));
    // Every other compound requires an attribute.
    if (!element.hasAttributes()) {
      return;
    }
    const id = element.getAttribute("id");
    if (id !== null) {
      test(byId.get(id));
    }
    const classes = element.getAttributeNode("class")?.value;
    if (classes !== undefined && byClass.size > 0) {
      // classList's tokens: the attribute split on whitespace runs, without empty tokens.
      for (const token of classes.split(CLASS_TOKEN_SEPARATOR_RE)) {
        if (token) {
          test(byClass.get(token));
        }
      }
    }
    test(unindexed);
  };
}

/**
 * Compile a comma-separated list of compound selectors. A compound is an optional tag name followed
 * by any number of `#id`, `.class`, `[attribute]`, and `[attribute='value']` parts. Combinators,
 * pseudo-classes, `*`, flags, other attribute operators, and `[class='value']` are not supported.
 *
 * @param selectorList - Comma-separated compound selectors.
 * @returns A predicate matching elements that match any compound in the list.
 * @throws Error for unsupported syntax. Selectors are module constants, so this is a defect.
 */
export function compileSelector(selectorList: string): ElementPredicate {
  const tags = new Set<string>();
  const compounds: ElementPredicate[] = [];
  for (const source of selectorList.split(",")) {
    const compound = parseCompound(source.trim(), selectorList);
    if (compound.conditions.length === 0 && compound.tag !== undefined) {
      tags.add(compound.tag);
    } else {
      compounds.push(compoundPredicate(compound));
    }
  }

  if (compounds.length === 0) {
    return (element) => tags.has(element.localName);
  }
  // Every compound left has an attribute condition, so an element without attributes can match
  // only by tag name.
  return (element) => {
    if (tags.has(element.localName)) {
      return true;
    }
    if (!element.hasAttributes()) {
      return false;
    }
    for (const matches of compounds) {
      if (matches(element)) {
        return true;
      }
    }
    return false;
  };
}

function parseCompound(source: string, selectorList: string): Compound {
  const match = COMPOUND_RE.exec(source);
  const tag = match?.groups?.tag;
  const parts = match?.groups?.parts ?? "";
  if (match === null || (tag === undefined && parts === "")) {
    throw new Error(`Unsupported selector: ${JSON.stringify(selectorList)}`);
  }

  const conditions: ElementPredicate[] = [];
  let requiredId: string | undefined;
  let requiredClass: string | undefined;
  for (const { groups = {} } of parts.matchAll(PART_RE)) {
    const { id, className, attribute, singleQuoted, doubleQuoted, bare } = groups;
    const value = singleQuoted ?? doubleQuoted ?? bare;
    if (id !== undefined) {
      requiredId ??= id;
      conditions.push((element) => element.getAttribute("id") === id);
    } else if (className !== undefined) {
      requiredClass ??= className;
      conditions.push(classTokenPredicate(className));
    } else if (attribute !== undefined && value === undefined) {
      conditions.push((element) => element.hasAttribute(attribute));
    } else if (attribute !== undefined && value !== undefined) {
      conditions.push(attributeEqualsPredicate(attribute, value, selectorList));
    }
  }
  return { tag, id: requiredId, className: requiredClass, conditions };
}

function compoundPredicate({ tag, conditions }: Compound): ElementPredicate {
  return (element) => {
    if (tag !== undefined && element.localName !== tag) {
      return false;
    }
    for (const condition of conditions) {
      if (!condition(element)) {
        return false;
      }
    }
    return true;
  };
}

// css-select tests the classList value (the attribute's tokens joined by single spaces) with this
// regex. Testing the raw attribute value is equivalent: its tokens are separated by whitespace
// runs, and duplicate or surrounding whitespace changes no token boundary.
function classTokenPredicate(token: string): ElementPredicate {
  const tokenRe = new RegExp(`(?:^|\\s)${escapeRegExp(token)}(?:$|\\s)`, "u");
  return (element) => {
    const classes = element.getAttributeNode("class")?.value;
    return classes !== undefined && tokenRe.test(classes);
  };
}

function attributeEqualsPredicate(
  attribute: string,
  value: string,
  selectorList: string,
): ElementPredicate {
  if (attribute === "class") {
    // css-select compares the normalized classList value here, not the attribute.
    throw new Error(`Unsupported selector: ${JSON.stringify(selectorList)}`);
  }
  if (!CASE_INSENSITIVE_ATTRIBUTES.has(attribute)) {
    return (element) => element.getAttribute(attribute) === value;
  }
  const lowerValue = value.toLowerCase();
  return (element) => {
    const actual = element.getAttribute(attribute);
    return (
      actual !== null && actual.length === lowerValue.length && actual.toLowerCase() === lowerValue
    );
  };
}

// Escapes the characters that are special outside a character class. A unicode-mode pattern
// rejects escapes of any other character, such as the hyphen.
function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}
