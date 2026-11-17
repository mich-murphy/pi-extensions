/** A typed success, or an expected failure the caller must handle. */
export type Result<T, E> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "err"; readonly error: E };

/**
 * Construct a success.
 *
 * @param value - The successful value.
 * @returns A result holding the value.
 */
export function ok<T>(value: T): Result<T, never> {
  return { _tag: "ok", value };
}

/**
 * Construct an expected failure.
 *
 * @param error - The typed failure.
 * @returns A result holding the failure.
 */
export function err<E>(error: E): Result<never, E> {
  return { _tag: "err", error };
}
