import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ImageAttachment, PromptBlock } from "../agent-request";

// Anthropic's vision input accepts these four raster formats. Unsupported
// historical images become deterministic text notes so replay keeps working.
const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

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

// A breakpoint belongs on the final expanded block so an entry's images are
// included in the cached prefix along with its text.
function toContentBlocks(block: PromptBlock, cacheBreakpoint: boolean) {
  const blocks = [
    { type: "text" as const, text: block.text },
    ...block.images.map(toAnthropicContentBlock),
  ];
  if (!cacheBreakpoint) return blocks;
  const cacheControl = { type: "ephemeral" as const, ttl: "1h" as const };
  return blocks.map((contentBlock, index) =>
    index === blocks.length - 1 ? { ...contentBlock, cache_control: cacheControl } : contentBlock,
  );
}

/**
 * Build the single-message streaming prompt consumed by the Claude Agent SDK.
 *
 * @param promptBlocks - Stable transcript blocks in wire order.
 * @param cacheBreakpoint - Index of the block that ends the cacheable prefix.
 * @returns An async stream containing one SDK user message.
 */
export async function* buildPromptStream(
  promptBlocks: ReadonlyArray<PromptBlock>,
  cacheBreakpoint: number | undefined,
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: promptBlocks.flatMap((block, index) =>
        toContentBlocks(block, index === cacheBreakpoint),
      ),
    },
  };
}
