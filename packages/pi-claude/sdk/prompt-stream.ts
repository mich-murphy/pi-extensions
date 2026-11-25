import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ImageAttachment, PromptBlock } from "../agent-request";

const ANTHROPIC_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

type AnthropicImageMediaType = (typeof ANTHROPIC_IMAGE_MEDIA_TYPES)[number];

const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(ANTHROPIC_IMAGE_MEDIA_TYPES);

export type CacheTtl = "none" | "5m" | "1h";

const RETENTION_VALUES: ReadonlySet<string> = new Set(["none", "short", "long"]);

function isCacheRetention(value: string | undefined): value is CacheRetention {
  return value !== undefined && RETENTION_VALUES.has(value);
}

export function cacheTtlFor(
  retention: CacheRetention | undefined,
  environmentRetention?: string,
): CacheTtl {
  const resolved =
    retention ?? (isCacheRetention(environmentRetention) ? environmentRetention : undefined);

  if (resolved === "none") {
    return "none";
  }

  return resolved === "long" ? "1h" : "5m";
}

function isSupportedImageMediaType(mediaType: string): mediaType is AnthropicImageMediaType {
  return SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType);
}

function toAnthropicContentBlock(image: ImageAttachment) {
  if (isSupportedImageMediaType(image.mediaType)) {
    return {
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
    };
  }

  return {
    type: "text" as const,
    text: `[Image data omitted from transcript: unsupported mime type "${image.mediaType}"]`,
  };
}

function cacheControlFor(ttl: Exclude<CacheTtl, "none">) {
  return ttl === "1h"
    ? { type: "ephemeral" as const, ttl: "1h" as const }
    : { type: "ephemeral" as const };
}

function toContentBlocks(block: PromptBlock, ttl: CacheTtl | undefined) {
  const blocks = [
    { type: "text" as const, text: block.text },
    ...block.images.map(toAnthropicContentBlock),
  ];

  if (ttl === undefined || ttl === "none") {
    return blocks;
  }

  const cacheControl = cacheControlFor(ttl);

  return blocks.map((contentBlock, index) =>
    index === blocks.length - 1 ? { ...contentBlock, cache_control: cacheControl } : contentBlock,
  );
}

export async function* buildPromptStream(
  promptBlocks: readonly PromptBlock[],
  cacheBreakpoints: readonly number[],
  ttl: CacheTtl = "5m",
): AsyncGenerator<SDKUserMessage> {
  const marked = new Set(cacheBreakpoints);
  yield {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: promptBlocks.flatMap((block, index) =>
        toContentBlocks(block, marked.has(index) ? ttl : undefined),
      ),
    },
  };
}
