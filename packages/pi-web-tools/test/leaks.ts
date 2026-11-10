import { inspect } from "node:util";
import { expect } from "vitest";

const MAX_DEPTH = 16;

function collect(value: unknown, seen: Set<object>, out: string[], depth: number): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value) || depth > MAX_DEPTH) {
    return;
  }
  seen.add(value);
  if (value instanceof Error) {
    // `message` may be a prototype getter, and JSON.stringify drops it with the stack.
    out.push(value.name, value.message, value.stack ?? "");
  }
  if (value instanceof Map || value instanceof Set) {
    for (const entry of value) {
      collect(entry, seen, out, depth + 1);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    out.push(String(key));
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      collect(descriptor.value, seen, out, depth + 1);
    }
  }
}

/**
 * Everything an observer of a value can read: message, stack, every own property (enumerable or
 * not), the whole cause chain and nested objects. Unlike `JSON.stringify`, which renders an Error
 * as `{}` and skips non-enumerable properties, a retained raw cause shows up here.
 */
export function observableText(value: unknown): string {
  const out: string[] = [];
  collect(value, new Set(), out, 0);
  out.push(inspect(value, { depth: null, showHidden: true }));
  return out.join("\n");
}

/** Fail when any fragment appears anywhere an observer could read it from the value. */
export function expectNoLeak(value: unknown, ...fragments: readonly string[]): void {
  const text = observableText(value);
  for (const fragment of fragments) {
    expect(text, `leaked ${JSON.stringify(fragment)}`).not.toContain(fragment);
  }
}
