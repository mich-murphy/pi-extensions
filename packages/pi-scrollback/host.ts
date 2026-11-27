import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Component, ScrollView, StackEntry, TUI } from "@earendil-works/pi-tui";
import type { LayoutNode } from "@earendil-works/pi-tui/dist/layout-node";
import { Option, Predicate, Schema } from "effect";
import { contextRow, labelPrompts, promptSpans, selectPrompt } from "./context";
import type { PromptIndex, PromptSpan } from "./context";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

type RenderComponent = Pick<Component, "render">;

type LayoutRoot = RenderComponent & { [LAYOUT_NODE]: () => LayoutNode };

const Render = Schema.declare<Component["render"]>((value): value is Component["render"] =>
  Predicate.isFunction(value),
);

const RenderableComponent = Schema.Struct({ render: Render });
const isComponent = Schema.is(RenderableComponent);

const hasLayout = Schema.is(
  Schema.Struct({
    render: Render,
    [LAYOUT_NODE]: Schema.declare<LayoutRoot[typeof LAYOUT_NODE]>(
      (value): value is LayoutRoot[typeof LAYOUT_NODE] => Predicate.isFunction(value),
    ),
  }),
);

const decodeHost = Schema.decodeUnknownOption(
  Schema.Struct({ layoutRoot: Schema.declare<LayoutRoot>(hasLayout) }),
);

const isNativeStack = Schema.is(
  Schema.Struct({
    type: Schema.Literal("vstack"),
    gap: Schema.Literal(0),
    align: Schema.Literal("stretch"),
    entries: Schema.Tuple([
      Schema.Struct({
        component: RenderableComponent,
        basis: Schema.Literal(0),
        grow: Schema.Literal(1),
        shrink: Schema.Literal(1),
        minSize: Schema.Literal(1),
      }),
      Schema.Struct({
        component: RenderableComponent,
        basis: Schema.Literal("auto"),
        grow: Schema.Literal(0),
        shrink: Schema.Literal(1),
        minSize: Schema.Literal(1),
      }),
    ]),
  }),
);

const isNativeScroll = Schema.is(
  Schema.Struct({
    primary: Schema.Literal(true),
    isFollowingEnd: Schema.Boolean,
    scrollTop: Schema.Number,
    getContentWidth: Schema.declare<ScrollView["getContentWidth"]>(
      (value): value is ScrollView["getContentWidth"] => Predicate.isFunction(value),
    ),
    scrollTo: Schema.declare<ScrollView["scrollTo"]>((value): value is ScrollView["scrollTo"] =>
      Predicate.isFunction(value),
    ),
    children: Schema.Array(Schema.Unknown),
  }),
);

const hasChildren = Schema.is(Schema.Struct({ children: Schema.Array(Schema.Unknown) }));
const hasText = Schema.is(Schema.Struct({ text: Schema.String }));

function* userComponents(component: RenderComponent): Generator<RenderComponent> {
  if (component.constructor.name === "UserMessageComponent") {
    yield component;

    return;
  }

  if (!hasChildren(component)) {
    return;
  }

  for (const child of component.children) {
    if (isComponent(child)) {
      yield* userComponents(child);
    }
  }
}

type UserRecord = {
  readonly component: RenderComponent;
  readonly block: ReadonlyArray<string>;
  readonly start: number;
  readonly source: string | undefined;
  readonly text: string;
};

type UserBlock = { readonly component: RenderComponent; readonly block: ReadonlyArray<string> };

type PromptState = {
  readonly document: RenderComponent;
  readonly width: number;
  readonly raw: ReadonlyArray<string>;
  readonly lines: Array<string>;
  readonly users: ReadonlyArray<UserRecord>;
  readonly spans: ReadonlyArray<PromptSpan>;
  readonly index: PromptIndex;
};

function firstDifference(previous: ReadonlyArray<string>, next: ReadonlyArray<string>): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;

  while (index < limit && previous[index] === next[index]) {
    index++;
  }

  return index;
}

