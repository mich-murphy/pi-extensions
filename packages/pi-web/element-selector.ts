export type ElementPredicate = (element: Element) => boolean;

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

const COMPOUND_RE =
  /^(?<tag>[a-z][a-z0-9-]*)?(?<parts>(?:#[\w-]+|\.[\w-]+|\[[a-z][a-z0-9-]*(?:=(?:'[^']*'|"[^"]*"|[\w-]+))?\])*)$/u;
const PART_RE =
  /#(?<id>[\w-]+)|\.(?<className>[\w-]+)|\[(?<attribute>[a-z][a-z0-9-]*)(?:=(?:'(?<singleQuoted>[^']*)'|"(?<doubleQuoted>[^"]*)"|(?<bare>[\w-]+)))?\]/gu;

type Compound = {
  readonly tag: string | undefined;
  readonly id: string | undefined;
  readonly className: string | undefined;
  readonly conditions: readonly ElementPredicate[];
};

export type SelectorSetMatcher = (element: Element, onMatch: (index: number) => void) => void;

const CLASS_TOKEN_SEPARATOR_RE = /\s+/u;

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
    if (!element.hasAttributes()) {
      return;
    }
    const id = element.getAttribute("id");
    if (id !== null) {
      test(byId.get(id));
    }
    const classes = element.getAttributeNode("class")?.value;
    if (classes !== undefined && byClass.size > 0) {
      for (const token of classes.split(CLASS_TOKEN_SEPARATOR_RE)) {
        if (token) {
          test(byClass.get(token));
        }
      }
    }
    test(unindexed);
  };
}

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

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}
