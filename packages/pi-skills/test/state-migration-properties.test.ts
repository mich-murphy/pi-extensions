import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arrays, booleans, integers, sampledFrom } from "@hegeldev/hegel/generators";
import type { PrintableGenerator } from "@hegeldev/hegel/generators";
import { Result } from "effect";
import type { Schema } from "effect";
import { describe, test } from "vitest";
import { propertyTimeout } from "../../../test-support/hegel-settings";
import { resourcePathId } from "../resource-path";
import type { ToggleValue } from "../resources";
import { ToggleStateFile } from "../state";
import type { ToggleStateResult } from "../state";
import { assertProperty } from "./hegel-property";
import { timeoutOverTenfold } from "./test-timeouts";

const NAMES = ["a", "b", "c", "d", "e"];
const SPARE = "spare";
const DECOY = { relative: null };
const EXTRAS = [{}, { name: "x" }, { mtime: 1 }];
const BAD_KEYS = ["rel", "a/b", "", "./x", "~", "/a\0b"];

const BAD_LEGACY = [
  null,
  5,
  "enabled",
  true,
  [],
  {},
  { enabled: "yes" },
  { enabled: 1 },
  { Enabled: true },
  [true],
];

const BAD_TOGGLES = [
  null,
  true,
  5,
  "default",
  "",
  "Enabled",
  {},
  [],
  { enabled: true },
  ["enabled"],
];

const BAD_CONTAINERS = [null, 5, "x", true, [], undefined];
const BAD_VERSIONS = ["7", "4", null, true, [], {}];
const BAD_DOCUMENTS = [null, 5, "x", true, []];

type JsonValue = typeof Schema.Json.Type;

type JsonObject = typeof Schema.JsonObject.Type;

type FixtureExtra = { name?: string; mtime?: number };

type Choice = "absent" | ToggleValue;

type Version = 4 | 5 | 6;

type Fixture = { readonly statePath: string; readonly skill: (name: string) => string };

const BODIES: ReadonlyArray<JsonObject> = [{}, { resources: 5 }, { overrides: DECOY }];

function badValues(version: Version): PrintableGenerator<JsonValue> {
  return sampledFrom<JsonValue>(version === 6 ? BAD_TOGGLES : BAD_LEGACY);
}

const versions = sampledFrom<Version>([4, 5, 6]);

const choices = arrays(sampledFrom<Choice>(["absent", "enabled", "disabled"]), {
  minSize: NAMES.length,
  maxSize: NAMES.length,
});

