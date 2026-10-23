import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { assert, describe, expect, test } from "vitest";
import type { AgentRequest } from "../agent-request";
import type { BridgeEvent } from "../bridge";
import { models, undatedModelId } from "../models";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { ModelObservation, RunnerOptions, RunSdkQuery } from "../sdk/runner";
import { subscriptionEnvironment } from "../sdk/subscription-environment";
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
  maxTokens: 64_000,
};

async function collect(
  agentRequest: AgentRequest,
  probeModel: Model<Api> = model,
  options: RunnerOptions = {},
  streamOptions?: SimpleStreamOptions,
): Promise<readonly BridgeEvent[]> {
  const runSdkQuery = options.runSdkQuery ?? query;
  const results: unknown[] = [];
  async function* observedQuery(params: Parameters<RunSdkQuery>[0]): AsyncGenerator {
    for await (const message of runSdkQuery(params)) {
      if (isTerminalResult(message)) {
        results.push(message);
      }
      yield message;
    }
  }
  const events = await drain(
    createClaudeAgentSdkRunner({ ...options, runSdkQuery: observedQuery })(
      agentRequest,
      probeModel,
      streamOptions,
    ),
  );
  if (events.at(-1)?.type === "failed") {
    return events;
  }
  expect(results, "each controlled probe must finish in one SDK model round-trip").toMatchObject([
    { num_turns: 1 },
  ]);
  return events;
}

function textOf(events: readonly BridgeEvent[]): string {
  return events.flatMap((event) => (event.type === "text_delta" ? [event.text] : [])).join("");
}

function request(prompt: string, toolNames: readonly string[] = []): AgentRequest {
  return requestFixture({
    systemPrompt: "You are a live protocol contract probe. Follow the user request exactly.",
    promptBlocks: [textBlock(prompt)],
    tools: toolNames.map((name) => {
      let field = "value";
      if (name === "read") {
        field = "path";
      }
      if (name === "bash") {
        field = "command";
      }
      return {
        name,
        description: `Live ${name} contract`,
        parameters: {
          type: "object",
          properties: { [field]: { type: "string" } },
          required: [field],
        },
      };
    }),
    toolNames: new Set(toolNames),
  });
}

const isTerminalResult = Schema.is(Schema.Struct({ type: Schema.Literal("result") }));

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

// oxlint-disable-next-line eslint/require-yield -- Metadata needs an idle query, not a billable prompt.
async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (!signal.aborted) {
    await once(signal, "abort");
  }
}

function expectedThinkingMetadata(canonicalModel: string) {
  // Haiku 4.5 uses manual thinking budgets, not adaptive thinking or native effort.
  const adaptive = canonicalModel !== "claude-haiku-4-5";
  return {
    supportsAdaptiveThinking: adaptive,
    supportsEffort: adaptive,
    supportedEffortLevels: adaptive ? ["low", "medium", "high", "xhigh", "max"] : [],
  };
}

describe("installed Claude Agent SDK live contract", () => {
  const verified = new Set<LiveContract>();
  let observedDeferredResult: DeferredResult | undefined;
  let metadataVerified = false;

  test("model metadata resolves selectors and advertises native effort levels without a prompt", async () => {
    const abortController = new AbortController();
    const sdkQuery = query({
      prompt: idlePrompt(abortController.signal),
      options: {
        abortController,
        env: { ...subscriptionEnvironment() },
        persistSession: false,
        settingSources: [],
        tools: [],
      },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const supportedModels = await Promise.race([
        sdkQuery.supportedModels(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("Timed out waiting for SDK model metadata"));
          }, 20_000);
        }),
      ]);
      for (const entry of models) {
        const metadata = supportedModels.find(
          (candidate) => undatedModelId(candidate.value) === entry.sdkModel,
        );
        assert(metadata !== undefined, `missing model metadata for ${entry.sdkModel}`);
        assert(metadata.resolvedModel !== undefined, `missing resolution for ${entry.sdkModel}`);
        expect(undatedModelId(metadata.resolvedModel)).toBe(entry.canonicalModel);
        const {
          supportsAdaptiveThinking = false,
          supportsEffort = false,
          supportedEffortLevels = [],
        } = metadata;
        expect({ supportsAdaptiveThinking, supportsEffort, supportedEffortLevels }).toStrictEqual(
          expectedThinkingMetadata(entry.canonicalModel),
        );
      }
      metadataVerified = true;
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      sdkQuery.close();
    }
  });

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
    const legacyHaiku = models.find((entry) => entry.id === "claude-4.5-haiku");
    assert(legacyHaiku !== undefined, "missing legacy Haiku model");
    const command = String.raw`find . -type f \( -name '*.ts' -o -name '*.md' \) -print`;
    const bashRequest = request(
      `Request the bash Pi tool exactly once with this exact command: ${JSON.stringify(command)}. Do not execute it or answer with text.`,
      ["bash"],
    );
    const bashEvents = await collect(
      {
        ...bashRequest,
        toolDescription:
          'Available Pi tools: [{"name":"bash","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}]',
      },
      modelFixture(legacyHaiku),
      {},
      { reasoning: "medium" },
    );
    expect(bashEvents.at(-1)).toMatchObject({
      type: "tool_calls",
      calls: [{ name: "bash", arguments: { command } }],
    });
    verified.add("deferred-tool-call");
  });

  test("serves the advertised model id and limits for every registered selector", async () => {
    for (const entry of models) {
      const observations: ModelObservation[] = [];

      const events = await collect(
        request('Reply with exactly "CLAUDE_SDK_MODEL_OK".'),
        { ...modelFixture(entry), contextWindow: entry.contextWindow, maxTokens: entry.maxTokens },
        {
          modelObserver: (observation) => {
            observations.push(observation);
          },
        },
        { reasoning: "low" },
      );

      expect(events.at(-1)).toStrictEqual({ type: "done", reason: "stop" });
      expect(observations).toHaveLength(1);
      const [observation] = observations;
      assert(observation !== undefined, "test setup: no model observation recorded");
      expect(undatedModelId(observation.canonicalModel), `${entry.id} resolution`).toBe(
        entry.canonicalModel,
      );
      expect(observation.contextWindow, `${entry.id} context window`).toBe(entry.contextWindow);
      expect(observation.maxOutputTokens, `${entry.id} output limit`).toBe(entry.maxTokens);
    }
    expect(metadataVerified, "model metadata must also pass in this run").toBe(true);
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
