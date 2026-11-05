import { describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import { contextFixture } from "./fixtures";
import type { MessageFixture } from "./fixtures";

/** Estimator: ceil(characters / 4), a common rough ratio for English text and code. */
const tokens = (chars: number) => Math.ceil(chars / 4);

const readTool = {
  name: "read",
  description: "Read",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

function body(index: number): string {
  return Array.from(
    { length: 120 },
    (_, line) => `  const value${index}_${line} = compute("item \\"${line}\\"", { a: ${line} });`,
  ).join("\n");
}

function conversation(turns: number): MessageFixture[] {
  return [
    { role: "user", content: "Refactor the module" },
    ...Array.from({ length: turns }, (_, index): MessageFixture[] => [
      {
        role: "assistant",
        content: [
          { type: "text", text: `Reading file ${index}` },
          {
            type: "toolCall",
            id: `call_${index}`,
            name: "read",
            arguments: { path: `src/f${index}.ts` },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: `call_${index}`,
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: body(index) }],
      },
    ]).flat(),
  ];
}

/** The pre-change JSON-per-entry format (git show 7b1b345:packages/pi-claude-sdk/agent-request.ts). */
function oldFormat(messages: readonly MessageFixture[]): string[] {
  return messages.flatMap((message) => {
    if (message.role === "user") {
      return [JSON.stringify({ role: "user", content: [{ type: "text", text: message.content }] })];
    }
    if (message.role === "assistant") {
      const content = message.content.flatMap((block): object[] => {
        if (block.type === "text") {
          return [{ type: "text", text: block.text }];
        }
        if (block.type === "toolCall") {
          return [
            {
              type: "toolCall",
              id: block.id,
              name: `mcp__pi__${block.name}`,
              arguments: block.arguments,
            },
          ];
        }
        return [];
      });
      return [JSON.stringify({ role: "assistant", content })];
    }
    if (message.role !== "toolResult") {
      return [];
    }
    return [
      JSON.stringify({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: `mcp__pi__${message.toolName}`,
        isError: message.isError,
        content: message.content,
      }),
    ];
  });
}

describe("replay size", () => {
  test("the tagged format is smaller than JSON-in-JSON for code-heavy tool output", () => {
    const messages = conversation(12);
    const oldChars = oldFormat(messages).join("\n").length;
    const request = buildAgentRequest(
      contextFixture({ systemPrompt: "s", messages, tools: [readTool] }),
    );
    const newChars = request.promptBlocks
      .slice(1, -1)
      .map((block) => block.text)
      .join("\n").length;
    // oxlint-disable-next-line eslint/no-console
    console.info(
      `replay-size old=${oldChars} chars (~${tokens(oldChars)} tok) new=${newChars} chars (~${tokens(newChars)} tok) saved=${(((oldChars - newChars) / oldChars) * 100).toFixed(1)}%`,
    );
    expect(newChars).toBeLessThan(oldChars);
  });
});
