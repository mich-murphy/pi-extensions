import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

export type RenderTheme = {
  readonly fg: (name: ThemeColor, value: string) => string;
  readonly bold: (value: string) => string;
};

const isTextContent = Schema.is(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);

export function getTextContent(
  content: readonly { readonly type: string; readonly text?: string }[] | undefined,
): string {
  if (!content) {
    return "";
  }

  return content
    .filter((item) => isTextContent(item))
    .map((item) => item.text)
    .join("\n");
}

export function displayText(value: string): string {
  return value.replaceAll("\t", " ").replaceAll(/(?!\n)[\p{Cc}\p{Bidi_Control}]/gu, "");
}

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

export function appendExpandHint(base: string, expanded: boolean): string {
  if (expanded) {
    return base;
  }

  return `${base} ${keyHint("app.tools.expand", "for details")}`;
}
