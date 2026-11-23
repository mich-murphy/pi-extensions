import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { hasExecutableCat } from "./output-safety-shell";

export type SuspiciousOutputKind = "binary" | "base64";

const MIN_SUSPICIOUS_CHARACTERS = 4096;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/u;

function suspiciousOutputKind(text: string): SuspiciousOutputKind | undefined {
  if (text.length < MIN_SUSPICIOUS_CHARACTERS) {
    return undefined;
  }

  let controlCharacters = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      character === "\uFFFD" ||
      codePoint === 0 ||
      (codePoint !== undefined &&
        codePoint < 32 &&
        character !== "\n" &&
        character !== "\r" &&
        character !== "\t")
    ) {
      controlCharacters += 1;
    }
  }
  if (controlCharacters >= 8 && controlCharacters / text.length >= 0.002) {
    return "binary";
  }

  const compact = text.replaceAll(/\s/gu, "");
  if (
    compact.length >= 8192 &&
    compact.length / text.length >= 0.95 &&
    BASE64_ALPHABET.test(compact)
  ) {
    return "base64";
  }
  return undefined;
}

function quarantineNotice(kind: SuspiciousOutputKind, characters: number): string {
  const label = kind === "binary" ? "Binary-like" : "Base64-like";
  const advice =
    kind === "binary"
      ? "Use file, otool, or strings instead of cat for executables."
      : "Write encoded data to a file and check its type or size instead of printing it.";
  return `[${label} bash output quarantined and kept out of context (${characters.toLocaleString("en-US")} characters). ${advice}]`;
}

export type SanitizedBashContent = {
  readonly content: (TextContent | ImageContent)[];
  readonly detected: SuspiciousOutputKind | undefined;
};

export function sanitizeBashContent(
  content: readonly (TextContent | ImageContent)[],
): SanitizedBashContent {
  const combinedText = content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const detected = suspiciousOutputKind(combinedText);
  if (detected) {
    return {
      content: [{ type: "text", text: quarantineNotice(detected, combinedText.length) }],
      detected,
    };
  }
  return { content: [...content], detected: undefined };
}

export function inspectBashCommand(command: string): string | undefined {
  if (!hasExecutableCat(command)) {
    return undefined;
  }
  return 'Blocked, so the command did not run: it may print an executable, or its shell syntax cannot be checked. Use file "$(which COMMAND)", otool or strings; use the write tool for literal content.';
}

export function sanitizeContextMessages(
  messages: Readonly<ContextEvent["messages"]>,
): ContextEvent["messages"] {
  return messages.map((message) => {
    if (message.role !== "toolResult" || message.toolName !== "bash") {
      return message;
    }
    if (!Array.isArray(message.content)) {
      return message;
    }
    const sanitized = sanitizeBashContent(message.content);
    return sanitized.detected ? { ...message, content: sanitized.content } : message;
  });
}