function sameLines(previous: ReadonlyArray<string>, next: ReadonlyArray<string>): boolean {
  return (
    previous === next ||
    (previous.length === next.length && previous.every((line, index) => line === next[index]))
  );
}

function promptSource(component: RenderComponent): string | undefined {
  return hasText(component) ? component.text : undefined;
}

function promptText(source: string | undefined): string {
  return source === undefined ? "" : source.replaceAll(/\s+/gu, " ").trim();
}

function keptUsers(
  previous: ReadonlyArray<UserRecord>,
  blocks: ReadonlyArray<UserBlock>,
  changed: number,
): Array<UserRecord> {
  const kept: Array<UserRecord> = [];

  for (const [position, record] of previous.entries()) {
    const next = blocks[position];

    if (
      next?.component !== record.component ||
      !sameLines(record.block, next.block) ||
      record.start < 0 ||
      record.start + record.block.length > changed
    ) {
      break;
    }

    const source = promptSource(next.component);
    kept.push(
      source === record.source
        ? { ...record, block: next.block }
        : { ...record, block: next.block, source, text: promptText(source) },
    );
  }

  return kept;
}

function placeUsers(
  blocks: ReadonlyArray<UserBlock>,
  raw: ReadonlyArray<string>,
  lines: Array<string>,
  from: number,
): Array<UserRecord> {
  const placed: Array<UserRecord> = [];
  let cursor = from;

  for (const { component, block } of blocks) {
    while (cursor < raw.length && !block.every((line, offset) => raw[cursor + offset] === line)) {
      cursor++;
    }

    const source = promptSource(component);

    if (cursor >= raw.length || block.length === 0) {
      placed.push({ component, block, start: -1, source, text: "" });
      continue;
    }

    for (const [offset, line] of block.entries()) {
      lines[cursor + offset] = line;
    }

    placed.push({ component, block, start: cursor, source, text: promptText(source) });
    cursor += block.length;
  }

  return placed;
}

function stableLength(
  previous: PromptState | undefined,
  raw: ReadonlyArray<string>,
  kept: number,
): number {
  if (previous === undefined) {
    return 0;
  }

  const changed = firstDifference(previous.raw, raw);
  const stale = previous.users.slice(kept).find((record) => record.start >= 0);

  return Math.min(changed, stale?.start ?? changed);
}

function keptSpans(previous: PromptState | undefined, stable: number) {
  const spans = previous?.spans ?? [];

  return spans.slice(0, spans.findLastIndex((span) => span.end < stable) + 1);
}

function buildPrompts(
  previous: PromptState | undefined,
  document: RenderComponent,
  raw: ReadonlyArray<string>,
  width: number,
): PromptState {
  const usable = previous?.document === document && previous.width === width ? previous : undefined;

  const blocks = Array.from(userComponents(document), (component) => ({
    component,
    block: component.render(width),
  }));

  const kept =
    usable === undefined ? [] : keptUsers(usable.users, blocks, firstDifference(usable.raw, raw));

  const stable = stableLength(usable, raw, kept.length);
  const lines = usable?.lines ?? [];
  lines.length = stable;

  for (let index = stable; index < raw.length; index++) {
    lines.push(stripTerminalSequences(raw[index] ?? ""));
  }

  const last = kept.at(-1);
  const from = last === undefined ? 0 : last.start + last.block.length;
  const users = [...kept, ...placeUsers(blocks.slice(kept.length), raw, lines, from)];
  const reused = keptSpans(usable, stable);
  const scanFrom = (reused.at(-1)?.end ?? -1) + 1;
  const spans = [...reused, ...promptSpans(lines, scanFrom)];
  const texts = users.flatMap((record) => (record.start >= 0 ? [record.text] : []));

  return { document, width, raw, lines, users, spans, index: labelPrompts(spans, texts) };
}

