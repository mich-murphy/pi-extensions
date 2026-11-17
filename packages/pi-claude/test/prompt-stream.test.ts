import { describe, expect, test } from "vitest";
import type { PromptBlock } from "../agent-request";
import { buildPromptStream, cacheTtlFor } from "../sdk/prompt-stream";
import type { CacheTtl } from "../sdk/prompt-stream";
import { drain, textBlock } from "./fixtures";

const CACHE_CONTROL = { type: "ephemeral" };
const UNSUPPORTED_NOTE = {
  type: "text",
  text: '[Image data omitted from transcript: unsupported mime type "image/bmp"]',
};
const png = { data: "c3VwcG9ydGVk", mediaType: "image/png" };
const pngBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: png.data },
};
const bmp = { data: "dW5zdXBwb3J0ZWQ=", mediaType: "image/bmp" };

async function contentOf(
  blocks: readonly PromptBlock[],
  cacheBreakpoints: readonly number[] = [],
  ttl?: CacheTtl,
) {
  const messages = await drain(buildPromptStream(blocks, cacheBreakpoints, ttl));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: "user", parent_tool_use_id: null });
  return messages[0]?.message.content;
}

describe("buildPromptStream", () => {
  test("sends the whole transcript as one SDK user message with one content block per prompt block", async () => {
    const blocks = ["intro", "entry-0", "entry-1", "outro"].map((text) => textBlock(text));

    await expect(contentOf(blocks, [2])).resolves.toStrictEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "entry-0" },
      { type: "text", text: "entry-1", cache_control: CACHE_CONTROL },
      { type: "text", text: "outro" },
    ]);
  });

  test("sends no cache breakpoint when the request has none", async () => {
    await expect(contentOf([textBlock("intro"), textBlock("outro")])).resolves.toStrictEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "outro" },
    ]);
  });

  test("expands a block's images into real Anthropic base64 image blocks right after its text block", async () => {
    await expect(contentOf([textBlock("intro"), textBlock("entry", [png])])).resolves.toStrictEqual(
      [{ type: "text", text: "intro" }, { type: "text", text: "entry" }, pngBlock],
    );
  });

  test("puts the cache breakpoint on the last image, not the text block, when a cached entry carries images", async () => {
    const jpeg = { data: "c2Vjb25k", mediaType: "image/jpeg" };

    await expect(contentOf([textBlock("entry", [png, jpeg])], [0])).resolves.toStrictEqual([
      { type: "text", text: "entry" },
      pngBlock,
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: jpeg.data },
        cache_control: CACHE_CONTROL,
      },
    ]);
  });

  test("degrades an unsupported image mime type to a text note alongside supported images", async () => {
    await expect(contentOf([textBlock("t", [png, bmp])])).resolves.toStrictEqual([
      { type: "text", text: "t" },
      pngBlock,
      UNSUPPORTED_NOTE,
    ]);
  });

  test("puts the cache breakpoint on the degraded text note when the last image of a cached entry is unsupported", async () => {
    await expect(contentOf([textBlock("entry", [png, bmp])], [0])).resolves.toStrictEqual([
      { type: "text", text: "entry" },
      pngBlock,
      { ...UNSUPPORTED_NOTE, cache_control: CACHE_CONTROL },
    ]);
  });

  test("produces the same degraded blocks turn after turn instead of throwing on a historical entry", async () => {
    const blocks = [textBlock("intro"), textBlock("entry", [bmp])];

    const firstTurn = await contentOf(blocks);

    await expect(contentOf(blocks)).resolves.toStrictEqual(firstTurn);
    expect(firstTurn).toStrictEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "entry" },
      UNSUPPORTED_NOTE,
    ]);
  });

  test("marks every breakpoint block, sending Anthropic's default 5m lifetime without a ttl field", async () => {
    const blocks = ["a", "b", "c"].map((text) => textBlock(text));

    await expect(contentOf(blocks, [0, 2], "5m")).resolves.toStrictEqual([
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b" },
      { type: "text", text: "c", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("sends no cache_control at all when caching is disabled", async () => {
    await expect(contentOf([textBlock("a")], [0], "none")).resolves.toStrictEqual([
      { type: "text", text: "a" },
    ]);
  });

  test.each([
    ["none", "none"],
    ["short", "5m"],
    ["long", "1h"],
    [undefined, "5m"],
  ] as const)("maps Pi cacheRetention %s to the %s lifetime", (retention, ttl) => {
    expect(cacheTtlFor(retention)).toBe(ttl);
  });

  test.each([
    ["none", "none"],
    ["short", "5m"],
    ["long", "1h"],
    ["bogus", "5m"],
  ] as const)(
    "PI_CACHE_RETENTION=%s selects the %s lifetime when the request sets none",
    (value, ttl) => {
      expect(cacheTtlFor(undefined, value)).toBe(ttl);
    },
  );

  test("the request's cacheRetention overrides PI_CACHE_RETENTION", () => {
    expect(cacheTtlFor("long", "short")).toBe("1h");
    expect(cacheTtlFor("none", "long")).toBe("none");
  });
});
