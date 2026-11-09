import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { createDeferredCallCapture } from "../sdk/deferred-tools";
import { compileToolCatalog } from "../sdk/tool-catalog";
import type { CatalogTool } from "../sdk/tool-catalog";
import { deliverToolUse } from "./fixtures";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };
const parameters = Type.Object({ path: Type.String() }, { additionalProperties: false });
const PREFIX = "mcp__pi__";
const SDK_NAME = /^[a-zA-Z0-9_-]{1,64}$/u;
const PLAIN = /^[a-zA-Z0-9_-]{1,55}$/u;
const HASHED = /^mcp__pi__pi_[0-9a-f]{48}$/u;

const SEPARATORS = [".", "_", "-", " ", "/", ":", "日", "é", "😀", ""];
const COMPAT = ["ａ", "Ａ", "ﬁ", "①", "é", "\u0065\u0301", "ǆ", "Ǆ", "İ", "ß", "a", "A", "."];
const VARIANTS: readonly ((name: string) => string)[] = [
  (name) => name.toUpperCase(),
  (name) => name.toLowerCase(),
  (name) => name.normalize("NFKC"),
  (name) => name.normalize("NFD"),
  (name) => name.normalize("NFC"),
];
const FIXED = [
  "read",
  "a.b",
  "a_b",
  "a-b",
  "日本語",
  "pi_reserved",
  `pi_${"0".repeat(48)}`,
  `${PREFIX}read`,
  "PI_read",
  "x".repeat(55),
  "x".repeat(56),
  "x".repeat(64),
  "x".repeat(200),
];

const nameGen = gs.oneOf(
  gs.text({ minSize: 1, maxSize: 200 }),
  gs.sampledFrom(FIXED),
  gs.composite((tc) => {
    const base = "x".repeat(tc.draw(gs.integers({ minValue: 50, maxValue: 70 })));
    return base + tc.draw(gs.sampledFrom(SEPARATORS)) + tc.draw(gs.text({ maxSize: 5 }));
  }),
  gs.arrays(gs.sampledFrom(COMPAT), { minSize: 1, maxSize: 4 }).map((parts) => parts.join("")),
  gs.composite((tc) => {
    const left = tc.draw(gs.text({ minSize: 1, maxSize: 4 }));
    const right = tc.draw(gs.text({ minSize: 1, maxSize: 4 }));
    return left + tc.draw(gs.sampledFrom(SEPARATORS)) + right;
  }),
);

function drawNames(tc: TestCase): string[] {
  const drawn = tc.draw(gs.arrays(nameGen, { minSize: 1, maxSize: 6 }));
  const picks = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 4 }), { maxSize: 4 }));
  const variants = picks.map((pick, index) => VARIANTS[pick]?.(drawn[index % drawn.length] ?? "x"));
  return [...new Set([...drawn, ...variants])].filter(
    (name): name is string => name !== undefined && name.length > 0,
  );
}

function compile(names: readonly string[]): readonly CatalogTool[] {
  return compileToolCatalog(names.map((name) => ({ name, description: "fixture", parameters })));
}

function assertDistinctAndWellFormed(names: readonly string[]): void {
  const catalog = compile(names);
  assert.deepEqual(
    catalog.map((entry) => entry.declaration.name),
    names,
  );
  const mapped = catalog.map((entry) => entry.sdkName);
  assert.equal(new Set(mapped).size, names.length, JSON.stringify(names));
  for (const [index, sdkName] of mapped.entries()) {
    const name = names[index] ?? "";
    assert.match(sdkName, SDK_NAME);
    assert.ok(sdkName.length <= 64, sdkName);
    assert.ok(sdkName.startsWith(PREFIX), sdkName);
    const expectsPlain = PLAIN.test(name) && !name.startsWith("pi_");
    if (expectsPlain) {
      assert.equal(sdkName, PREFIX + name);
    } else {
      assert.match(sdkName, HASHED, name);
    }
  }
}

function assertOrderIndependent(names: readonly string[]): void {
  const forward = new Map(compile(names).map((entry) => [entry.declaration.name, entry.sdkName]));
  const again = new Map(compile(names).map((entry) => [entry.declaration.name, entry.sdkName]));
  const reversed = new Map(
    compile(names.toReversed()).map((entry) => [entry.declaration.name, entry.sdkName]),
  );
  const alone = names.map((name) => compile([name])[0]?.sdkName);
  assert.deepEqual(again, forward);
  assert.deepEqual(reversed, forward);
  assert.deepEqual(
    alone,
    names.map((name) => forward.get(name)),
  );
}

function assertRoundTrip(names: readonly string[]): void {
  const catalog = compile(names);
  const capture = createDeferredCallCapture(catalog);
  for (const entry of catalog) {
    // The hook captures synchronously before its first await.
    void deliverToolUse(capture.hook, {
      id: entry.sdkName,
      toolName: entry.sdkName,
      input: { path: "p" },
    });
  }
  assert.equal(capture.unexpectedToolCalls, 0);
  assert.deepEqual(
    capture.calls.map((call) => call.name),
    names,
  );
  assert.deepEqual(
    capture.calls.map((call) => call.id),
    catalog.map((entry) => entry.sdkName),
  );
}

describe("SDK tool-name mapping properties", () => {
  test("mapped names are distinct, within 64 chars [a-zA-Z0-9_-], plain or hashed", () => {
    new Hegel((tc) => {
      assertDistinctAndWellFormed(drawNames(tc));
    })
      .databaseKey("pi-claude-sdk/tool-names-wellformed")
      .settings(settings)
      .runSync();
  });

  test("mapping is deterministic and independent of registration order and catalog", () => {
    new Hegel((tc) => {
      assertOrderIndependent(drawNames(tc));
    })
      .databaseKey("pi-claude-sdk/tool-names-deterministic")
      .settings(settings)
      .runSync();
  });

  test("mapped names round-trip to the exact Pi names through capture", () => {
    new Hegel((tc) => {
      assertRoundTrip(drawNames(tc));
    })
      .databaseKey("pi-claude-sdk/tool-names-roundtrip")
      .settings(settings)
      .runSync();
  });
});