export function promptIndexCache(): (
  document: Pick<Component, "render">,
  lines: ReadonlyArray<string>,
  width: number,
) => PromptIndex {
  let state: PromptState | undefined;

  return (document: RenderComponent, lines: ReadonlyArray<string>, width: number) => {
    if (state?.document !== document || state.raw !== lines || state.width !== width) {
      state = buildPrompts(state, document, lines, width);
    }

    return state.index;
  };
}

function headerFor(row: string | undefined, muted: (text: string) => string): Component {
  return {
    render: (width) => (row === undefined ? [] : [muted(contextRow(row, width))]),
    invalidate: () => undefined,
  };
}

export function createHostAdapter(
  tui: TUI,
  muted: (text: string) => string,
): Component & { dispose: () => void } {
  let disposed = false;
  const restorers = new Map<LayoutRoot, () => void>();

  function discover(): void {
    if (disposed) {
      return;
    }

    const host = decodeHost(tui);

    if (Option.isNone(host)) {
      return;
    }

    const candidate = host.value.layoutRoot;

    if (restorers.has(candidate)) {
      return;
    }

    let node;

    try {
      node = candidate[LAYOUT_NODE]();
    } catch {
      return;
    }

    if (!isNativeStack(node) || !Object.isExtensible(candidate)) {
      return;
    }

    const [{ component: scroll }, { component: dock }] = node.entries;

    if (!isNativeScroll(scroll)) {
      return;
    }

    const ownDescriptor = Object.getOwnPropertyDescriptor(candidate, LAYOUT_NODE);

    if (ownDescriptor !== undefined && ownDescriptor.configurable !== true) {
      return;
    }

    let text: string | undefined;
    let shown = false;
    const promptsFor = promptIndexCache();
    let header = { text, component: headerFor(text, muted) };

    const currentHeader = (): Component => {
      if (header.text !== text) {
        header = { text, component: headerFor(text, muted) };
      }

      return header.component;
    };

    const patched = () =>
      disposed
        ? node
        : {
            ...node,
            entries: [
              {
                get component() {
                  return currentHeader();
                },
                basis: 1,
                grow: 0,
                shrink: 0,
                minSize: 1,
                visible: (viewport: Parameters<NonNullable<StackEntry["visible"]>>[0]) => {
                  const wasShown = shown;
                  shown = false;
                  text = undefined;

                  if (scroll.isFollowingEnd || viewport.height < 3) {
                    return false;
                  }

                  const document = scroll.children[0];

                  if (!isComponent(document)) {
                    return false;
                  }

                  const width = scroll.getContentWidth(viewport.width);
                  const lines = document.render(width);

                  const height = Math.max(
                    1,
                    viewport.height - Math.max(1, dock.render(viewport.width).length),
                  );

                  const currentHeight = Math.max(1, height - (wasShown ? 1 : 0));

                  if (height < 2 || scroll.scrollTop >= Math.max(0, lines.length - currentHeight)) {
                    return false;
                  }

                  text = selectPrompt(promptsFor(document, lines, width), scroll.scrollTop);
                  shown = text !== undefined;

                  return shown;
                },
              },
              ...node.entries,
            ],
          };

    Object.defineProperty(candidate, LAYOUT_NODE, {
      configurable: true,
      writable: true,
      value: patched,
    });
    restorers.set(candidate, () => {
      if (candidate[LAYOUT_NODE] !== patched) {
        return;
      }

      if (ownDescriptor === undefined) {
        Reflect.deleteProperty(candidate, LAYOUT_NODE);
      } else {
        Object.defineProperty(candidate, LAYOUT_NODE, ownDescriptor);
      }
    });
    tui.requestRender();
  }

  discover();

  return {
    render: () => {
      discover();

      return [];
    },
    invalidate: () => undefined,
    dispose: () => {
      disposed = true;

      for (const restore of restorers.values()) {
        restore();
      }

      restorers.clear();
      tui.requestRender();
    },
  };
}
