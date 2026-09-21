import { describe, expect, test } from "vitest";
import type { PromptBlock } from "../agent-request";
import { buildPromptStream } from "../sdk/prompt-stream";
import { drain, textBlock } from "./fixtures";

const CACHE_CONTROL = { type: "ephemeral", ttl: "1h" };
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

async function contentOf(blocks: ReadonlyArray<PromptBlock>, cacheBreakpoint?: number) {
  const messages = await drain(buildPromptStream(blocks, cacheBreakpoint));
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: "user", parent_tool_use_id: null });
  return messages[0]?.message.content;
}

describe("buildPromptStream", () => {
  test("sends the whole transcript as one SDK user message with one content block per prompt block", async () => {
    const blocks = ["intro", "entry-0", "entry-1", "outro"].map((text) => textBlock(text));

    expect(await contentOf(blocks, 2)).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "entry-0" },
      { type: "text", text: "entry-1", cache_control: CACHE_CONTROL },
      { type: "text", text: "outro" },
    ]);
  });

  test("sends no cache breakpoint when the request has none", async () => {
    expect(await contentOf([textBlock("intro"), textBlock("outro")])).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "outro" },
    ]);
  });

  test("expands a block's images into real Anthropic base64 image blocks right after its text block", async () => {
    expect(await contentOf([textBlock("intro"), textBlock("entry", [png])])).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "entry" },
      pngBlock,
    ]);
  });

  test("puts the cache breakpoint on the last image, not the text block, when a cached entry carries images", async () => {
    const jpeg = { data: "c2Vjb25k", mediaType: "image/jpeg" };

    expect(await contentOf([textBlock("entry", [png, jpeg])], 0)).toEqual([
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
    expect(await contentOf([textBlock("t", [png, bmp])])).toEqual([
      { type: "text", text: "t" },
      pngBlock,
      UNSUPPORTED_NOTE,
    ]);
  });

  test("puts the cache breakpoint on the degraded text note when the last image of a cached entry is unsupported", async () => {
    expect(await contentOf([textBlock("entry", [png, bmp])], 0)).toEqual([
      { type: "text", text: "entry" },
      pngBlock,
      { ...UNSUPPORTED_NOTE, cache_control: CACHE_CONTROL },
    ]);
  });

  test("produces the same degraded blocks turn after turn instead of throwing on a historical entry", async () => {
    const blocks = [textBlock("intro"), textBlock("entry", [bmp])];

    const firstTurn = await contentOf(blocks);

    expect(await contentOf(blocks)).toEqual(firstTurn);
    expect(firstTurn).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "entry" },
      UNSUPPORTED_NOTE,
    ]);
  });
});
