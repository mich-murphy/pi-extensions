import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ZONE_START = "\u001B]133;A\u0007";
const ZONE_END = "\u001B]133;B\u0007";

export type PromptSpan = {
  readonly start: number;
  readonly end: number;
  readonly lastText: number;
  readonly text: string;
};

export type PromptIndex = ReadonlyArray<{
  readonly start: number;
  readonly lastText: number;
  readonly text: string;
}>;

export function promptSpans(lines: ReadonlyArray<string>, from = 0): Array<PromptSpan> {
  const spans: Array<PromptSpan> = [];
  let start: number | undefined;
  let lastText = -1;
  let parts: Array<string> = [];

  for (let index = from; index < lines.length; index++) {
    const line = lines[index] ?? "";

    if (line.startsWith(ZONE_START) && line !== ZONE_START) {
      start = index;
      parts = [];
      lastText = -1;
    }

    if (start === undefined) {
      continue;
    }

    const text = stripTerminalSequences(line).trim();

    if (text.length > 0) {
      parts.push(text);
      lastText = index;
    }

    if (line.startsWith(ZONE_END) || line.startsWith(ZONE_START + ZONE_END)) {
      spans.push({ start, end: index, lastText, text: parts.join(" ") });
      start = undefined;
    }
  }

  return spans;
}

export function labelPrompts(
  spans: ReadonlyArray<PromptSpan>,
  texts?: ReadonlyArray<string>,
): PromptIndex {
  return spans.map((span, index) => ({
    ...span,
    text: texts?.[index] ?? span.text,
  }));
}

function indexPrompts(lines: ReadonlyArray<string>, texts?: ReadonlyArray<string>): PromptIndex {
  return labelPrompts(promptSpans(lines), texts);
}

export function selectPrompt(index: PromptIndex, scrollTop: number): string | undefined {
  let low = 0;
  let high = index.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if ((index[middle]?.start ?? Number.POSITIVE_INFINITY) <= scrollTop) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const prompt = index[low - 1];

  if (prompt === undefined || prompt.lastText >= scrollTop) {
    return undefined;
  }

  return prompt.text.trim().length === 0 ? undefined : prompt.text;
}

export function selectContext(
  lines: ReadonlyArray<string>,
  scrollTop: number,
  texts?: ReadonlyArray<string>,
): string | undefined {
  return selectPrompt(indexPrompts(lines, texts), scrollTop);
}

export function contextRow(text: string, width: number): string {
  const safe = Array.from(stripTerminalSequences(text), (character) => {
    const code = character.codePointAt(0) ?? 0;

    return code < 32 || (code >= 127 && code <= 159) ? " " : character;
  }).join("");

  const row = stripTerminalSequences(truncateToWidth(`❯ ${safe}`, width, "…"));

  return row + " ".repeat(Math.max(0, width - visibleWidth(row)));
}
