import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

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

/** Append a dimmed multi-line preview to a rendered tool result. */
export function appendExpandedPreview(
  base: string,
  preview: {
    readonly text: string;
    readonly theme: { readonly fg: (name: ThemeColor, value: string) => string };
    readonly maxLines?: number;
    readonly maxColumns?: number;
  },
): string {
  const { text, theme, maxLines = 12, maxColumns = 200 } = preview;
  const lines = text.split("\n");
  let output = base;
  for (const line of lines.slice(0, maxLines)) {
    output += `\n${theme.fg("dim", line.slice(0, maxColumns))}`;
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
  // SAFETY: pi's keyHint accepts built-in keybinding identifiers; this one is stable.
  return `${base} ${keyHint("app.tools.expand", "for details")}`;
}
