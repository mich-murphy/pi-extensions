import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { AgentRequest } from "../agent-request";
import type { BridgeEvent } from "../bridge";
import { models, undatedModelId } from "../models";
import {
  createClaudeAgentSdkRunner,
  type ModelObservation,
  type RunnerOptions,
} from "../sdk/runner";
import { drain, modelFixture, requestFixture, textBlock } from "./fixtures";

const model: Model<Api> = {
  id: "claude-5.1-fable",
  name: "Claude Fable 5.1 live contract",
  api: "claude-sdk",
  provider: "claude-sdk",
  baseUrl: "agent-sdk://local-claude-code",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function collect(
  request: AgentRequest,
  probeModel: Model<Api> = model,
  options: RunnerOptions = {},
): Promise<ReadonlyArray<BridgeEvent>> {
  return drain(createClaudeAgentSdkRunner(options)(request, probeModel));
}

function request(prompt: string, toolNames: ReadonlyArray<string> = []): AgentRequest {
  return requestFixture({
    systemPrompt: "You are a live protocol contract probe. Follow the user request exactly.",
    promptBlocks: [textBlock(prompt)],
    toolDescription:
      toolNames.length === 0
        ? "No Pi tools are available."
        : 'Available Pi tools: [{"name":"contract_probe","description":"Complete the live deferred-tool contract probe","parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}]',
    toolNames: new Set(toolNames),
  });
}

describe("pinned Claude Agent SDK live contract", () => {
  test("streams a normal text response", async () => {
    const events = await collect(request('Reply with exactly "CLAUDE_SDK_TEXT_OK".'));
    const text = events
      .flatMap((event) => (event.type === "text_delta" ? [event.text] : []))
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
    expect(events.at(-1)).toMatchObject({
      type: "tool_calls",
      calls: [{ name: "contract_probe", arguments: { value: "CLAUDE_SDK_TOOL_OK" } }],
    });
  });

  test("serves the advertised model id and limits for every registered selector", async () => {
    for (const entry of models) {
      const observations: ModelObservation[] = [];
      const probeModel = modelFixture({
        ...entry,
        api: "claude-sdk",
        provider: "claude-sdk",
      });

      const events = await collect(
        request('Reply with exactly "CLAUDE_SDK_MODEL_OK".'),
        probeModel,
        { modelObserver: (observation) => observations.push(observation) },
      );

      expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
      expect(observations).toHaveLength(1);
      const observation = observations[0];
      if (!observation) throw new Error("test setup: no model observation recorded");
      expect(undatedModelId(observation.canonicalModel)).toBe(entry.canonicalModel);
      expect(observation.contextWindow).toBe(entry.contextWindow);
    }
  });
});
