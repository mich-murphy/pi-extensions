import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ZONE_START = "\u001B]133;A\u0007";
const ZONE_END = "\u001B]133;B\u0007";

type PromptSpan = { start: number; lastText: number; text: string };

function promptSpans(lines: ReadonlyArray<string>): Array<PromptSpan> {
  const spans: Array<PromptSpan> = [];
  let start: number | undefined;
  let lastText = -1;
  let parts: Array<string> = [];

  for (const [index, line] of lines.entries()) {
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
      spans.push({ start, lastText, text: parts.join(" ") });
      start = undefined;
    }
  }

  return spans;
}

export function selectContext(
  lines: ReadonlyArray<string>,
  scrollTop: number,
  texts?: ReadonlyArray<string>,
): string | undefined {
  const spans = promptSpans(lines);
  const prompt = spans.findLast((span) => span.start <= scrollTop);

  if (prompt === undefined || prompt.lastText >= scrollTop) {
    return undefined;
  }

  const text = texts?.[spans.indexOf(prompt)] ?? prompt.text;

  return text.trim().length === 0 ? undefined : text;
}

export function contextRow(text: string, width: number): string {
  const safe = Array.from(stripTerminalSequences(text), (character) => {
    const code = character.codePointAt(0) ?? 0;

    return code < 32 || (code >= 127 && code <= 159) ? " " : character;
  }).join("");

  const row = stripTerminalSequences(truncateToWidth(`❯ ${safe}`, width, "…"));

  return row + " ".repeat(Math.max(0, width - visibleWidth(row)));
}
