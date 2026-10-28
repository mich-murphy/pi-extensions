import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { createChatViewport } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport";
import { initTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme";
import { renderLayoutFrame } from "../../../node_modules/@earendil-works/pi-tui/dist/layout";
import { getLayoutNode } from "../../../node_modules/@earendil-works/pi-tui/dist/layout-node";
import { testTui } from "../../../test-support/pi-tui";
import { contextRow, selectContext } from "../context";
import { createHostAdapter } from "../host";

initTheme("dark");

function fixture() {
  const document = new Container();
  document.addChild(new UserMessageComponent("first prompt"));
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
  const tui = testTui();
  Object.defineProperty(tui, "layoutRoot", {
    configurable: true,
    writable: true,
    value: viewport.root,
  });
  const request = vi.spyOn(tui, "requestRender").mockImplementation(() => undefined);
  const adapter = createHostAdapter(tui, (text) => text);
  const render = (width = 40, height = 12) =>
    renderLayoutFrame(viewport.root, width, height, () => undefined);
  return { ...viewport, document, output, tui, adapter, render, request };
}

const plain = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line));

function callMethod(method: unknown, receiver: unknown): unknown {
  return typeof method === "function" ? Reflect.apply(method, receiver, []) : undefined;
}

function visible(component: Component): boolean | undefined {
  const node = getLayoutNode(component);
  return node?.type === "vstack"
    ? node.entries[0]?.visible?.({ width: 40, height: 12 })
    : undefined;
}

describe("native chat viewport", () => {
  test("shows contextual historical turn, keeps anchor through streaming and reclaims bottom row", () => {
    const f = fixture();
    expect(plain(f.render().lines)[0]).not.toContain("❯");
    f.transcript.scrollTo(8);
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
    const symbol = Symbol.for("@earendil-works/pi-tui/layout-node");
    const patched: unknown = Reflect.get(f.root, symbol);
    const wrapped = () => callMethod(patched, f.root);
    Reflect.set(f.root, symbol, wrapped);
    f.render();
    f.transcript.scrollTo(8);
    expect(plain(f.render().lines)[0]).toContain("❯ first prompt");
    adapter.dispose();
    muted.mockClear();
    expect(Reflect.get(f.root, symbol)).toBe(wrapped);
    expect(plain(f.render().lines)[0]).not.toContain("❯");
    expect(muted).not.toHaveBeenCalled();
  });

  test.each([null, {}])("invalid duck-scroll document fails closed %#", (document) => {
    const f = fixture();
    f.render();
    f.transcript.scrollTo(8);
    // Invoke visibility without asking native layout to render an intentionally invalid child.
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

  test("discovers fullscreen after regular startup and restores the root on cleanup", () => {
    const f = fixture();
    f.adapter.dispose();
    Reflect.set(f.tui, "layoutRoot", undefined);
    const adapter = createHostAdapter(f.tui, (text) => text);
    Reflect.set(f.tui, "layoutRoot", f.root);
    adapter.render(40);
    f.render();
    f.transcript.scrollTo(8);
    expect(plain(f.render().lines)[0]).toContain("❯ first prompt");
    Reflect.set(f.tui, "layoutRoot", undefined);
    Reflect.set(f.tui, "layoutRoot", f.root);
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
  test.each([1, 2, 3, 8, 20])("fits Unicode and strips ANSI at width %s", (width) => {
    const row = contextRow(
      "\u001b[31m界 é 👩‍💻\u001b[0m\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007",
      width,
    );
    expect(visibleWidth(row)).toBe(width);
    expect(row).not.toContain("\u001b");
  });
});
