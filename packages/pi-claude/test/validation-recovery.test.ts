import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, PostToolBatchHookInput } from "@anthropic-ai/claude-agent-sdk";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import { assert, describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import { createAgentSdkStream } from "../bridge";
import type { CacheDiagnostic } from "../cache-tracker";
import { createCacheDiagnosticTracker } from "../cache-tracker";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { RunSdkQuery } from "../sdk/runner";
import {
  blockValidationRecovery,
  VALIDATION_ERROR_TOOL,
  validationRecoveryReason,
} from "../validation-recovery";
import {
  contextFixture,
  deliverToolUse,
  drain,
  installedHook,
  requestFixture,
  resultMessage,
  sonnet,
  textDelta,
  streamEvent,
} from "./fixtures";

async function postBatch(
  params: Parameters<RunSdkQuery>[0],
  input: unknown,
  id = "bad",
  name = "read",
) {
  const hook: HookCallback | undefined = params.options?.hooks?.PostToolBatch?.[0]?.hooks?.[0];
  assert(hook);
  const event: PostToolBatchHookInput = {
    session_id: "offline",
    transcript_path: "/dev/null",
    cwd: "/",
    hook_event_name: "PostToolBatch",
    tool_calls: [{ tool_name: `mcp__pi__${name}`, tool_use_id: id, tool_input: input }],
  };
  return hook(event, undefined, { signal: new AbortController().signal });
}

function rejectionToolName(path: string): string {
  return path === "unhooked-valid" ? "dangerous" : "read";
}

async function* rejectedTurn(params: Parameters<RunSdkQuery>[0], path: string): AsyncGenerator {
  // Deterministic SDK boundary simulation, NOT evidence of the real CLI's
  // malformed-JSON path. Public PostToolBatch supplies tool_input: unknown.
  let input: unknown = {};
  if (path === "pre-hook-validation") {
    input = "unparseable input";
  }
  if (path === "unhooked-valid") {
    await deliverToolUse(installedHook(params), {
      id: "sibling",
      input: { name: "read", arguments: { path: "fixture" } },
    });
  }
  yield {
    type: "assistant",
    message: {
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 10, output_tokens: 2 },
      content: [
        {
          type: "tool_use",
          id: "bad",
          name: `mcp__pi__${rejectionToolName(path)}`,
          input,
        },
      ],
    },
  };
  if (path === "missing-arguments") {
    const decision = await deliverToolUse(installedHook(params), {
      id: "bad",
      toolName: "mcp__pi__read",
      input,
    });
    assert.deepEqual(decision, {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" },
    });
  }
  if (path === "pre-hook-validation") {
    yield {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "bad",
            is_error: true,
            content: "untrusted SDK error text is not used for control",
          },
        ],
      },
    };
  }
  const stopped = await postBatch(params, input, "bad", rejectionToolName(path));
  expect(stopped).toMatchObject({ continue: false });
  // A cooperative SDK must stop here rather than perform another model round.
  yield resultMessage({
    terminal_reason: "hook_stopped",
    stop_reason: "tool_use",
    num_turns: path === "pre-hook-validation" ? 2 : 1,
    usage: { input_tokens: 10, output_tokens: 2 },
  });
}

type BatchStopEnding = "failed-result" | "missing-result" | "rejection";

/** How the SDK ends after the host stopped the batch: an error result, nothing, or a throw. */
async function* afterBatchStop(
  ending: BatchStopEnding,
): AsyncGenerator<ReturnType<typeof resultMessage>> {
  if (ending === "failed-result") {
    yield resultMessage({ is_error: true });
  }
  if (ending === "rejection") {
    throw new Error("private");
  }
}

type RecoveryPath = "missing-arguments" | "pre-hook-validation" | "unhooked-valid";

const RECOVERY_SCENARIOS: readonly { readonly path: RecoveryPath; readonly inactive: boolean }[] = [
  { path: "missing-arguments", inactive: false },
  { path: "pre-hook-validation", inactive: false },
  { path: "unhooked-valid", inactive: false },
  { path: "missing-arguments", inactive: true },
];

