import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { DeferredCall } from "../bridge";
import { VALIDATION_ERROR_TOOL } from "../validation-recovery";
import type { CatalogTool } from "./tool-catalog";

const DEFERRED_PI_CALL_HANDLER = async () => ({
  content: [
    {
      type: "text" as const,
      text: "Pi's PreToolUse defer decision was not honored by the Claude Agent SDK; this tool call did not run and was not forwarded to Pi.",
    },
  ],
  isError: true,
});

export function createDeferredPiTools(catalog: readonly CatalogTool[], onFallback?: () => void) {
  return catalog.map(({ declaration, mcpName, schema }) => ({
    name: mcpName,
    description:
      mcpName === declaration.name
        ? declaration.description
        : `Pi tool ${JSON.stringify(declaration.name)}. ${declaration.description}`,
    inputSchema: schema,
    handler: async () => {
      onFallback?.();
      return DEFERRED_PI_CALL_HANDLER();
    },
  }));
}

/** One turn's tool handoff. Rejections target the reserved Pi-owned error tool.
 * Its guard/throw path persists an isError result and continues Pi's outer loop.
 * No invalid input is ever replaced by executable arguments for a real tool.
 */
export type DeferredCallCapture = {
  readonly hook: HookCallback;
  readonly batchHook: HookCallback;
  readonly batchStopped: boolean;

  readonly calls: readonly DeferredCall[];
  readonly hookDeniedCalls: number;
  readonly invalidGatewayCalls: number;
  readonly unexpectedToolCalls: number;
  readonly uncapturedBatchCalls: number;
  readonly sdkRejectedCalls: number;
};

/** Capture valid and invalid calls without asking the SDK model to recover.
 * PostToolBatch is the official boundary after *all* tools resolve and before
 * the next model request, including validation failures that skip PreToolUse.
 * Its continue:false output stops the SDK loop; only a clean terminal result
 * can authorize the handoff. Tool-result prose is never inspected.
 */
export function createDeferredCallCapture(catalog: readonly CatalogTool[]): DeferredCallCapture {
  const calls = new Map<string, DeferredCall>();
  let invalidCalls = 0;
  let unexpectedToolCalls = 0;
  let batchStopped = false;
  let lifecycleCalls = 0;
  let sdkRejectedCalls = 0;

  const capture = (id: string, toolName: string, input: unknown, preToolUse: boolean): void => {
    if (calls.has(id)) {
      return;
    }
    const selected = catalog.find((entry) => entry.sdkName === toolName);
    let reason:
      | "unexpected_sdk_tool"
      | "invalid_tool_input"
      | "uncaptured_tool_batch"
      | "sdk_input_rejected" = "unexpected_sdk_tool";
    if (selected) {
      reason = "invalid_tool_input";
      try {
        if (typeof input === "object" && input !== null && !Array.isArray(input)) {
          const args = z.record(z.string(), z.json()).parse(
            validateToolArguments(selected.declaration, {
              type: "toolCall",
              id,
              name: selected.declaration.name,
              arguments: z.record(z.string(), z.json()).parse(input),
            }),
          );
          selected.schema.parse(args);
          if (preToolUse) {
            calls.set(id, { id, name: selected.declaration.name, arguments: args });
            return;
          }
          reason = "uncaptured_tool_batch";
        }
      } catch {
        reason = "invalid_tool_input";
      }
      if (reason === "uncaptured_tool_batch") {
        lifecycleCalls += 1;
      } else if (preToolUse) {
        invalidCalls += 1;
      } else {
        reason = "sdk_input_rejected";
        sdkRejectedCalls += 1;
      }
    } else {
      unexpectedToolCalls += 1;
    }
    calls.set(id, { id, name: VALIDATION_ERROR_TOOL, arguments: { error: reason } });
  };

  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    capture(input.tool_use_id, input.tool_name, input.tool_input, true);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } };
  };
  const batchHook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolBatch") {
      return {};
    }
    // Keep PreToolUse arrival order and append uncaptured entries in batch order.
    // A batch entry is evidence of resolution, NEVER permission deferral: even
    // structurally valid input must not become an executable real call here.
    for (const call of input.tool_calls) {
      capture(call.tool_use_id, call.tool_name, call.tool_input, false);
    }
    batchStopped = true;
    return { continue: false, stopReason: "Pi owns tool execution and validation recovery." };
  };
  return {
    hook,
    batchHook,
    get batchStopped() {
      return batchStopped;
    },
    get calls() {
      return [...calls.values()];
    },
    hookDeniedCalls: 0,
    get sdkRejectedCalls() {
      return sdkRejectedCalls;
    },
    get uncapturedBatchCalls() {
      return lifecycleCalls;
    },
    get invalidGatewayCalls() {
      return invalidCalls;
    },
    get unexpectedToolCalls() {
      return unexpectedToolCalls;
    },
  };
}
