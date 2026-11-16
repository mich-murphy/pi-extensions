// Deterministic transcript for scroll.bombadil.ts, shared by its launch fixture. Each user prompt
// starts with a unique "Pnn:" marker and each assistant line with "TnnLmmm", so the specification
// can tell from screen rows alone which turn the top of the transcript belongs to. No prompt or
// reply contains Markdown syntax, and no prompt continuation row can start with a marker.

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod";

/** User prompt texts, in turn order. Turn n's prompt is PROMPTS[n - 1]. */
export const PROMPTS: readonly string[] = [
  "P01: alpha",
  `P02: ${"long ascii prompt that wraps ".repeat(6)}end`,
  "P03: 漢字かな混じり 日本語 文章 中文 汉字 한국어 wide characters",
  "P04: é ñ ü ø å ç latin extended",
  `P05: ${"very long prompt to force truncation at any width ".repeat(5)}tail`,
  "P06: two words",
  "P07: rocket 🚀 launch ✓ check → arrow",
  `P08: ${"漢字 ".repeat(40)}`,
  "P09: short",
  `P10: mixed é 漢 🚀 ${"medium length text ".repeat(3)}`,
  "P11: penultimate",
  `P12: LATEST ${"final prompt text ".repeat(4)}`,
];

const REPLY_LINES: readonly number[] = [4, 30, 12, 2, 45, 8, 20, 3, 35, 10, 6, 25];

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** The assistant reply for a 1-based turn: one marked line per row, every fifth one long. */
export function replyText(turn: number): string {
  const count = REPLY_LINES[turn - 1] ?? 5;
  return Array.from({ length: count }, (_, index) => {
    const line = index + 1;
    const tail = line % 5 === 0 ? ` ${FILLER}` : "";
    return `T${pad(turn, 2)}L${pad(line, 3)} reply for turn ${turn}${tail}`;
  }).join("\n");
}
