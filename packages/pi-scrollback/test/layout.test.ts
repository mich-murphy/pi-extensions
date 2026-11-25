import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component, StackEntryOptions } from "@earendil-works/pi-tui";
import {
  Container,
  Text,
  TuiAltScreen,
  VStack,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { assert, describe, expect, test, vi } from "vitest";
import { createChatViewport } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport";
import { initTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme";
import { renderLayoutFrame } from "../../../node_modules/@earendil-works/pi-tui/dist/layout";
import {
  getLayoutNode,
  LAYOUT_NODE,
} from "../../../node_modules/@earendil-works/pi-tui/dist/layout-node";
import { testTui } from "../../../test-support/pi-tui";
import { contextRow, selectContext } from "../context";
import { createHostAdapter } from "../host";

initTheme("dark");

function fixture(firstPrompt = "first prompt") {
  const document = new Container();
  document.addChild(new UserMessageComponent(firstPrompt));
  document.addChild(
    new AssistantMessageComponent({
      role: "assistant",
      content: [
        {
          type: "text",
          text: Array.from({ length: 30 }, (_, i) => `first output ${i}`).join("\n"),
        },
      ],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      timestamp: 0,
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
  );
  document.addChild(new UserMessageComponent("second prompt"));

  const output = new Text(
    Array.from({ length: 30 }, (_, i) => `second output ${i}`).join("\n"),
    0,
    0,
  );

  document.addChild(output);
  const empty = new Container();

  const viewport = createChatViewport({
    document,
    pendingMessages: empty,
    status: empty,
    editor: new Text("editor", 0, 0),
    footer: empty,
    scrollbar: "hidden",
  });

  const { root } = viewport;
  assert(root instanceof VStack);
  const tui = new TuiAltScreen(testTui().terminal);
  const request = vi.spyOn(tui, "requestRender").mockImplementation(() => undefined);
  tui.setLayoutRoot(root);
  const adapter = createHostAdapter(tui, (text) => text);

  const render = (width = 40, height = 12) =>
    renderLayoutFrame(viewport.root, width, height, () => undefined);

  return { ...viewport, root, document, output, tui, adapter, render, request };
}

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line));

function driftedRoot(native: Component, which: "transcript" | "dock", change: StackEntryOptions) {
  const node = getLayoutNode(native);

  if (node?.type !== "vstack") {
    throw new Error("test setup: native root is not a vstack");
  }

  const target = which === "transcript" ? 0 : 1;

  const entries = node.entries.map((entry, index) =>
    index === target ? { ...entry, ...change } : entry,
  );

  const layoutNode = () => ({ ...node, entries });

  return {
    root: { render: () => [], invalidate: () => undefined, [LAYOUT_NODE]: layoutNode },
    layoutNode,
  };
}

function visible(component: Component): boolean | undefined {
  const node = getLayoutNode(component);

  return node?.type === "vstack"
    ? node.entries[0]?.visible?.({ width: 40, height: 12 })
    : undefined;
}

describe("native chat viewport", () => {
  test("accepts the pinned fullscreen layout and keeps the historical turn anchored", () => {
    const f = fixture();
    expect(
      f.root[LAYOUT_NODE]().entries,
      "adapter adds a row to the native two-entry stack",
    ).toHaveLength(3);
    expect(f.transcript.getContentWidth(40)).toBe(40);
    expect(f.transcript.getContentWidth(20)).toBe(20);
    expect(plain(f.tui.render(40)).map((line) => line.trim())).toContain("editor");

    expect(plain(f.render().lines)[0]).not.toContain("❯");
    f.transcript.scrollTo(8);
    expect(f.transcript.scrollTop).toBe(8);
    const frame = f.render();
    expect(plain(frame.lines)[0]?.trim()).toBe("❯ first prompt");
    expect(f.transcript.scrollTop).toBe(8);
    f.output.setText("streamed\n".repeat(80));
    expect(plain(f.render().lines)[0]?.trim()).toBe("❯ first prompt");
    expect(f.transcript.scrollTop).toBe(8);
    f.transcript.scrollBy(2);
    expect(plain(f.render().lines)[0]?.trim()).toBe("❯ first prompt");
    f.transcript.scrollToEnd();
    expect(plain(f.render().lines)[0]).not.toContain("❯");
    expect(f.transcript.viewportHeight).toBe(9);
    f.adapter.dispose();
    f.adapter.dispose();
  });

  test("later wrappers keep their method but disposed adapters stop theme callbacks", () => {
    const f = fixture();
    f.adapter.dispose();
    const muted = vi.fn<(text: string) => string>((text) => text);
    const adapter = createHostAdapter(f.tui, muted);
    const patched = f.root[LAYOUT_NODE];
    const wrapped = () => patched.call(f.root);
    f.root[LAYOUT_NODE] = wrapped;
    f.render();
    f.transcript.scrollTo(8);
    expect(plain(f.render().lines)[0]).toContain("❯ first prompt");
    adapter.dispose();
    muted.mockClear();
    expect(f.root[LAYOUT_NODE]).toBe(wrapped);
    expect(plain(f.render().lines)[0]).not.toContain("❯");
    expect(muted).not.toHaveBeenCalled();
  });

  test("collapses the whitespace of a multi-line prompt into one clean row", () => {
    const f = fixture("  first\n\n   prompt \t here  ");
    f.render();
    f.transcript.scrollTo(8);
    expect(plain(f.render().lines)[0]).toBe(
      `❯ first prompt here${" ".repeat(40 - "❯ first prompt here".length)}`,
    );
    f.adapter.dispose();
  });

  test("dispose puts the root's layout property back exactly as it found it", () => {
    const f = fixture();
    f.adapter.dispose();
    const ownBefore = Object.getOwnPropertyDescriptor(f.root, LAYOUT_NODE);
    const methodBefore = f.root[LAYOUT_NODE];
    const adapter = createHostAdapter(f.tui, (text) => text);
    expect(f.root[LAYOUT_NODE]).not.toBe(methodBefore);
    adapter.dispose();
    expect(f.root[LAYOUT_NODE]).toBe(methodBefore);
    expect(Object.getOwnPropertyDescriptor(f.root, LAYOUT_NODE)).toStrictEqual(ownBefore);
  });

  test("dispose also restores an own layout property the root already had", () => {
    const f = fixture();
    f.adapter.dispose();
    const inherited = f.root[LAYOUT_NODE];
    const own = () => inherited.call(f.root);
    Object.defineProperty(f.root, LAYOUT_NODE, { configurable: true, writable: true, value: own });
    const adapter = createHostAdapter(f.tui, (text) => text);
    expect(f.root[LAYOUT_NODE]).not.toBe(own);
    adapter.dispose();
    expect(f.root[LAYOUT_NODE]).toBe(own);
  });

  test.each(
    (["transcript", "dock"] as const).flatMap((which) =>
      [{ basis: 1 }, { grow: 2 }, { shrink: 0 }, { minSize: 0 }, { minSize: 2 }].map(
        (change) => [which, change] as const,
      ),
    ),
  )("does not patch a root whose %s allocation drifted by %j", (which, change) => {
    const f = fixture();
    f.adapter.dispose();
    const { root, layoutNode } = driftedRoot(f.root, which, change);
    f.tui.setLayoutRoot(root);
    const adapter = createHostAdapter(f.tui, (text) => text);
    expect(root[LAYOUT_NODE]).toBe(layoutNode);
    adapter.dispose();
  });

  test.each([null, {}])("invalid duck-scroll document fails closed %#", (document) => {
    const f = fixture();
    f.render();
    f.transcript.scrollTo(8);
    const children = f.transcript.children;
    Reflect.set(children, "0", document);
    expect(visible(f.root)).toBe(false);
    f.adapter.dispose();
  });

  test("branch and compaction document rebuilds never retain stale prompt context", () => {
    const f = fixture();
    f.render();
    f.transcript.scrollTo(8);
    expect(plain(f.render().lines)[0]).toContain("❯ first prompt");
    f.document.clear();
    f.document.addChild(new UserMessageComponent("replacement branch"));
    f.document.addChild(new Text("rebuilt output\n".repeat(40), 0, 0));
    expect(plain(f.render().lines)[0]).toContain("❯ replacement branch");
    f.document.clear();
    f.document.addChild(new UserMessageComponent("compacted"));
    f.document.addChild(new Text("short output", 0, 0));
    const compacted = f.render();
    expect(plain(compacted.lines)[0]).not.toContain("❯");
    expect(f.transcript.isFollowingEnd).toBe(true);
    expect(f.transcript.scrollTop).toBe(0);
    f.adapter.dispose();
  });

  test("suppresses while native prompt text is partially visible and selects later turn", () => {
    const f = fixture();
    f.render();
    f.transcript.scrollTo(1);
    expect(plain(f.render().lines)[0]).not.toContain("❯");
    f.transcript.scrollTo(40);
    expect(plain(f.render().lines)[0]?.trim()).toBe("❯ second prompt");
    f.adapter.dispose();
  });

  test("a scroll-only frame that reuses earlier output still shows the new turn's prompt", () => {
    const f = fixture();
    f.render();
    f.transcript.scrollTo(40);
    const later = f.render();
    expect(plain(later.lines)[0]?.trim()).toBe("❯ second prompt");
    const previousFrameCacheForScrollOnlyFrame = later.renderCache;
    f.transcript.scrollTo(8);

    const reused = renderLayoutFrame(
      f.root,
      40,
      12,
      () => undefined,
      previousFrameCacheForScrollOnlyFrame,
    );

    expect(plain(reused.lines)[0]?.trim()).toBe("❯ first prompt");
    f.transcript.scrollTo(40);
    const back = renderLayoutFrame(f.root, 40, 12, () => undefined, reused.renderCache);
    expect(plain(back.lines)[0]?.trim()).toBe("❯ second prompt");
    f.adapter.dispose();
  });

  test("near-bottom and resize converge without render loops or blank reserved row", () => {
    const f = fixture();
    f.render();
    f.transcript.scrollBy(-1);
    const before = f.request.mock.calls.length;
    const first = f.render();
    expect(f.render().lines).toStrictEqual(first.lines);
    expect(f.request.mock.calls).toHaveLength(before);
    const resized = f.render(40, 100);
    expect(plain(resized.lines)[0]).not.toContain("❯");
    expect(f.transcript.isFollowingEnd).toBe(true);
    expect(plain(f.render(40, 100).lines)[0]).not.toContain("❯");
    expect(plain(f.render(1, 2).lines).filter((line) => line.includes("❯"))).toHaveLength(0);
    f.adapter.dispose();
  });

  test("discovers a later fullscreen root and restores it on cleanup", () => {
    const f = fixture();
    f.adapter.dispose();
    f.tui.setLayoutRoot(undefined);
    const adapter = createHostAdapter(f.tui, (text) => text);
    f.tui.setLayoutRoot(f.root);
    adapter.render(40);
    f.render();
    f.transcript.scrollTo(8);
    expect(plain(f.render().lines)[0]).toContain("❯ first prompt");
    f.tui.setLayoutRoot(undefined);
    f.tui.setLayoutRoot(f.root);
    expect(plain(f.render().lines)[0]).toContain("❯ first prompt");
    adapter.dispose();
    expect(plain(f.render().lines)[0]).not.toContain("❯");
  });
});

describe("native prompt boundaries and row", () => {
  test("distinguishes identical messages and nonblank partial multiline text", () => {
    const user = new UserMessageComponent("same\n\nlast");
    const block = user.render(30);
    const lines = [...block, "answer", ...block, "answer"];
    expect(selectContext(lines, 1)).toBeUndefined();
    expect(selectContext(lines, block.length)).toBe("same last");
    expect(selectContext(lines, block.length + 2)).toBeUndefined();
    expect(selectContext(lines, block.length * 2 + 1)).toBe("same last");
  });
  test("blank turns keep ordinal identity without a blank sticky row", () => {
    const empty = new UserMessageComponent("").render(30);
    const next = new UserMessageComponent("next").render(30);
    const lines = [...empty, "answer", ...next, "answer"];
    expect(empty).toHaveLength(0);
    expect(selectContext(lines, empty.length, ["next"])).toBeUndefined();
    expect(selectContext(lines, lines.length - 1, ["next"])).toBe("next");
  });
  test.each([1, 2])("fits Unicode and strips ANSI at width %s", (width) => {
    const row = contextRow(
      "\u001b[31m界 é 👩‍💻\u001b[0m\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007",
      width,
    );

    expect(visibleWidth(row)).toBe(width);
    expect(row).not.toContain("\u001b");
  });
});