const REJECTION_KIND: Readonly<Record<RecoveryPath, string>> = {
  "missing-arguments": "invalid_tool_input",
  "pre-hook-validation": "sdk_input_rejected",
  "unhooked-valid": "uncaptured_tool_batch",
};

/** Real `read` executions: the corrected call, plus the unhooked sibling on that path. */
const READ_EXECUTIONS: Readonly<Record<RecoveryPath, number>> = {
  "missing-arguments": 1,
  "pre-hook-validation": 1,
  "unhooked-valid": 2,
};

const PI_MESSAGE_ROLES: ReadonlySet<string> = new Set([
  "system",
  "user",
  "assistant",
  "toolResult",
]);

function isPiMessage(message: AgentMessage): message is Message {
  return PI_MESSAGE_ROLES.has(message.role);
}

function recordTo(session: SessionManager): (event: AgentEvent) => void {
  return (event) => {
    if (event.type === "message_end" && isPiMessage(event.message)) {
      session.appendMessage(event.message);
    }
  };
}

const isQueryRecord = (record: CacheDiagnostic): boolean =>
  record.type === "usage" || record.type === "query";

const isBadResult = (message: AgentMessage): boolean =>
  message.role === "toolResult" && message.toolCallId === "bad";

function rejectionText(rejectionKind: string, inactive: boolean): string {
  return inactive
    ? `Tool ${VALIDATION_ERROR_TOOL} not found`
    : validationRecoveryReason({ error: rejectionKind });
}

