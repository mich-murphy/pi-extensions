import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Component, ScrollView, StackEntry, TUI } from "@earendil-works/pi-tui";
import { contextRow, selectContext } from "./context";

// Private compatibility seam, verified against Pi 1.3.0 and 1.4.0. Not a renderer patch:
// InteractiveMode remounts this same root when replacing regular/fullscreen renderers.
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
type StackNode = {
  type: "vstack";
  entries: readonly StackEntry[];
  gap: number;
  align: "stretch";
};
type LayoutRoot = Component & { [LAYOUT_NODE]: () => StackNode };

function isComponent(value: unknown): value is Component {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "render") === "function"
  );
}

function isRoot(value: unknown): value is LayoutRoot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "render") === "function" &&
    typeof Reflect.get(value, LAYOUT_NODE) === "function"
  );
}

function hasNativeEntries(node: StackNode): boolean {
  return (
    typeof node === "object" &&
    node !== null &&
    Array.isArray(node.entries) &&
    node.entries.length === 2 &&
    node.entries.every((entry) => typeof entry === "object" && entry !== null)
  );
}

function nativeAllocation(entry: StackEntry, basis: 0 | "auto", grow: 0 | 1): boolean {
  return entry.basis === basis && entry.grow === grow && entry.shrink === 1 && entry.minSize === 1;
}

function nativeStack(node: StackNode): boolean {
  return node.type === "vstack" && node.gap === 0 && node.align === "stretch";
}

/** Fail closed unless the native two-entry chat viewport still has its known geometry. */
function nativeChat(node: StackNode): { scroll: ScrollView; dock: Component } | undefined {
  if (!hasNativeEntries(node)) {
    return undefined;
  }
  const [transcript, dock] = node.entries;
  if (!nativeStack(node) || transcript === undefined || dock === undefined) {
    return undefined;
  }
  if (
    !isNativeScroll(transcript.component) ||
    !isComponent(dock.component) ||
    !nativeAllocation(transcript, 0, 1) ||
    !nativeAllocation(dock, "auto", 0)
  ) {
    return undefined;
  }
  return { scroll: transcript.component, dock: dock.component };
}

// The CLI bundle and extension imports need not share constructor identity.
// Validate the native public scroll surface instead of instanceof.
function isNativeScroll(component: Component): component is ScrollView {
  return (
    typeof component === "object" &&
    component !== null &&
    Reflect.get(component, "primary") === true &&
    typeof Reflect.get(component, "isFollowingEnd") === "boolean" &&
    typeof Reflect.get(component, "scrollTop") === "number" &&
    typeof Reflect.get(component, "getContentWidth") === "function" &&
    typeof Reflect.get(component, "scrollTo") === "function" &&
    Array.isArray(Reflect.get(component, "children"))
  );
}

function* userComponents(component: Component): Generator<Component> {
  if (component.constructor.name === "UserMessageComponent") {
    yield component;
    return;
  }
  const children: unknown = Reflect.get(component, "children");
  if (!Array.isArray(children)) {
    return;
  }
  for (const child of children) {
    if (isComponent(child)) {
      yield* userComponents(child);
    }
  }
}

// UserMessageComponent has no public text accessor. Keep this optional private read
// beside the layout seam; OSC boundaries still own geometry and turn identity.
function nativeTexts(
  document: Component,
  rendered: readonly string[],
  width: number,
): { lines: string[]; texts: string[] } {
  const texts: string[] = [];
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
    const value: unknown = Reflect.get(component, "text");
    texts.push(typeof value === "string" ? value.replaceAll(/\s+/gu, " ").trim() : "");
  }
  return { lines, texts };
}

/** The invisible dock component discovers a root even if startup was in regular mode.
 * It neither owns input nor reserves a line. The live TUI reference follows mode switches.
 */
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
    const candidate: unknown = Reflect.get(tui, "layoutRoot");
    if (!isRoot(candidate) || restorers.has(candidate)) {
      return;
    }
    const original = candidate[LAYOUT_NODE];
    let node: StackNode;
    try {
      node = original.call(candidate);
    } catch {
      return;
    }
    const chat = nativeChat(node);
    if (chat === undefined || !Object.isExtensible(candidate)) {
      return;
    }
    const ownDescriptor = Object.getOwnPropertyDescriptor(candidate, LAYOUT_NODE);
    if (ownDescriptor !== undefined && ownDescriptor.configurable !== true) {
      return;
    }
    let text: string | undefined;
    let shown = false;
    const header: Component = {
      render: (width) => (text === undefined ? [] : [muted(contextRow(text, width))]),
      invalidate: () => {
        /* Render reads current state and theme. */
      },
    };
    const patched = (): StackNode =>
      disposed
        ? node
        : {
            ...node,
            entries: [
              {
                component: header,
                basis: 1,
                grow: 0,
                shrink: 0,
                minSize: 1,
                visible: (viewport) => {
                  const wasShown = shown;
                  shown = false;
                  text = undefined;
                  const { scroll, dock } = chat;
                  if (scroll.isFollowingEnd || viewport.height < 3) {
                    return false;
                  }
                  const document = scroll.children[0];
                  if (!isComponent(document)) {
                    return false;
                  }
                  const lines = document.render(scroll.getContentWidth(viewport.width));
                  // Exact native two-entry VStack allocation: the dock shrinks first to leave
                  // transcript minSize=1. Probe only component render caches, never ScrollView state.
                  const height = Math.max(
                    1,
                    viewport.height - Math.max(1, dock.render(viewport.width).length),
                  );
                  // Compare against the *current* viewport when a row is already present: the
                  // last historical line is not the bottom until native scrolling reaches it.
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
      // Do not undo another extension's later replacement.
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
    invalidate: () => {
      /* Render reads current state and theme. */
    },
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
