import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import { Schema, SchemaGetter } from "effect";
import { z } from "zod";
import type { DeferredCall } from "../bridge";
import { VALIDATION_ERROR_TOOL } from "../validation-recovery";
import type { CatalogTool } from "./tool-catalog";

const DEFERRED_PI_CALL_HANDLER = async () => ({
  content: [
    {
      type: "text" as const,
      text: "The tool did not run: Claude Code did not pass this call to Pi.",
    },
  ],
  isError: true,
});

const MAX_PARAMETERS_CHARS = 4000;
const cleanToolArguments = z.record(z.string(), z.json());

const readToolArguments = Schema.decodeUnknownSync(
  Schema.JsonObject.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((input) => cleanToolArguments.parse(input)),
      encode: SchemaGetter.transform((input) => input),
    }),
  ),
);

type ToolInvocation = Pick<PreToolUseHookInput, "tool_use_id" | "tool_name" | "tool_input">;

function parametersLine(parameters: Tool["parameters"]): string {
  const json = JSON.stringify(parameters) ?? "{}";

  const bounded =
    json.length > MAX_PARAMETERS_CHARS
      ? `${json.slice(0, MAX_PARAMETERS_CHARS)}…[truncated]`
      : json;

  return `\nParameters (JSON Schema): ${bounded}`;
}

export function createDeferredPiTools(catalog: readonly CatalogTool[], onFallback?: () => void) {
  return catalog.map(({ declaration, mcpName, schema, degraded }) => ({
    name: mcpName,
    description:
      (mcpName === declaration.name
        ? declaration.description
        : `Pi tool ${JSON.stringify(declaration.name)}. ${declaration.description}`) +
      (degraded === true ? parametersLine(declaration.parameters) : ""),
    inputSchema: schema,
    handler: async () => {
      onFallback?.();

      return DEFERRED_PI_CALL_HANDLER();
    },
  }));
}

export type DeferredCallCapture = {
  readonly hook: HookCallback;
  readonly batchHook: HookCallback;
  readonly batchStopped: boolean;

  readonly calls: readonly DeferredCall[];
  readonly invalidGatewayCalls: number;
  readonly unexpectedToolCalls: number;
  readonly uncapturedBatchCalls: number;
  readonly sdkRejectedCalls: number;
};

export function createDeferredCallCapture(catalog: readonly CatalogTool[]): DeferredCallCapture {
  const calls = new Map<string, DeferredCall>();
  let invalidCalls = 0;
  let unexpectedToolCalls = 0;
  let batchStopped = false;
  let lifecycleCalls = 0;
  let sdkRejectedCalls = 0;

  const capture = (
    { tool_use_id: id, tool_name: toolName, tool_input: input }: ToolInvocation,
    preToolUse: boolean,
  ): void => {
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
        const args = readToolArguments(
          validateToolArguments(selected.declaration, {
            type: "toolCall",
            id,
            name: selected.declaration.name,
            arguments: readToolArguments(input),
          }),
        );

        selected.schema.parse(args);

        if (preToolUse) {
          calls.set(id, { id, name: selected.declaration.name, arguments: args });

          return;
        }

        reason = "uncaptured_tool_batch";
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

    capture(input, true);

    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } };
  };

  const batchHook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolBatch") {
      return {};
    }

    for (const call of input.tool_calls) {
      capture(call, false);
    }

    batchStopped = true;

    return { continue: false, stopReason: "Stopped so that Pi can run the requested tools." };
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