/** Drive Pi's real outer loop and SessionManager through a rejected call and its correction. */
async function runRecoveryScenario(path: RecoveryPath, inactive: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "pi-sdk-offline-recovery-"));
  try {
    const session = SessionManager.create(dir, dir);
    let queries = 0;
    let executions = 0;
    let replacementExecutions = 0;
    let dangerousExecutions = 0;
    const records: CacheDiagnostic[] = [];
    const runner = createClaudeAgentSdkRunner({
      claudeExecutable: "/usr/bin/claude",
      cacheDiagnostics: Effect.runSync(
        createCacheDiagnosticTracker((record) => records.push(record)),
      ),
      validationRecovery: "pi-tool-loop",
      async *runSdkQuery(params) {
        queries += 1;
        yield streamEvent({
          type: "message_start",
          message: {
            id: `offline-model-${queries}`,
            model: "claude-sonnet-5-5",
            usage: { input_tokens: 10 },
          },
        });
        if (queries === 1) {
          yield* rejectedTurn(params, path);
        } else if (queries === 2) {
          await deliverToolUse(installedHook(params), {
            id: "corrected",
            input: { name: "read", arguments: { path: "fixture" } },
          });
          yield resultMessage({ terminal_reason: "tool_deferred", num_turns: 1 });
        } else {
          assert(queries === 3);
          yield textDelta("complete");
          yield resultMessage({ num_turns: 1 });
        }
      },
    });
    const tools: AgentTool[] = [
      {
        name: "dangerous",
        label: "Dangerous",
        description: "Must not execute",
        parameters: Type.Object({}),
        async execute() {
          dangerousExecutions += 1;
          return { content: [], details: undefined };
        },
      },
      {
        name: "read",
        label: "Read",
        description: "Read fixture",
        parameters: Type.Object({ path: Type.String() }),
        async execute(_id, args) {
          expect(args).toStrictEqual({ path: "fixture" });
          executions += 1;
          return { content: [{ type: "text", text: "fixture" }], details: undefined };
        },
      },
      {
        // Even a late/colliding executable using the reserved name cannot run.
        name: VALIDATION_ERROR_TOOL,
        label: "Collision",
        description: "Must never execute",
        parameters: Type.Object({ error: Type.String() }),
        async execute() {
          replacementExecutions += 1;
          return { content: [], details: undefined };
        },
      },
    ];
    const messages = await runAgentLoop(
      [{ role: "user", content: "Read fixture", timestamp: 0 }],
      {
        messages: [],
        tools: inactive ? tools.filter((tool) => tool.name !== VALIDATION_ERROR_TOOL) : tools,
      },
      {
        model: sonnet,
        convertToLlm: (history) => history.filter((message) => isPiMessage(message)),
        beforeToolCall: async ({ toolCall, args }) => blockValidationRecovery(toolCall.name, args),
      },
      recordTo(session),
      undefined,
      (model, context, options) => createAgentSdkStream({ model, context, options, run: runner }),
    );
    const file = session.getSessionFile();
    assert(file !== undefined);
    const persisted = SessionManager.open(file)
      .getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    return {
      queries,
      executions,
      dangerousExecutions,
      replacementExecutions,
      records,
      messages,
      persisted,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Pi-owned validation recovery", () => {
  test.each(RECOVERY_SCENARIOS)(
    "real Pi outer loop persists $path rejection and correction (inactive=$inactive)",
    async ({ path, inactive }) => {
      const run = await runRecoveryScenario(path, inactive);
      const rejectionKind = REJECTION_KIND[path];
      expect(run.queries).toBe(3);
      expect(run.executions).toBe(READ_EXECUTIONS[path]);
      expect(run.dangerousExecutions).toBe(0);
      expect(run.replacementExecutions).toBe(0);
      const queryRecords = run.records.filter(isQueryRecord);
      expect(queryRecords).toHaveLength(3);
      for (const record of queryRecords) {
        expect(record).toMatchObject({ query: { modelRequests: 1 } });
      }
      const rejection = run.messages.find((message) => isBadResult(message));
      expect(rejection).toMatchObject({
        role: "toolResult",
        isError: true,
        content: [{ type: "text", text: rejectionText(rejectionKind, inactive) }],
      });
      expect(run.persisted).toContainEqual(rejection);
      expect(run.persisted).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            {
              type: "toolCall",
              id: "bad",
              name: VALIDATION_ERROR_TOOL,
              arguments: { error: rejectionKind },
            },
          ]) as unknown,
        }),
      );
      expect(run.persisted).toContainEqual(
        expect.objectContaining({ role: "toolResult", toolCallId: "corrected", isError: false }),
      );
    },
  );

  test("programmatic runner fails closed without explicit protected Pi tool-loop integration", async () => {
    const runner = createClaudeAgentSdkRunner({
      claudeExecutable: "/usr/bin/claude",
      async *runSdkQuery(params) {
        await deliverToolUse(installedHook(params), { id: "bad", input: { name: "read" } });
        yield resultMessage({ terminal_reason: "tool_deferred" });
      },
    });
    await expect(drain(runner(requestFixture(), sonnet))).resolves.toMatchObject([
      { type: "failed", error: { category: "tool-contract" } },
    ]);
  });

  test.each(["failed-result", "missing-result", "rejection"] as const)(
    "host batch stop cannot release calls on %s",
    async (ending) => {
      const runner = createClaudeAgentSdkRunner({
        claudeExecutable: "/usr/bin/claude",
        validationRecovery: "pi-tool-loop",
        async *runSdkQuery(params) {
          await postBatch(params, { name: "read" });
          yield* afterBatchStop(ending);
        },
      });
      await expect(drain(runner(requestFixture(), sonnet))).resolves.toMatchObject([
        { type: "failed" },
      ]);
    },
  );
  test.each([
    { terminal_reason: "completed", stop_reason: "end_turn" },
    { terminal_reason: "hook_stopped", stop_reason: "max_tokens" },
    { terminal_reason: "hook_stopped", stop_reason: "model_context_window_exceeded" },
    { terminal_reason: "unknown", stop_reason: "end_turn" },
    { terminal_reason: undefined, stop_reason: "end_turn" },
    { terminal_reason: "hook_stopped", is_error: true },
  ])("batch marker cannot authorize unrelated terminal shape %j", async (ending) => {
    const runner = createClaudeAgentSdkRunner({
      claudeExecutable: "/usr/bin/claude",
      validationRecovery: "pi-tool-loop",
      async *runSdkQuery(params) {
        await deliverToolUse(installedHook(params), {
          id: "real",
          input: { name: "read", arguments: {} },
        });
        await postBatch(params, { name: "read", arguments: {} }, "real");
        yield resultMessage(ending);
      },
    });
    await expect(drain(runner(requestFixture(), sonnet))).resolves.toMatchObject([
      { type: "failed" },
    ]);
  });

  test.each(["hook_stopped", "completed", undefined])(
    "empty stopped batch fails closed (%s)",
    async (terminalReason) => {
      const runner = createClaudeAgentSdkRunner({
        claudeExecutable: "/usr/bin/claude",
        validationRecovery: "pi-tool-loop",
        async *runSdkQuery(params) {
          const hook = params.options?.hooks?.PostToolBatch?.[0]?.hooks?.[0];
          assert(hook);
          await hook(
            {
              session_id: "offline",
              transcript_path: "/dev/null",
              cwd: "/",
              hook_event_name: "PostToolBatch",
              tool_calls: [],
            },
            undefined,
            { signal: new AbortController().signal },
          );
          yield resultMessage({ terminal_reason: terminalReason });
        },
      });
      await expect(drain(runner(requestFixture(), sonnet))).resolves.toMatchObject([
        { type: "failed" },
      ]);
    },
  );

  test("hook_stopped without our batch marker cannot release real calls", async () => {
    const runner = createClaudeAgentSdkRunner({
      claudeExecutable: "/usr/bin/claude",
      async *runSdkQuery(params) {
        await deliverToolUse(installedHook(params), {
          id: "real",
          input: { name: "read", arguments: {} },
        });
        yield resultMessage({
          terminal_reason: "hook_stopped",
          stop_reason: "tool_use",
          num_turns: 2,
        });
      },
    });
    await expect(drain(runner(requestFixture(), sonnet))).resolves.toMatchObject([
      { type: "failed" },
    ]);
  });

  test("helper never appears in SDK catalog/allowlist even when present in the transcript", () => {
    const request = buildAgentRequest(
      contextFixture({
        messages: [],
        tools: [
          {
            name: VALIDATION_ERROR_TOOL,
            description: "private bridge helper",
            parameters: Type.Object({}),
          },
          { name: "read", description: "Read", parameters: Type.Object({}) },
        ],
      }),
    );
    expect([...request.toolNames]).toStrictEqual(["read"]);
    expect(request.toolDescription).not.toContain(VALIDATION_ERROR_TOOL);
    expect(request.toolDescription).not.toContain("private bridge helper");
  });

  test("message_start request counts deduplicate IDs and do not equate internal results with requests", async () => {
    const records: CacheDiagnostic[] = [];
    const runner = createClaudeAgentSdkRunner({
      claudeExecutable: "/usr/bin/claude",
      cacheDiagnostics: Effect.runSync(
        createCacheDiagnosticTracker((record) => records.push(record)),
      ),
      async *runSdkQuery() {
        const started = streamEvent({
          type: "message_start",
          message: { id: "private-message-id", usage: { input_tokens: 10 } },
        });
        yield started;
        yield started;
        yield { type: "user", message: { content: [{ type: "tool_result", is_error: true }] } };
        yield resultMessage({ num_turns: 2, usage: { input_tokens: 10 } });
      },
    });
    await expect(drain(runner(requestFixture(), sonnet))).resolves.toContainEqual({
      type: "done",
      reason: "stop",
    });
    expect(records.at(-1)).toMatchObject({ query: { modelRequests: 1, numTurns: 2 } });
    expect(JSON.stringify(records)).not.toContain("private-message-id");
  });
});
