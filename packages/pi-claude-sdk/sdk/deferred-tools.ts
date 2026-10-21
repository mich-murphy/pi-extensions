import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DeferredCall } from "../bridge";
import { VALIDATION_ERROR_TOOL } from "../validation-recovery";
import { InvalidDeferredCallError } from "./errors";

const PI_CALL_INPUT_SCHEMA = {
  name: z
    .string()
    .describe(
      'Exact Pi tool name from the available-tools catalog; never "pi_call" itself, which is this gateway\'s own name',
    ),
  arguments: z
    .record(z.string(), z.json())
    .describe("Arguments matching that Pi tool's input schema"),
};

const requestedCallSchema = z
  .object({
    name: z.string().catch(""),
    arguments: PI_CALL_INPUT_SCHEMA.arguments.optional().catch(undefined),
  })
  .catch({ name: "", arguments: undefined });

function parseDeferredCall(
  availableTools: ReadonlySet<string>,
  input: unknown,
): Omit<DeferredCall, "id"> | InvalidDeferredCallError {
  const requested = requestedCallSchema.parse(input);
  if (
    requested.name !== VALIDATION_ERROR_TOOL &&
    availableTools.has(requested.name) &&
    requested.arguments
  ) {
    return { name: requested.name, arguments: requested.arguments };
  }
  const sample = [...availableTools].slice(0, 5).join(", ");
  const tools = sample || "(no Pi tools are available this turn)";
  const name = requested.name || "<missing>";
  let reason: string;
  if (requested.name === "pi_call") {
    reason = `"pi_call" is this gateway's own name, not a Pi tool; do not pass it as the "name" field. Pass the target Pi tool's name instead, e.g. ${tools}.`;
  } else if (requested.arguments) {
    reason = `"${name}" is not a recognized Pi tool. Available tools: ${tools}.`;
  } else {
    reason = `"arguments" must be an object matching "${name}"'s input schema.`;
  }
  return new InvalidDeferredCallError({
    requestedName: requested.name,
    reason: `Invalid Pi tool call: ${reason}`,
  });
}

const DEFERRED_PI_CALL_HANDLER = async () => ({
  content: [
    {
      type: "text" as const,
      text: "Pi's PreToolUse defer decision was not honored by the Claude Agent SDK; this tool call did not run and was not forwarded to Pi.",
    },
  ],
  isError: true,
});

/**
 * Create the in-process MCP gateway exposed to the Claude Agent SDK.
 *
 * @param description - Per-turn Pi tool catalog included in the gateway description.
 * @param onFallback - Stops the query if the SDK fails to honor permission deferral.
 * @returns The SDK MCP tool definition.
 */
export function createDeferredPiCallTool(description: string, onFallback?: () => void) {
  return tool("pi_call", description, PI_CALL_INPUT_SCHEMA, async () => {
    onFallback?.();
    return DEFERRED_PI_CALL_HANDLER();
  });
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
};

/** Capture valid and invalid calls without asking the SDK model to recover.
 * PostToolBatch is the official boundary after *all* tools resolve and before
 * the next model request, including validation failures that skip PreToolUse.
 * Its continue:false output stops the SDK loop; only a clean terminal result
 * can authorize the handoff. Tool-result prose is never inspected.
 */
export function createDeferredCallCapture(
  availableTools: ReadonlySet<string>,
): DeferredCallCapture {
  const calls = new Map<string, DeferredCall>();
  let invalidCalls = 0;
  let unexpectedToolCalls = 0;
  let batchStopped = false;

  const capture = (id: string, toolName: string, input: unknown, preToolUse: boolean): void => {
    if (calls.has(id)) {
      return;
    }
    const parsed =
      toolName === "mcp__pi__pi_call" ? parseDeferredCall(availableTools, input) : undefined;
    if (preToolUse && parsed && !(parsed instanceof InvalidDeferredCallError)) {
      calls.set(id, { id, ...parsed });
      return;
    }
    if (parsed) {
      invalidCalls += 1;
    } else {
      unexpectedToolCalls += 1;
    }
    calls.set(id, {
      id,
      name: VALIDATION_ERROR_TOOL,
      arguments: {
        error: parsed ? "invalid_gateway_input" : "unexpected_sdk_tool",
      },
    });
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
    get invalidGatewayCalls() {
      return invalidCalls;
    },
    get unexpectedToolCalls() {
      return unexpectedToolCalls;
    },
  };
}
