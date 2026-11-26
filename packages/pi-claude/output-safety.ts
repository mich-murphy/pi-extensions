import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { hasExecutableCat } from "./output-safety-shell";

export type SuspiciousOutputKind = "binary" | "base64";

const MIN_SUSPICIOUS_CHARACTERS = 4096;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/u;

const OUTSIDE_BASE64_TEXT = /[^A-Za-z0-9+/=\s]/u;
const REPLACEMENT_CHARACTER = 65_533;
const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

function isControlUnit(code: number): boolean {
  if (code < 32) {
    return code !== TAB && code !== LINE_FEED && code !== CARRIAGE_RETURN;
  }

  return code === REPLACEMENT_CHARACTER;
}

function controlCharacterCount(text: string): number {
  let count = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (isControlUnit(text.codePointAt(index) ?? TAB)) {
      count += 1;
    }
  }

  return count;
}

function suspiciousOutputKind(text: string): SuspiciousOutputKind | undefined {
  if (text.length < MIN_SUSPICIOUS_CHARACTERS) {
    return undefined;
  }

  const controlCharacters = controlCharacterCount(text);

  if (controlCharacters >= 8 && controlCharacters / text.length >= 0.002) {
    return "binary";
  }

  if (OUTSIDE_BASE64_TEXT.test(text)) {
    return undefined;
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
  readonly content: Array<TextContent | ImageContent>;
  readonly detected: SuspiciousOutputKind | undefined;
};

export function sanitizeBashContent(
  content: ReadonlyArray<TextContent | ImageContent>,
): SanitizedBashContent {
  const combinedText = content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
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

export type ContextMessage =
  | ContextEvent["messages"][number]
  | (Omit<ToolResultMessage, "content"> & { readonly content: string });

export function sanitizeContextMessages(
  messages: Readonly<ContextEvent["messages"]>,
): ContextEvent["messages"];
export function sanitizeContextMessages(
  messages: ReadonlyArray<ContextMessage>,
): Array<ContextMessage>;
export function sanitizeContextMessages(
  messages: ReadonlyArray<ContextMessage>,
): Array<ContextMessage> {
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
