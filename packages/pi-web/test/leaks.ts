import { inspect } from "node:util";
import { Predicate, Schema } from "effect";
import { expect } from "vitest";

const MAX_DEPTH = 16;

const Scalars = Schema.Union([Schema.String, Schema.Number, Schema.BigInt, Schema.Boolean]);
const OtherScalars = Schema.Union([Schema.Symbol, Schema.Null, Schema.Undefined]);
const Reference = Schema.ObjectKeyword;
const inspectable = Schema.Union([Scalars, OtherScalars, Reference]);
type Inspectable = typeof inspectable.Type;
type Reference = typeof Reference.Type;

export const decodeInspectable = Schema.decodeUnknownSync(inspectable);
const isInspectable = Schema.is(inspectable);
const isScalar = Schema.is(Scalars);
const isReference = Schema.is(
  Reference.pipe(Schema.check(Schema.makeFilter((value) => !Predicate.isFunction(value)))),
);
const isMap = Schema.is(Schema.instanceOf(Map<Inspectable, Inspectable>));
const isSet = Schema.is(Schema.instanceOf(Set<Inspectable>));

type Walk = { readonly seen: Set<Reference>; readonly out: string[] };

function collectError(value: Reference, out: string[]): void {
  if (value instanceof Error) {
    out.push(value.name, value.message, value.stack ?? "");
  }
}

function collectEntries(value: Reference, walk: Walk, depth: number): void {
  if (isMap(value) || isSet(value)) {
    for (const entry of value) {
      collect(entry, walk, depth + 1);
    }
  }
}

function collectOwnProperties(value: Reference, walk: Walk, depth: number): void {
  for (const key of Reflect.ownKeys(value)) {
    walk.out.push(String(key));
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      const child: unknown = descriptor.value;
      if (isInspectable(child)) {
        collect(child, walk, depth + 1);
      }
    }
  }
}

function alreadyVisitedOrTooDeep(value: Reference, walk: Walk, depth: number): boolean {
  return walk.seen.has(value) || depth > MAX_DEPTH;
}

function collect(value: Inspectable, walk: Walk, depth: number): void {
  if (isScalar(value)) {
    walk.out.push(String(value));
    return;
  }
  if (!isReference(value) || alreadyVisitedOrTooDeep(value, walk, depth)) {
    return;
  }
  walk.seen.add(value);
  collectError(value, walk.out);
  collectEntries(value, walk, depth);
  collectOwnProperties(value, walk, depth);
}

export function observableText(value: ReturnType<typeof decodeInspectable>): string {
  const out: string[] = [];
  collect(value, { seen: new Set(), out }, 0);
  out.push(inspect(value, { depth: null, showHidden: true }));
  return out.join("\n");
}

export function expectNoLeak(
  value: ReturnType<typeof decodeInspectable>,
  ...fragments: readonly string[]
): void {
  const text = observableText(value);
  for (const fragment of fragments) {
    expect(text, `leaked ${JSON.stringify(fragment)}`).not.toContain(fragment);
  }
}
