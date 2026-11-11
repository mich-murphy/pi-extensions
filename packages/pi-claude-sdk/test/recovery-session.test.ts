import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assert, describe, expect, test } from "vitest";
import type { AgentSdkRun } from "../bridge";
import { createAgentSdkStream } from "../bridge";
import registerClaudeSdkProvider from "../index";
import type { RunSdkQuery } from "../sdk/runner";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import {
  VALIDATION_ERROR_TOOL,
  normalizeValidationResult,
  validationRecoveryReason,
} from "../validation-recovery";
import {
  deliverToolUse,
  drain,
  sdkPromptFixture,
  installedHook,
  resultMessage,
  sonnet,
  streamEvent,
  textDelta,
} from "./fixtures";

async function runSessionRecovery() {
  const dir = await mkdtemp(join(tmpdir(), "sdk-recovery-session-"));
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const counts = { queries: 0, executions: 0, rejectedExecutions: 0 };
  const manager = SessionManager.create(dir, dir);
  const runner = recoveryRunner(manager, counts);
  const resourceLoader = recoveryResources(dir, settingsManager, runner, counts);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      model: sonnet,
      resourceLoader,
      settingsManager,
      sessionManager: manager,
      tools: ["probe"],
    }));
    expect(session.agent.state.tools.map((tool) => tool.name)).not.toContain(VALIDATION_ERROR_TOOL);
    await session.prompt("Use probe");
    expect(counts.queries).toBe(3);
    expect(counts.executions).toBe(1);
    expect(counts.rejectedExecutions).toBe(0);
    expect(SessionManager.open(sessionFile(manager)).getEntries()).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "toolResult",
          toolCallId: "corrected",
          isError: false,
        }) as unknown,
      }),
    );
  } finally {
    session?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

function checkNegativeResults() {
  const message = rejectedMessage;
  const assistant = syntheticAssistant;
  expect(normalizeValidationResult(message, [])).toBeUndefined();
  expect(normalizeValidationResult(message, [{ ...assistant, provider: "other" }])).toBeUndefined();
  expect(
    normalizeValidationResult({ ...message, toolCallId: "unrelated" }, [assistant]),
  ).toBeUndefined();
  expect(normalizeValidationResult({ ...message, isError: false }, [assistant])).toBeUndefined();
  expect(
    normalizeValidationResult(
      { ...message, content: [{ type: "text", text: "Tool execution aborted" }] },
      [assistant],
    ),
  ).toBeUndefined();
  const result = normalizeValidationResult({ ...message, details: { retained: true } }, [
    assistant,
  ]);
  expect(result?.message).toStrictEqual({
    ...message,
    details: { retained: true },
    content: [{ type: "text", text: validationRecoveryReason({ error: "unexpected_sdk_tool" }) }],
  });
}

async function runContinuationRejection() {
  let executions = 0;
  const counts = { queries: 0 };
  const runner = continuationRunner(counts);
  const messages = await runAgentLoop(
    [{ role: "user", content: "Use probe", timestamp: 0 }],
    {
      messages: [],
      tools: [
        {
          name: "probe",
          label: "Probe",
          description: "Probe",
          parameters: Type.Object({}),
          async execute() {
            executions++;
            return { content: [], details: undefined };
          },
        },
      ],
    },
    {
      model: sonnet,
      convertToLlm: (history) =>
        history.filter(
          (message) =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult" ||
            message.role === "system",
        ),
    },
    () => undefined,
    undefined,
    (model, context, options) => createAgentSdkStream({ model, context, options, run: runner }),
  );
  expect(counts.queries).toBe(1);
  expect(executions).toBe(0);
  const failure = messages.findLast((message) => message.role === "assistant");
  expect(failure).toMatchObject({
    stopReason: "error",
    content: [],
    errorMessage: expect.stringContaining("Review completed work") as unknown,
  });
  assert(failure?.role === "assistant");
  expect(failure.errorMessage).not.toContain("malformed");
  expect(isRetryableAssistantError(failure)).toBe(false);
}

function sessionFile(manager: SessionManager): string {
  const file = manager.getSessionFile();
  assert(file !== undefined);
  return file;
}

describe("SDK recovery in the pinned Pi runtime", () => {
  test(
    "real AgentSession persists inactive-sentinel correction with zero rejected execution",
    runSessionRecovery,
  );
  test("uncorrelated and cancellation results remain unchanged", checkNegativeResults);
  test("internal continuation releases no tools and is not retryable", runContinuationRejection);
});

async function verifyPersistedRejection(
  manager: SessionManager,
  prompt: Parameters<RunSdkQuery>[0]["prompt"],
) {
  const reopened = SessionManager.open(sessionFile(manager));
  expect(reopened.getEntries()).toContainEqual(
    expect.objectContaining({
      type: "message",
      message: expect.objectContaining({
        role: "toolResult",
        toolName: VALIDATION_ERROR_TOOL,
        toolCallId: "bad",
        isError: true,
        content: [
          { type: "text", text: validationRecoveryReason({ error: "unexpected_sdk_tool" }) },
        ],
      }) as unknown,
    }),
  );
  const replay = await drain(sdkPromptFixture(prompt));
  expect(JSON.stringify(replay)).toContain("nothing executed (unexpected_sdk_tool)");
  expect(JSON.stringify(replay)).not.toContain(`Tool ${VALIDATION_ERROR_TOOL} not found`);
}

const rejectedMessage = {
  role: "toolResult" as const,
  toolName: VALIDATION_ERROR_TOOL,
  toolCallId: "bad",
  timestamp: 1,
  isError: true,
  content: [{ type: "text" as const, text: `Tool ${VALIDATION_ERROR_TOOL} not found` }],
};
const syntheticAssistant = {
  role: "assistant" as const,
  ...sonnet,
  api: "claude-sdk",
  provider: "claude-sdk",
  model: sonnet.id,
  timestamp: 1,
  stopReason: "toolUse" as const,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  content: [
    {
      type: "toolCall" as const,
      id: "bad",
      name: VALIDATION_ERROR_TOOL,
      arguments: { error: "unexpected_sdk_tool" },
    },
  ],
};

function continuationRunner(counts: { queries: number }) {
  return createClaudeAgentSdkRunner({
    claudeExecutable: "/usr/bin/claude",
    async *runSdkQuery(params) {
      counts.queries++;
      for (const id of ["one", "two"]) {
        yield streamEvent({ type: "message_start", message: { id, usage: { input_tokens: 1 } } });
      }
      await deliverToolUse(installedHook(params), {
        id: "effect",
        toolName: "mcp__pi__probe",
        input: {},
      });
      yield resultMessage({ terminal_reason: "tool_deferred" });
    },
  });
}

type Counts = { queries: number; executions: number; rejectedExecutions: number };
function recoveryRunner(manager: SessionManager, counts: Counts) {
  return createClaudeAgentSdkRunner({
    claudeExecutable: "/usr/bin/claude",
    validationRecovery: "pi-tool-loop",
    async *runSdkQuery(params) {
      counts.queries++;
      yield streamEvent({
        type: "message_start",
        message: { id: `query-${counts.queries}`, usage: { input_tokens: 1 } },
      });
      if (counts.queries === 1) {
        await deliverToolUse(installedHook(params), { id: "bad", toolName: "Bash", input: {} });
        yield resultMessage({ terminal_reason: "tool_deferred" });
      } else if (counts.queries === 2) {
        await verifyPersistedRejection(manager, params.prompt);
        await deliverToolUse(installedHook(params), {
          id: "corrected",
          toolName: "mcp__pi__probe",
          input: {},
        });
        yield resultMessage({ terminal_reason: "tool_deferred" });
      } else {
        assert(counts.queries === 3);
        yield textDelta("complete");
        yield resultMessage();
      }
    },
  });
}
function recoveryResources(
  dir: string,
  settingsManager: SettingsManager,
  runner: AgentSdkRun,
  counts: Counts,
) {
  return new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        registerRecoveryFixture(pi, runner, counts);
      },
    ],
  });
}
function registerRecoveryFixture(pi: ExtensionAPI, runner: AgentSdkRun, counts: Counts) {
  registerClaudeSdkProvider(pi);
  pi.registerTool({
    name: "probe",
    label: "Probe",
    description: "Pure probe",
    parameters: Type.Object({}),
    async execute() {
      counts.executions++;
      return { content: [{ type: "text", text: "ok" }], details: undefined };
    },
  });
  pi.registerTool({
    name: "Bash",
    label: "Rejected",
    description: "Must not execute",
    parameters: Type.Object({}),
    async execute() {
      counts.rejectedExecutions++;
      return { content: [], details: undefined };
    },
  });
  pi.registerProvider("claude-sdk", {
    api: "claude-sdk",
    apiKey: "offline",
    baseUrl: "offline://test",
    models: [{ ...sonnet }],
    streamSimple: (model, context, options) =>
      createAgentSdkStream({ model, context, options, run: runner }),
  });
}
