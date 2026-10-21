import { Type } from "@earendil-works/pi-ai";
import type { ToolCallEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Reserved bridge operation. Never delegates to or executes another tool. */
export const VALIDATION_ERROR_TOOL = "pi_claude_sdk_validation_error";

/** Value-free, bounded correction text shared by the tool and its fail-safe guard. */
export function validationRecoveryReason(input: unknown): string {
  const unexpected =
    typeof input === "object" &&
    input !== null &&
    "error" in input &&
    input.error === "unexpected_sdk_tool";
  return unexpected
    ? "Rejected SDK tool did not execute. Use only pi_call with an available Pi tool's exact name and an arguments object."
    : "Invalid pi_call did not execute: supply an available Pi tool's exact name and the required arguments object matching its schema ({} only for a parameterless tool). Never request the gateway or validation-error tool as the target.";
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
    "Provider-owned validation error. Do not request this tool; correct the rejected pi_call using the available tool catalog.",
  exposure: "model-only",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  prepareLoadout: () => ({ hiddenDeclarations: [VALIDATION_ERROR_TOOL] }),
  parameters: Type.Object({
    error: Type.Union([Type.Literal("invalid_gateway_input"), Type.Literal("unexpected_sdk_tool")]),
  }),
  async execute(_id, input) {
    throw new Error(validationRecoveryReason(input));
  },
};
