import { writeFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { assert, describe, expect, test } from "vitest";
import type { AgentRequest } from "../agent-request";
import type { BridgeEvent } from "../bridge";
import { models, undatedModelId } from "../models";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { ModelObservation, RunnerOptions, RunSdkQuery } from "../sdk/runner";
import { drain, modelFixture, requestFixture, textBlock } from "./fixtures";
import {
  decodeReleaseContract,
  formatReleaseContract,
  LIVE_CONTRACTS,
  RELEASE_CONTRACT_URL,
  readInstalledSdk,
} from "./release-contract";
import type { DeferredResult, LiveContract } from "./release-contract";

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

async function collect(
  agentRequest: AgentRequest,
  probeModel: Model<Api> = model,
  options: RunnerOptions = {},
): Promise<readonly BridgeEvent[]> {
  return drain(createClaudeAgentSdkRunner(options)(agentRequest, probeModel));
}

function textOf(events: readonly BridgeEvent[]): string {
  return events.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("");
}

function request(prompt: string, toolNames: readonly string[] = []): AgentRequest {
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

// A result message that reports the defer, named by the field that carried it.
const isStopReasonDeferred = Schema.is(
  Schema.Struct({ type: Schema.Literal("result"), stop_reason: Schema.Literal("tool_deferred") }),
);
const isTerminalReasonDeferred = Schema.is(
  Schema.Struct({
    type: Schema.Literal("result"),
    terminal_reason: Schema.Literal("tool_deferred"),
  }),
);

function deferredResultOf(message: unknown): DeferredResult | undefined {
  if (isStopReasonDeferred(message)) {
    return "stop_reason:tool_deferred";
  }
  return isTerminalReasonDeferred(message) ? "terminal_reason:tool_deferred" : undefined;
}

/** Run the real SDK query, reporting how its result message signalled a deferred tool call. */
function observingDefer(observe: (result: DeferredResult) => void): RunSdkQuery {
  return async function* observedQuery(params) {
    for await (const message of query(params)) {
      const deferred = deferredResultOf(message);
      if (deferred !== undefined) {
        observe(deferred);
      }
      yield message;
    }
  };
}

// Tests in a file run in order, so the attestation test sees every contract that passed before it.
describe("installed Claude Agent SDK live contract", () => {
  const verified = new Set<LiveContract>();
  let observedDeferredResult: DeferredResult | undefined;

  test("streams a normal text response", async () => {
    const events = await collect(request('Reply with exactly "CLAUDE_SDK_TEXT_OK".'));

    expect(textOf(events).trim()).toBe("CLAUDE_SDK_TEXT_OK");
    expect(events.at(-1)).toStrictEqual({ type: "done", reason: "stop" });
    verified.add("text-response");
  });

  test("returns a deferred Pi tool call through the runner", async () => {
    const events = await collect(
      request(
        'Call the contract_probe Pi tool exactly once with {"value":"CLAUDE_SDK_TOOL_OK"}. Do not answer with text.',
        ["contract_probe"],
      ),
      model,
      {
        runSdkQuery: observingDefer((result) => {
          observedDeferredResult = result;
        }),
      },
    );
    expect(events.at(-1)).toMatchObject({
      type: "tool_calls",
      calls: [{ name: "contract_probe", arguments: { value: "CLAUDE_SDK_TOOL_OK" } }],
    });
    expect(observedDeferredResult).toBeDefined();

    // Regression for a coding request that once printed <invoke> markup instead
    // of making a real call. A plain text answer must not satisfy this check.
    const codingRequest = request(
      "Update this project's SDK dependency. First read package.json using the read Pi tool with path package.json. Wait for the tool result before editing or answering.",
      ["read"],
    );
    const readEvents = await collect({
      ...codingRequest,
      toolDescription: [
        "Request one tool from Pi; do not print tool-call markup in your response.",
        'Available Pi tools: [{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}]',
      ].join("\n"),
    });
    expect(readEvents.at(-1)).toMatchObject({
      type: "tool_calls",
      calls: [{ name: "read", arguments: { path: "package.json" } }],
    });
    verified.add("deferred-tool-call");
  });

  test("serves the advertised model id and limits for every registered selector", async () => {
    for (const entry of models) {
      const observations: ModelObservation[] = [];

      const events = await collect(
        request('Reply with exactly "CLAUDE_SDK_MODEL_OK".'),
        modelFixture(entry),
        {
          modelObserver: (observation) => {
            observations.push(observation);
          },
        },
      );

      expect(events.at(-1)).toStrictEqual({ type: "done", reason: "stop" });
      expect(observations).toHaveLength(1);
      const [observation] = observations;
      assert(observation !== undefined, "test setup: no model observation recorded");
      expect(undatedModelId(observation.canonicalModel)).toBe(entry.canonicalModel);
      expect(observation.contextWindow).toBe(entry.contextWindow);
    }
    verified.add("advertised-models");
  });

  test("attests the installed SDK once every contract passed", async () => {
    expect(
      LIVE_CONTRACTS.filter((contract) => !verified.has(contract)),
      "contracts that did not pass in this run",
    ).toStrictEqual([]);
    const installed = await readInstalledSdk();
    const attestation = decodeReleaseContract({
      schemaVersion: 1,
      agentSdkVersion: installed.version,
      bundledClaudeCodeVersion: installed.claudeCodeVersion,
      verifiedAt: new Date().toISOString().replace(/\.\d+Z$/u, "Z"),
      model: "fable",
      contracts: LIVE_CONTRACTS,
      observedDeferredResult,
    });
    await writeFile(RELEASE_CONTRACT_URL, formatReleaseContract(attestation));
  });
});
