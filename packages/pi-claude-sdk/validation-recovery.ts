import { Type } from "@earendil-works/pi-ai";
import type { ToolCallEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Reserved bridge operation. Never delegates to or executes another tool. */
export const VALIDATION_ERROR_TOOL = "pi_claude_sdk_validation_error";

/** Every bounded rejection reason; the single source for the schema and replay notes. */
export const VALIDATION_REASONS = [
  "invalid_tool_input",
  "unexpected_sdk_tool",
  "uncaptured_tool_batch",
  "sdk_input_rejected",
] as const;

/** Value-free, bounded correction text shared by the tool and its fail-safe guard. */
export function validationRecoveryReason(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "error" in input &&
    input.error === "uncaptured_tool_batch"
  ) {
    return "Tool did not execute: the SDK resolved it without Pi permission deferral. Request the declared tool again; Pi owns execution.";
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "error" in input &&
    input.error === "sdk_input_rejected"
  ) {
    return "SDK input was rejected before Pi permission deferral, possibly during JSON parsing. No tool executed. Request a declared tool with valid JSON parameters matching its schema.";
  }
  const unexpected =
    typeof input === "object" &&
    input !== null &&
    "error" in input &&
    input.error === "unexpected_sdk_tool";
  return unexpected
    ? "Rejected SDK tool did not execute. Use only a declared MCP tool with parameters matching its schema."
    : "Rejected tool input did not execute: invoke a declared MCP tool directly with parameters matching its schema. Do not request the validation-error tool.";
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
    "Provider-owned validation error. Do not request this tool; correct the rejected tool call using the available tool catalog.",
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
