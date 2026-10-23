/* oxlint-disable typescript/no-unsafe-type-assertion -- trusted same-checkout snapshot modules and role-checked persisted messages */
// LIVE, allowance-gated by verify.py. No raw SDK events, prompts, IDs or error prose logged.
// Uses real Pi runAgentLoop + disk SessionManager and production snapshot runner/bridge.
// Live missing-arguments changes public PreToolUse input once. Offline-parser uses
// synthetic SSE but the ACTUAL SDK/CLI parser, under empty HOME and dummy auth.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Message, Model, Api } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type * as BridgeModule from "../../../../packages/pi-claude-sdk/bridge";
import type { CacheDiagnostic } from "../../../../packages/pi-claude-sdk/cache-tracker";
import type * as TrackerModule from "../../../../packages/pi-claude-sdk/cache-tracker";
import type * as ModelsModule from "../../../../packages/pi-claude-sdk/models";
import type * as FailureModule from "../../../../packages/pi-claude-sdk/sdk/result-failure";
import type { RunSdkQuery } from "../../../../packages/pi-claude-sdk/sdk/runner";
import type * as RunnerModule from "../../../../packages/pi-claude-sdk/sdk/runner";
import type * as RecoveryModule from "../../../../packages/pi-claude-sdk/validation-recovery";
import { DUMMY_PARSER_KEY, startParserTransport } from "./parser-transport";

const { values } = parseArgs({
  options: {
    package: { type: "string" },
    work: { type: "string" },
    case: { type: "string", default: "missing-arguments" },
    "review-approved": { type: "boolean", default: false },
  },
});
const offline = values.case === "offline-parser";
assert(offline || values["review-approved"], "review approval required");
assert(
  values.package !== undefined && values.work !== undefined,
  "snapshot package and owned work required",
);
assert(["missing-arguments", "offline-parser"].includes(values.case));
const packageDir = path.resolve(values.package);
const work = path.resolve(values.work);
assert(
  work.startsWith("/tmp/pi-claude-sdk-state-") ||
    work.startsWith("/private/tmp/pi-claude-sdk-state-"),
);
const load = async (file: string): Promise<unknown> =>
  import(pathToFileURL(path.join(packageDir, file)).href);
const { createClaudeAgentSdkRunner } = (await load("sdk/runner.ts")) as typeof RunnerModule;
const { createAgentSdkStream } = (await load("bridge.ts")) as typeof BridgeModule;
const { createCacheDiagnosticTracker } = (await load("cache-tracker.ts")) as typeof TrackerModule;
const { models } = (await load("models.ts")) as typeof ModelsModule;
const { validationRecoveryTool, blockValidationRecovery, VALIDATION_ERROR_TOOL } = (await load(
  "validation-recovery.ts",
)) as typeof RecoveryModule;
const { safeTerminalReason } = (await load("sdk/result-failure.ts")) as typeof FailureModule;
const entry = models.find((candidate) => candidate.id === "claude-4.5-haiku");
assert(entry);
const model = {
  ...entry,
  api: "claude-sdk",
  provider: "claude-sdk",
  baseUrl: "agent-sdk://local-claude-code",
} as unknown as Model<Api>;
const reports: Record<string, unknown>[] = [];
let transport: Awaited<ReturnType<typeof startParserTransport>> | undefined;
if (offline) {
  assert(process.env.PI_CLAUDE_SDK_OFFLINE_PARSER === "1");
  assert(process.env.HOME === path.join(work, "home"));
  assert(process.env.ANTHROPIC_API_KEY === DUMMY_PARSER_KEY);
  assert(process.env.ANTHROPIC_AUTH_TOKEN === undefined);
  transport = await startParserTransport();
}

