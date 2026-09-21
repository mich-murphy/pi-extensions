import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DeferredCall } from "../bridge";
import { InvalidDeferredCallError, InvalidDeferredCallLimitError } from "./errors";

const MAX_INVALID_PI_CALLS = 3;

const PI_CALL_INPUT_SCHEMA = {
  name: z
    .string()
    .describe(
      'Exact Pi tool name from the available-tools catalog; never "pi_call" itself, which is this gateway\'s own name',
    ),
  arguments: z
    .record(z.string(), z.unknown())
    .describe("Arguments matching that Pi tool's input schema"),
};

// The hook sees raw model output, so each field is parsed leniently to explain what was wrong.
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
  // Every level has a fallback, so this parse cannot fail.
  const requested = requestedCallSchema.parse(input);
  if (availableTools.has(requested.name) && requested.arguments) {
    return { name: requested.name, arguments: requested.arguments };
  }
  const sample = [...availableTools].slice(0, 5).join(", ");
  const tools = sample || "(no Pi tools are available this turn)";
  const name = requested.name || "<missing>";
  let reason: string;
  if (requested.name === "pi_call") {
    reason = `"pi_call" is this gateway's own name, not a Pi tool; do not pass it as the "name" field. Pass the target Pi tool's name instead, e.g. ${tools}.`;
  } else if (!requested.arguments) {
    reason = `"arguments" must be an object matching "${name}"'s input schema.`;
  } else {
    reason = `"${name}" is not a recognized Pi tool. Available tools: ${tools}.`;
  }
  return new InvalidDeferredCallError(requested.name, `Invalid Pi tool call: ${reason}`);
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
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
 * @returns The SDK MCP tool definition.
 */
export function createDeferredPiCallTool(description: string) {
  return tool("pi_call", description, PI_CALL_INPUT_SCHEMA, DEFERRED_PI_CALL_HANDLER);
}

/** One turn's record of the Pi tool calls the model requested through the gateway. */
export interface DeferredCallCapture {
  /** SDK `PreToolUse` callback that defers valid gateway calls and denies everything else. */
  readonly hook: HookCallback;
  /** Set once the model exceeded the invalid-call limit; the turn must fail with it. */
  readonly limitError: InvalidDeferredCallLimitError | undefined;
  /** Valid calls in arrival order, deduplicated by tool-use id. */
  readonly calls: ReadonlyArray<DeferredCall>;
}

/**
 * Create the per-turn capture behind the `pi_call` gateway.
 *
 * A denied invalid call does not end the SDK query, so the model can correct
 * itself within the turn. The capture tolerates three invalid calls and reports
 * the fourth through `onLimitExceeded`.
 *
 * @param availableTools - Pi tool names available during this turn.
 * @param onLimitExceeded - Receives the limit error exactly when it first trips.
 * @returns The hook to install plus the calls it captures.
 */
export function createDeferredCallCapture(
  availableTools: ReadonlySet<string>,
  onLimitExceeded: (error: InvalidDeferredCallLimitError) => void,
): DeferredCallCapture {
  const calls = new Map<string, DeferredCall>();
  let invalidCalls = 0;
  let limitError: InvalidDeferredCallLimitError | undefined;

  const hook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (input.tool_name !== "mcp__pi__pi_call") {
      return deny(`Only the Pi deferred-tool gateway is available, not ${input.tool_name}.`);
    }
    const parsed = parseDeferredCall(availableTools, input.tool_input);
    if (parsed instanceof InvalidDeferredCallError) {
      invalidCalls += 1;
      if (invalidCalls > MAX_INVALID_PI_CALLS && !limitError) {
        limitError = new InvalidDeferredCallLimitError(invalidCalls, parsed);
        onLimitExceeded(limitError);
      }
      return deny(parsed.message);
    }
    if (!calls.has(input.tool_use_id))
      calls.set(input.tool_use_id, { id: input.tool_use_id, ...parsed });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } };
  };

  return {
    hook,
    get limitError() {
      return limitError;
    },
    get calls() {
      return [...calls.values()];
    },
  };
}
