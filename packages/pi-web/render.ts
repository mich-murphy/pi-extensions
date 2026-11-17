import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** The slice of Pi's theme that the web tools render with. */
export type RenderTheme = {
  readonly fg: (name: ThemeColor, value: string) => string;
  readonly bold: (value: string) => string;
};

/** Extract joined text from pi tool result content items. */
export function getTextContent(
  content: readonly { readonly type: string; readonly text?: string }[] | undefined,
): string {
  if (!content) {
    return "";
  }
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

/**
 * Untrusted text (page content, search results, server headers, model arguments) as it may reach
 * the terminal. Control characters other than newline and bidirectional controls are dropped and
 * tabs become spaces: a page could otherwise clear the screen, set the terminal title or reorder
 * the text shown. An escape sequence is left as harmless visible text, such as "[2J".
 */
export function displayText(value: string): string {
  return value.replaceAll("\t", " ").replaceAll(/(?!\n)[\p{Cc}\p{Bidi_Control}]/gu, "");
}

/** Append a dimmed multi-line preview of untrusted text to a rendered tool result. */
export function appendExpandedPreview(
  base: string,
  preview: {
    readonly text: string;
    readonly theme: Pick<RenderTheme, "fg">;
    readonly maxLines?: number;
    readonly maxColumns?: number;
  },
): string {
  const { text, theme, maxLines = 12, maxColumns = 200 } = preview;
  const lines = text.split("\n");
  let output = base;
  for (const line of lines.slice(0, maxLines)) {
    output += `\n${theme.fg("dim", displayText(line).slice(0, maxColumns))}`;
  }
  if (lines.length > maxLines) {
    output += `\n${theme.fg("muted", "...")}`;
  }
  return output;
}

/** Append the expand-key hint unless the result is already expanded. */
export function appendExpandHint(base: string, expanded: boolean): string {
  if (expanded) {
    return base;
  }
  return `${base} ${keyHint("app.tools.expand", "for details")}`;
}
