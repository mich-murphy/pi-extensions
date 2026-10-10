/**
 * Redacted<T> — branded wrapper that prevents accidental logging/serialization.
 *
 * Vendored from dmmulroy/pi-web-tools (MIT), itself vendored from
 * cloudflare-agent/packages/redacted (MIT). Core primitive only.
 */
declare const redactedBrand: unique symbol;

/** A sensitive value wrapper with safe string, JSON, and inspect projections. */
export type Redacted<A> = {
  readonly [redactedBrand]?: A;
  readonly toString: () => string;
  readonly toJSON: () => string;
};

const registry = new WeakMap<object, unknown>();

const proto = {
  toString() {
    return "<redacted>";
  },
  toJSON() {
    return "<redacted>";
  },
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "<redacted>";
  },
};

function makeRedacted<A>(value: A): Redacted<A> {
  // The registry WeakMap holds the value; the wrapper never exposes it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Object.create returns any; proto supplies toString and toJSON, and the brand property is type-only
  const redacted: Redacted<A> = Object.create(proto) as Redacted<A>;
  registry.set(redacted, value);
  return redacted;
}

function readRedactedValue<A>(self: Redacted<A>): A;
function readRedactedValue(self: unknown): unknown;
function readRedactedValue(self: unknown): unknown {
  if (typeof self !== "object" || self === null || !registry.has(self)) {
    throw new Error("Redacted value was not in registry");
  }
  return registry.get(self);
}

/** Constructors and safe unwrap operation for Redacted values. */
export const Redacted = {
  make: makeRedacted,
  value: readRedactedValue,
} as const;

/**
 * Replace every occurrence of each secret in text with a fixed placeholder.
 * Applied to all tool output and error messages as defense in depth: provider
 * responses should never contain API keys, but a compromised or buggy endpoint
 * must not be able to reflect credentials back into the session transcript.
 */
export function redactSecrets(input: string, secrets: readonly (string | undefined)[]): string {
  let output = input;
  for (const secret of secrets) {
    if (secret === undefined || secret === "") {
      continue;
    }
    output = output.split(secret).join("[redacted]");
  }
  return output;
}