function withFixture(run: (fixture: Fixture) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-skills-migration-"));

  try {
    const skill = (name: string): string => join(directory, name, "SKILL.md");

    for (const name of [...NAMES, SPARE]) {
      mkdirSync(join(directory, name), { recursive: true });
      writeFileSync(skill(name), name);
    }

    run({ statePath: join(directory, "state.json"), skill });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function load(fixture: Fixture, document: JsonValue): ToggleStateResult {
  writeFileSync(fixture.statePath, JSON.stringify(document));

  return new ToggleStateFile(fixture.statePath).load();
}

function legacyDocument(version: Version, entries: JsonObject) {
  return version === 6
    ? { version, overrides: entries, resources: DECOY }
    : { version, resources: entries, overrides: DECOY };
}

function legacyEntry(version: Version, value: ToggleValue, extra: FixtureExtra) {
  return version === 6 ? value : { enabled: value === "enabled", ...extra };
}

function expectedToggles(fixture: Fixture, picks: ReadonlyArray<Choice>): Map<string, ToggleValue> {
  const expected = new Map<string, ToggleValue>();

  for (const [index, pick] of picks.entries()) {
    if (pick !== "absent") {
      expected.set(fixture.skill(NAMES[index] ?? ""), pick);
    }
  }

  return expected;
}

function validEntries(
  fixture: Fixture,
  version: Version,
  picks: ReadonlyArray<Choice>,
  extra: FixtureExtra,
) {
  const entries = new Map<string, JsonValue>();

  for (const [index, pick] of picks.entries()) {
    if (pick !== "absent") {
      entries.set(fixture.skill(NAMES[index] ?? ""), legacyEntry(version, pick, extra));
    }
  }

  return Object.fromEntries(entries);
}

function assertToggles(
  result: ToggleStateResult,
  expected: ReadonlyMap<string, ToggleValue>,
): void {
  assert.ok(Result.isSuccess(result), JSON.stringify(result));
  assert.deepEqual(result.success.files, expected);
  assert.equal(result.success.repositories.size, 0);
}

function assertMalformed(
  result: ToggleStateResult,
  fixture: Fixture,
  entry: string | undefined,
): void {
  assert.ok(Result.isFailure(result));
  assert.strictEqual(result.failure._tag, "ToggleStateMalformed", result.failure.message);
  assert.equal(result.failure.path, fixture.statePath);
  assert.equal(result.failure.entry, entry);
}

function assertMigrates(
  fixture: Fixture,
  version: Version,
  picks: ReadonlyArray<Choice>,
  extra: FixtureExtra,
): void {
  const expected = expectedToggles(fixture, picks);
  const document = legacyDocument(version, validEntries(fixture, version, picks, extra));
  assertToggles(load(fixture, document), expected);
  const store = new ToggleStateFile(fixture.statePath);
  const spare = resourcePathId(fixture.skill(SPARE), "/");
  assert.ok(Result.isSuccess(store.set(spare, "enabled")));
  assert.ok(Result.isSuccess(store.set(spare, "default")));
  assert.match(readFileSync(fixture.statePath, "utf8"), /"version":\s*7/u);
  assertToggles(store.load(), expected);
  assertToggles(new ToggleStateFile(fixture.statePath).load(), expected);
}

function assertBadEntry(
  fixture: Fixture,
  version: Version,
  picks: ReadonlyArray<Choice>,
  bad: { readonly keyIsBad: boolean; readonly key: string; readonly value: JsonValue },
  slot: number,
): void {
  const entries = validEntries(fixture, version, picks, {});
  const key = bad.keyIsBad ? bad.key : fixture.skill(NAMES[slot] ?? "");
  entries[key] = bad.keyIsBad ? legacyEntry(version, "enabled", {}) : bad.value;
  assertMalformed(load(fixture, legacyDocument(version, entries)), fixture, key);
}

function assertBadContainer(
  fixture: Fixture,
  version: Version,
  container: JsonValue | undefined,
): void {
  const field = version === 6 ? "overrides" : "resources";
  assertMalformed(
    load(fixture, container === undefined ? { version } : { version, [field]: container }),
    fixture,
    undefined,
  );
}

function assertEmpty(result: ToggleStateResult): void {
  assertToggles(result, new Map());
}

function assertTooNew(fixture: Fixture, whole: number, fractional: boolean): void {
  const version = whole - (fractional ? 0.5 : 0);
  const result = load(fixture, { version, files: {}, repositories: {} });
  assert.ok(Result.isFailure(result));
  assert.strictEqual(result.failure._tag, "ToggleStateTooNew", result.failure.message);
  assert.equal(result.failure.version, version);
  assert.equal(result.failure.path, fixture.statePath);
}

describe(
  "legacy state migration properties",
  { timeout: propertyTimeout(timeoutOverTenfold(90_000, 1400)) },
  () => {
    test("v4, v5 and v6 documents load as the toggles their legacy meaning prescribes and stay stable when saved", () => {
      withFixture((fixture) => {
        assertProperty("migration", "legacy-meaning", (tc) => {
          const version = tc.draw(versions);
          const picks = tc.draw(choices);
          const extra = tc.draw(sampledFrom(EXTRAS));
          assertMigrates(fixture, version, picks, extra);
        });
      });
    });

    test("one malformed legacy entry is reported by key and never skipped", () => {
      withFixture((fixture) => {
        assertProperty("migration", "malformed-entry", (tc) => {
          const version = tc.draw(versions);
          const picks = tc.draw(choices);
          const keyIsBad = tc.draw(booleans());
          const key = tc.draw(sampledFrom(BAD_KEYS));
          const value = tc.draw(badValues(version));
          const slot = tc.draw(integers({ minValue: 0, maxValue: NAMES.length - 1 }));
          assertBadEntry(fixture, version, picks, { keyIsBad, key, value }, slot);
        });
      });
    });

    test("a legacy entries container that is not an object is malformed without an entry", () => {
      withFixture((fixture) => {
        assertProperty("migration", "malformed-container", (tc) => {
          assertBadContainer(
            fixture,
            tc.draw(versions),
            tc.draw(sampledFrom<JsonValue | undefined>(BAD_CONTAINERS)),
          );
        });
      });
    });

    test("integer versions below 4 load as empty toggles whatever the body", () => {
      withFixture((fixture) => {
        assertProperty("migration", "ancient-version", (tc) => {
          const version = tc.draw(integers({ minValue: -100_000, maxValue: 3 }));
          const body = tc.draw(sampledFrom(BODIES));
          assertEmpty(load(fixture, { ...body, version }));
        });
      });
    });

    test("versions above 7 are too new and carry the version and path", () => {
      withFixture((fixture) => {
        assertProperty("migration", "too-new", (tc) => {
          const whole = tc.draw(integers({ minValue: 8, maxValue: 100_000 }));
          assertTooNew(fixture, whole, tc.draw(booleans()));
        });
      });
    });

    test("fractional versions up to 7, non-number versions and non-object documents are malformed", () => {
      withFixture((fixture) => {
        assertProperty("migration", "bad-version", (tc) => {
          const half = tc.draw(integers({ minValue: -100_000, maxValue: 6 })) + 0.5;
          assertMalformed(load(fixture, { version: half, resources: {} }), fixture, undefined);
          const odd = tc.draw(sampledFrom<JsonValue>(BAD_VERSIONS));
          assertMalformed(load(fixture, { version: odd, resources: {} }), fixture, undefined);
          assertMalformed(
            load(fixture, tc.draw(sampledFrom<JsonValue>(BAD_DOCUMENTS))),
            fixture,
            undefined,
          );
        });
      });
    });
  },
);
