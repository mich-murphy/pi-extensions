import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BombadilFixture } from "../../../../test-support/bombadil.ts";
import { PROMPTS, replyText } from "./scroll-prompts.ts";

const TIMESTAMP = 1_700_000_000_000;
const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sessionLines(cwd: string): string[] {
  const time = new Date(TIMESTAMP).toISOString();
  const entries: unknown[] = [
    { type: "session", version: 3, id: "scroll-bombadil", timestamp: time, cwd },
  ];
  let parentId: string | null = null;
  const message = (value: Record<string, unknown>): void => {
    const id = String(entries.length).padStart(8, "0");
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: time,
      message: { ...value, timestamp: TIMESTAMP },
    });
    parentId = id;
  };
  for (const [index, prompt] of PROMPTS.entries()) {
    message({ role: "user", content: prompt });
    message({
      role: "assistant",
      content: [{ type: "text", text: replyText(index + 1) }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      stopReason: "stop",
      usage: USAGE,
    });
  }
  return entries.map((entry) => JSON.stringify(entry));
}

const fixture: BombadilFixture = (root) => {
  const session = join(root.sessions, "scroll.jsonl");
  writeFileSync(session, `${sessionLines(root.cwd).join("\n")}\n`);
  writeFileSync(
    join(root.agent, "keybindings.json"),
    JSON.stringify({
      "tui.altScreen.lineUp": "f6",
      "tui.altScreen.lineDown": "f7",
      "tui.altScreen.top": "f8",
      "tui.altScreen.bottom": "f9",
      "tui.altScreen.halfPageUp": "f10",
      "tui.altScreen.halfPageDown": "f11",
    }),
  );
  return { session, settings: { tuiMode: "fullscreen", fullscreenScrollbar: "hidden" } };
};
export default fixture;
