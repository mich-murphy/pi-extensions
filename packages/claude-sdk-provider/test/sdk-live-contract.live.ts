import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { AgentRequest } from "../agent-request";
import type { BridgeEvent } from "../bridge";
import { createClaudeAgentSdkRunner } from "../sdk/runner";

const model: Model<Api> = {
  id: "sonnet",
  name: "Claude Sonnet live contract",
  api: "claude-sdk",
  provider: "claude-sdk",
  baseUrl: "agent-sdk://local-claude-code",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};

async function collect(request: AgentRequest): Promise<ReadonlyArray<BridgeEvent>> {
  const events: BridgeEvent[] = [];
  for await (const event of createClaudeAgentSdkRunner()(request, model)) events.push(event);
  return events;
}

function request(prompt: string, toolNames: ReadonlyArray<string> = []): AgentRequest {
  return {
    systemPrompt: "You are a live protocol contract probe. Follow the user request exactly.",
    promptBlocks: [{ text: prompt }],
    toolDescription:
      toolNames.length === 0
        ? "No Pi tools are available."
        : 'Available Pi tools: [{"name":"contract_probe","description":"Complete the live deferred-tool contract probe","parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}]',
    toolNames,
    conversationEntries: [],
  };
}

describe("pinned Claude Agent SDK live contract", () => {
  test("streams a normal text response", async () => {
    const events = await collect(request('Reply with exactly "CLAUDE_SDK_TEXT_OK".'));
    const text = events
      .filter(
        (event): event is Extract<BridgeEvent, { type: "text_delta" }> =>
          event.type === "text_delta",
      )
      .map((event) => event.text)
      .join("");

    expect(text.trim()).toBe("CLAUDE_SDK_TEXT_OK");
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
  });

  test("returns a deferred Pi tool call through the runner", async () => {
    const events = await collect(
      request(
        'Call the contract_probe Pi tool exactly once with {"value":"CLAUDE_SDK_TOOL_OK"}. Do not answer with text.',
        ["contract_probe"],
      ),
    );
    const calls = events.filter(
      (event): event is Extract<BridgeEvent, { type: "tool_call" }> => event.type === "tool_call",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: "tool_call",
      name: "contract_probe",
      arguments: { value: "CLAUDE_SDK_TOOL_OK" },
    });
    expect(events.some((event) => event.type === "failed")).toBe(false);
  });
});