async function journey() {
  const kind = offline ? "offline-parser" : "missing-arguments";
  const dir = path.join(work, kind);
  await mkdir(dir, { recursive: false, mode: 0o700 });
  const session = SessionManager.create(dir, dir);
  let queries = 0;
  let executions = 0;
  let injected = 0;
  let durableBeforeCorrection = false;
  const records: CacheDiagnostic[] = [];
  const queryReports: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    case: kind,
    faultInjected: !offline,
    transport: offline ? "offline-synthetic-messages-sse-real-sdk-cli" : "live-subscription",
    queryReports,
  };
  reports.push(report);
  const persisted = () => {
    const file = session.getSessionFile();
    return file === undefined
      ? []
      : SessionManager.open(file)
          .getEntries()
          .flatMap((e) => (e.type === "message" ? [e.message] : []));
  };
  function hasError() {
    return persisted().some(
      (m) => m.role === "toolResult" && m.toolName === VALIDATION_ERROR_TOOL && m.isError,
    );
  }
  const runSdkQuery: RunSdkQuery = observeQuery;
  async function* observeQuery(params: Parameters<RunSdkQuery>[0]): AsyncGenerator {
    queries += 1;
    assert(queries <= 3, "outer query budget exceeded");
    if (queries === 2) {
      durableBeforeCorrection = hasError();
      assert(durableBeforeCorrection, "no durable Pi error before correction query");
      assert(executions === 0, "invalid input executed");
    }
    const first = queries === 1;
    const seen = new Set<string>();
    let batches = 0;
    let unhooked = 0;
    let errorResults = 0;
    let jsonParseErrors = 0;
    let terminal: Record<string, unknown> | undefined;
    const pre = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
    const batch = params.options?.hooks?.PostToolBatch?.[0]?.hooks?.[0];
    assert(pre && batch);
    const preHook: HookCallback = async (input, id, options) => {
      if (input.hook_event_name === "PreToolUse") {
        seen.add(input.tool_use_id);
        if (!offline && first && injected === 0 && input.tool_name === "mcp__pi__contract_probe") {
          injected += 1;
          return pre({ ...input, tool_input: {} }, id, options);
        }
      }
      return pre(input, id, options);
    };
    const batchHook: HookCallback = async (input, id, options) => {
      if (input.hook_event_name === "PostToolBatch") {
        batches += 1;
        unhooked += input.tool_calls.filter((call) => !seen.has(call.tool_use_id)).length;
      }
      return batch(input, id, options);
    };
    const summary = {
      query: queries,
      outputCeiling: 2048,
    };
    queryReports.push(summary);
    try {
      for await (const message of query({
        ...params,
        options: {
          ...params.options,
          // Normal bounded ceiling for tiny requests, NOT forced truncation/fault injection.
          thinking: { type: "disabled" },
          env: {
            ...params.options?.env,
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(summary.outputCeiling),
          },
          hooks: { PreToolUse: [{ hooks: [preHook] }], PostToolBatch: [{ hooks: [batchHook] }] },
        },
      })) {
        if (message.type === "user") {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result" && block.is_error === true) {
                errorResults += 1;
                const text =
                  typeof block.content === "string" ? block.content : JSON.stringify(block.content);
                if (/JSON.*pars|pars.*JSON|invalid JSON/iu.test(text)) {
                  jsonParseErrors += 1;
                }
              }
            }
          }
        }
        if (message.type === "result") {
          const allowedStops = new Set([
            "end_turn",
            "tool_use",
            "tool_deferred",
            "max_tokens",
            "model_context_window_exceeded",
          ]);
          const mainPrompt =
            message.usage.input_tokens +
            message.usage.cache_read_input_tokens +
            message.usage.cache_creation_input_tokens;
          const modelEntries = Object.values(message.modelUsage);
          const modelPrompt = modelEntries.reduce(
            (sum, usage) =>
              sum + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
            0,
          );
          let stopReason = "absent";
          if (message.stop_reason !== null && message.stop_reason !== undefined) {
            stopReason = allowedStops.has(message.stop_reason) ? message.stop_reason : "other";
          }
          terminal = {
            mainPrompt,
            modelPrompt,
            modelCount: modelEntries.length,
            isError: message.is_error,
            terminalReason: safeTerminalReason(message.terminal_reason),
            stopReason,
            numTurns: message.num_turns,
          };
        }
        // Observe before yielding: the runner settles on result and starts bounded SDK
        // cleanup without waiting for this generator's finalizer to finish.
        Object.assign(summary, {
          batches,
          unhooked,
          errorResults,
          jsonParseErrors,
          preHooks: seen.size,
          terminal,
        });
        yield message; // Real SDK stream is NEVER mutated.
      }
    } finally {
      Object.assign(summary, {
        batches,
        unhooked,
        errorResults,
        jsonParseErrors,
        preHooks: seen.size,
        terminal,
      });
    }
  }
  const runner = createClaudeAgentSdkRunner({
    validationRecovery: "pi-tool-loop",
    runSdkQuery,
    ...(transport === undefined
      ? {}
      : {
          sdkEnvironment: {
            ...process.env,
            ANTHROPIC_BASE_URL: transport.baseUrl,
            ANTHROPIC_API_KEY: DUMMY_PARSER_KEY,
            ANTHROPIC_AUTH_TOKEN: undefined,
          },
        }),
    cacheDiagnostics: Effect.runSync(
      createCacheDiagnosticTracker((record) => records.push(record)),
    ),
  });
  const tools: AgentTool[] = [
    {
      name: "contract_probe",
      label: "Pure contract probe",
      description: "Pure verification tool; returns a fixed marker, never reads or writes files.",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, args) {
        assert(hasError(), "execution before durable rejection");
        assert(
          typeof args === "object" &&
            args !== null &&
            "value" in args &&
            args.value === "corrected",
          "unexpected probe argument",
        );
        executions += 1;
        assert(executions === 1, "duplicate execution");
        return { content: [{ type: "text", text: "RECOVERY_OK" }], details: undefined };
      },
    },
    {
      ...validationRecoveryTool,
      async execute() {
        throw new Error("reserved tool must be guarded");
      },
    },
  ];
  const prompt =
    "Invoke contract_probe with value corrected. If any tool error occurs, correct the call and invoke it again. After RECOVERY_OK reply exactly RECOVERY_OK.";
  try {
    const messages = await runAgentLoop(
      [{ role: "user", content: prompt, timestamp: 0 }],
      { messages: [], tools },
      {
        model,
        convertToLlm: (history) =>
          history.filter((m): m is Message =>
            ["system", "user", "assistant", "toolResult"].includes(m.role),
          ),
        beforeToolCall: async ({ toolCall, args }) => blockValidationRecovery(toolCall.name, args),
      },
      (event) => {
        if (
          event.type === "message_end" &&
          ["system", "user", "assistant", "toolResult"].includes(event.message.role)
        ) {
          session.appendMessage(event.message as Message);
        }
      },
      AbortSignal.timeout(180_000),
      (selected, context, options) =>
        createAgentSdkStream({ model: selected, context, options, run: runner }),
    );
    const diagnostics = records.flatMap((r) =>
      r.type === "usage" || r.type === "query" ? [r.query] : [],
    );
    // query summaries are production allowlisted diagnostics, not raw SDK/model names.
    report.diagnostics = diagnostics;
    report.executions = executions;
    report.durableBeforeCorrection = durableBeforeCorrection;
    report.injected = injected;
    const last = messages.at(-1);
    const failed = last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason);
    if (failed) {
      throw new Error("provider-turn-failed");
    }
    assert(
      queryReports.every((r) => {
        const terminal = r.terminal as Record<string, unknown> | undefined;
        return terminal?.modelCount === 1 && terminal.mainPrompt === terminal.modelPrompt;
      }),
      "query pipeline usage mismatch",
    );
    assert(
      diagnostics.length === queries && diagnostics.every((d) => d?.modelRequests === 1),
      "model request count mismatch",
    );
    assert(injected === (offline ? 0 : 1), "fault injection count mismatch");
    if (offline) {
      const first = queryReports[0];
      assert(
        first?.preHooks === 0 &&
          first.batches === 1 &&
          first.unhooked === 1 &&
          first.errorResults === 1 &&
          first.jsonParseErrors === 1,
        "real parser failure boundary unproved",
      );
      assert(
        transport?.summary().requests === 3 &&
          transport.summary().unexpected === 0 &&
          transport.summary().invalidJsonResponses === 1,
        "fixture request contract mismatch",
      );
    }
    assert(executions === 1 && durableBeforeCorrection && hasError(), "recovery incomplete");
    const history = persisted();
    assert(
      history.some(
        (m) =>
          m.role === "assistant" &&
          m.content.some((c) => c.type === "toolCall" && c.name === VALIDATION_ERROR_TOOL),
      ),
      "assistant rejection not durable",
    );
    assert(
      history.some((m) => m.role === "toolResult" && m.toolName === "contract_probe" && !m.isError),
      "correction result not durable",
    );
    assert(
      last?.role === "assistant" &&
        last.stopReason === "stop" &&
        last.content.some((c) => c.type === "text" && c.text.trim() === "RECOVERY_OK"),
      "no final marker",
    );
    report.status = "passed";
  } finally {
    report.queries = queries;
    report.executions = executions;
    report.durableBeforeCorrection = durableBeforeCorrection;
    report.injected = injected;
    report.diagnostics = records.flatMap((r) =>
      r.type === "usage" || r.type === "query" ? [r.query] : [],
    );
  }
}
let exit = 0;
try {
  await journey();
} catch {
  exit = 1;
  // Never echo even assertion messages/SDK exceptions: fixed vocabulary only.
  reports.push({ status: "failed", reason: "recovery-check-failed" });
} finally {
  if (transport !== undefined) {
    reports.push({
      transport: "offline-synthetic-messages-sse-real-sdk-cli",
      ...transport.summary(),
    });
    await transport.close();
  }
}
process.stdout.write(
  `${JSON.stringify({ probe: "pi-sdk-validation-recovery", status: exit === 0 ? "passed" : "failed", reports }, null, 2)}\n`,
);
process.exitCode = exit;
