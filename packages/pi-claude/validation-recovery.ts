import type {
  MessageEndEvent,
  MessageEndEventResult,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import { Type } from "typebox";
import { isClaudeProvider } from "./provider-id";

export const VALIDATION_ERROR_TOOL = "pi_claude_sdk_validation_error";

export const VALIDATION_REASONS = [
  "invalid_tool_input",
  "unexpected_sdk_tool",
  "uncaptured_tool_batch",
  "sdk_input_rejected",
  "printed_tool_call",
] as const;

const validationInput = Schema.Struct({ error: Schema.Literals(VALIDATION_REASONS) });
export const decodeValidationInput = Schema.decodeUnknownOption(validationInput);

export type ValidationInput = typeof validationInput.Type;

const recoveryReasons = {
  uncaptured_tool_batch:
    "The tool did not run: Claude Code handled the call without passing it to Pi. Call the declared mcp__pi__ tool again.",
  sdk_input_rejected:
    "The tool did not run: Claude Code rejected its input, possibly as invalid JSON. Call a declared mcp__pi__ tool again with valid JSON that matches its schema.",
  printed_tool_call:
    "Your last reply printed a tool call as text, so nothing ran. Call the declared mcp__pi__ tool directly instead of writing a <call> tag or JSON.",
  unexpected_sdk_tool:
    "That tool is not available, so it did not run. Call only a declared mcp__pi__ tool, with parameters that match its schema.",
  invalid_tool_input: `The tool did not run: its parameters do not match its schema. Call the declared mcp__pi__ tool again with valid parameters. Do not call ${VALIDATION_ERROR_TOOL}.`,
} satisfies Record<ValidationInput["error"], string>;

export function validationRecoveryReason(input: ValidationInput | undefined): string {
  return recoveryReasons[input?.error ?? "invalid_tool_input"];
}

export function blockValidationRecovery(
  toolName: string,
  input: ValidationInput | undefined,
): ToolCallEventResult | undefined {
  return toolName === VALIDATION_ERROR_TOOL
    ? { block: true, reason: validationRecoveryReason(input) }
    : undefined;
}

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
    throw new Error(validationRecoveryReason(Option.getOrUndefined(decodeValidationInput(input))));
  },
};

export function normalizeValidationResult(
  message: MessageEndEvent["message"],
  history: ReadonlyArray<MessageEndEvent["message"]>,
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
    Object.keys(call.arguments).length !== 1
  ) {
    return undefined;
  }

  const input = Option.getOrUndefined(decodeValidationInput(call.arguments));

  if (input === undefined) {
    return undefined;
  }

  const reason = validationRecoveryReason(input);

  const text =
    message.content.length === 1 && message.content[0]?.type === "text"
      ? message.content[0].text
      : undefined;

  if (text !== `Tool ${VALIDATION_ERROR_TOOL} not found` && text !== reason) {
    return undefined;
  }

  return {
    message: {
      ...message,
      content: [{ type: "text", text: reason }],
    },
  };
}
