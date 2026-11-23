import type {
  MessageEndEvent,
  MessageEndEventResult,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isClaudeProvider } from "./provider-id";

/** Reserved bridge operation. Never delegates to or executes another tool. */
export const VALIDATION_ERROR_TOOL = "pi_claude_sdk_validation_error";

/** Every bounded rejection reason; the single source for the schema and replay notes. */
export const VALIDATION_REASONS = [
  "invalid_tool_input",
  "unexpected_sdk_tool",
  "uncaptured_tool_batch",
  "sdk_input_rejected",
  "printed_tool_call",
] as const;

/** Value-free, bounded correction text shared by the tool and its fail-safe guard. */
export function validationRecoveryReason(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "error" in input &&
    input.error === "uncaptured_tool_batch"
  ) {
    return "The tool did not run: Claude Code handled the call without passing it to Pi. Call the declared mcp__pi__ tool again.";
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "error" in input &&
    input.error === "sdk_input_rejected"
  ) {
    return "The tool did not run: Claude Code rejected its input, possibly as invalid JSON. Call a declared mcp__pi__ tool again with valid JSON that matches its schema.";
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "error" in input &&
    input.error === "printed_tool_call"
  ) {
    return "Your last reply printed a tool call as text, so nothing ran. Call the declared mcp__pi__ tool directly instead of writing a <call> tag or JSON.";
  }
  const unexpected =
    typeof input === "object" &&
    input !== null &&
    "error" in input &&
    input.error === "unexpected_sdk_tool";
  return unexpected
    ? "That tool is not available, so it did not run. Call only a declared mcp__pi__ tool, with parameters that match its schema."
    : `The tool did not run: its parameters do not match its schema. Call the declared mcp__pi__ tool again with valid parameters. Do not call ${VALIDATION_ERROR_TOOL}.`;
}

/** Blocks even a later replacement of the reserved tool before its executor runs. */
export function blockValidationRecovery(
  toolName: string,
  input: unknown,
): ToolCallEventResult | undefined {
  return toolName === VALIDATION_ERROR_TOOL
    ? { block: true, reason: validationRecoveryReason(input) }
    : undefined;
}

/** The native failed toolResult is persisted by Pi and drives its normal outer loop. */
export const validationRecoveryTool: ToolDefinition = {
  name: VALIDATION_ERROR_TOOL,
  label: "Rejected SDK tool call",
  description:
    "Reports a rejected tool call. Do not call this tool; fix the rejected call using the declared tools.",
  exposure: "model-only",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  prepareLoadout: () => ({ hiddenDeclarations: [VALIDATION_ERROR_TOOL] }),
  parameters: Type.Object({
    error: Type.Union(VALIDATION_REASONS.map((reason) => Type.Literal(reason))),
  }),
  async execute(_id, input) {
    throw new Error(validationRecoveryReason(input));
  },
};

/** Normalize known Pi rejection results only when a provider-authored synthetic call correlates.
 * Unknown, cancelled, successful, nested and same-named user/tool results remain untouched.
 */
export function normalizeValidationResult(
  message: MessageEndEvent["message"],
  history: readonly MessageEndEvent["message"][],
): MessageEndEventResult | undefined {
  if (
    message.role !== "toolResult" ||
    message.toolName !== VALIDATION_ERROR_TOOL ||
    !message.isError
  ) {
    return undefined;
  }
  const assistant = history.findLast((entry) => entry.role === "assistant");
  if (
    assistant?.role !== "assistant" ||
    !isClaudeProvider(assistant.provider) ||
    assistant.stopReason !== "toolUse"
  ) {
    return undefined;
  }
  const call = assistant.content.find(
    (block) => block.type === "toolCall" && block.id === message.toolCallId,
  );
  if (
    call?.type !== "toolCall" ||
    call.name !== VALIDATION_ERROR_TOOL ||
    !VALIDATION_REASONS.some((reason) => reason === call.arguments.error) ||
    Object.keys(call.arguments).length !== 1
  ) {
    return undefined;
  }
  const text =
    message.content.length === 1 && message.content[0]?.type === "text"
      ? message.content[0].text
      : undefined;
  if (
    text !== `Tool ${VALIDATION_ERROR_TOOL} not found` &&
    text !== validationRecoveryReason(call.arguments)
  ) {
    return undefined;
  }
  return {
    message: {
      ...message,
      content: [{ type: "text", text: validationRecoveryReason(call.arguments) }],
    },
  };
}
