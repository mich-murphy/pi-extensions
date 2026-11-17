import { inspect } from "node:util";
import { expect } from "vitest";

const MAX_DEPTH = 16;

type Walk = { readonly seen: Set<object>; readonly out: string[] };

function collectPrimitive(value: unknown, out: string[]): boolean {
  if (typeof value === "string") {
    out.push(value);
    return true;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    out.push(String(value));
    return true;
  }
  return false;
}

function collectError(value: object, out: string[]): void {
  if (value instanceof Error) {
    // `message` may be a prototype getter, and JSON.stringify drops it with the stack.
    out.push(value.name, value.message, value.stack ?? "");
  }
}

function collectEntries(value: object, walk: Walk, depth: number): void {
  if (value instanceof Map || value instanceof Set) {
    for (const entry of value) {
      collect(entry, walk, depth + 1);
    }
  }
}

function collectOwnProperties(value: object, walk: Walk, depth: number): void {
  for (const key of Reflect.ownKeys(value)) {
    walk.out.push(String(key));
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      collect(descriptor.value, walk, depth + 1);
    }
  }
}

function alreadyVisitedOrTooDeep(value: object, walk: Walk, depth: number): boolean {
  return walk.seen.has(value) || depth > MAX_DEPTH;
}

function collect(value: unknown, walk: Walk, depth: number): void {
  if (collectPrimitive(value, walk.out)) {
    return;
  }
  if (typeof value !== "object" || value === null || alreadyVisitedOrTooDeep(value, walk, depth)) {
    return;
  }
  walk.seen.add(value);
  collectError(value, walk.out);
  collectEntries(value, walk, depth);
  collectOwnProperties(value, walk, depth);
}

/**
 * Everything an observer of a value can read: message, stack, every own property (enumerable or
 * not), the whole cause chain and nested objects. Unlike `JSON.stringify`, which renders an Error
 * as `{}` and skips non-enumerable properties, a retained raw cause shows up here.
 */
export function observableText(value: unknown): string {
  const out: string[] = [];
  collect(value, { seen: new Set(), out }, 0);
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
