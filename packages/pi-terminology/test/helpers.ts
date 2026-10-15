import { expect } from "vitest";

export function expectOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly errors: readonly string[] },
): T {
  expect(result.ok).toBe(true);
  if (result.ok) {
    return result.value;
  }
  throw new Error(result.errors.join("\n"));
}

export function expectErr(
  result:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly errors: readonly string[] },
): readonly string[] {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    return result.errors;
  }
  throw new Error("Expected error result");
}
