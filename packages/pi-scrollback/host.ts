import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Component, ScrollView, StackEntry, TUI } from "@earendil-works/pi-tui";
import { Option, Predicate, Schema } from "effect";
import { contextRow, selectContext } from "./context";

const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

type RenderComponent = Pick<Component, "render">;

type LayoutRoot = RenderComponent & { [LAYOUT_NODE]: () => typeof Schema.Unknown.Type };

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

function nativeTexts(document: RenderComponent, rendered: ReadonlyArray<string>, width: number) {
  const texts: Array<string> = [];
  const lines = rendered.map((line) => stripTerminalSequences(line));
  let cursor = 0;

  for (const component of userComponents(document)) {
    const block = component.render(width);

    while (
      cursor < rendered.length &&
      !block.every((line, offset) => rendered[cursor + offset] === line)
    ) {
      cursor++;
    }

    if (cursor >= rendered.length || block.length === 0) {
      continue;
    }

    for (const [offset, line] of block.entries()) {
      lines[cursor + offset] = line;
    }

    cursor += block.length;
    texts.push(hasText(component) ? component.text.replaceAll(/\s+/gu, " ").trim() : "");
  }

  return { lines, texts };
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

                  const lines = document.render(scroll.getContentWidth(viewport.width));

                  const height = Math.max(
                    1,
                    viewport.height - Math.max(1, dock.render(viewport.width).length),
                  );

                  const currentHeight = Math.max(1, height - (wasShown ? 1 : 0));

                  if (height < 2 || scroll.scrollTop >= Math.max(0, lines.length - currentHeight)) {
                    return false;
                  }

                  const prompts = nativeTexts(
                    document,
                    lines,
                    scroll.getContentWidth(viewport.width),
                  );

                  text = selectContext(prompts.lines, scroll.scrollTop, prompts.texts);
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
