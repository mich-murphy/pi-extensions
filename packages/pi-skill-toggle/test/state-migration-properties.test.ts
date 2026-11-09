import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { resourcePathId } from "../resource-path";
import type { ToggleValue } from "../resources";
import { ToggleStateFile, ToggleStateMalformed, ToggleStateTooNew } from "../state";
import type { ToggleStateResult } from "../state";
import { assertProperty } from "./hegel-property";

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

type Choice = "absent" | ToggleValue;
type Version = 4 | 5 | 6;
type Fixture = { readonly statePath: string; readonly skill: (name: string) => string };

const BODIES: readonly Record<string, unknown>[] = [{}, { resources: 5 }, { overrides: DECOY }];

function badValues(version: Version): gs.PrintableGenerator<unknown> {
  return gs.sampledFrom<unknown>(version === 6 ? BAD_TOGGLES : BAD_LEGACY);
}

const versions = gs.sampledFrom<Version>([4, 5, 6]);
const choices = gs.arrays(gs.sampledFrom<Choice>(["absent", "enabled", "disabled"]), {
  minSize: NAMES.length,
  maxSize: NAMES.length,
});

function withFixture(run: (fixture: Fixture) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-skill-toggle-migration-"));
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

function load(fixture: Fixture, document: unknown): ToggleStateResult {
  writeFileSync(fixture.statePath, JSON.stringify(document));
  return new ToggleStateFile(fixture.statePath).load();
}

/** Legacy meaning: v4/v5 stored `{enabled: boolean}` under `resources`, v6 stored toggles under `overrides`. */
function legacyDocument(version: Version, entries: Record<string, unknown>): unknown {
  return version === 6
    ? { version, overrides: entries, resources: DECOY }
    : { version, resources: entries, overrides: DECOY };
}

function legacyEntry(version: Version, value: ToggleValue, extra: object): unknown {
  return version === 6 ? value : { enabled: value === "enabled", ...extra };
}

function expectedToggles(fixture: Fixture, picks: readonly Choice[]): Map<string, ToggleValue> {
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
  picks: readonly Choice[],
  extra: object,
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const [index, pick] of picks.entries()) {
    if (pick !== "absent") {
      entries[fixture.skill(NAMES[index] ?? "")] = legacyEntry(version, pick, extra);
    }
  }
  return entries;
}

function assertToggles(
  result: ToggleStateResult,
  expected: ReadonlyMap<string, ToggleValue>,
): void {
  assert.ok(result._tag === "ok", JSON.stringify(result));
  assert.deepEqual(result.value.files, expected);
  assert.equal(result.value.repositories.size, 0);
}

function assertMalformed(
  result: ToggleStateResult,
  fixture: Fixture,
  entry: string | undefined,
): void {
  assert.ok(result._tag === "err");
  assert.ok(result.error instanceof ToggleStateMalformed, result.error.message);
  assert.equal(result.error.path, fixture.statePath);
  assert.equal(result.error.entry, entry);
}

/** Loading a legacy document gives the toggles the legacy meaning prescribes, and saving keeps them. */
function assertMigrates(
  fixture: Fixture,
  version: Version,
  picks: readonly Choice[],
  extra: object,
): void {
  const expected = expectedToggles(fixture, picks);
  const document = legacyDocument(version, validEntries(fixture, version, picks, extra));
  assertToggles(load(fixture, document), expected);
  const store = new ToggleStateFile(fixture.statePath);
  const spare = resourcePathId(fixture.skill(SPARE), "/");
  assert.equal(store.set(spare, "enabled")._tag, "ok");
  assert.equal(store.set(spare, "default")._tag, "ok");
  assert.match(readFileSync(fixture.statePath, "utf8"), /"version":\s*7/u);
  assertToggles(store.load(), expected);
  assertToggles(new ToggleStateFile(fixture.statePath).load(), expected);
}

/** One bad entry among valid ones is an error naming exactly that entry. */
function assertBadEntry(
  fixture: Fixture,
  version: Version,
  picks: readonly Choice[],
  bad: { readonly keyIsBad: boolean; readonly key: string; readonly value: unknown },
  slot: number,
): void {
  const entries = validEntries(fixture, version, picks, {});
  const key = bad.keyIsBad ? bad.key : fixture.skill(NAMES[slot] ?? "");
  entries[key] = bad.keyIsBad ? legacyEntry(version, "enabled", {}) : bad.value;
  assertMalformed(load(fixture, legacyDocument(version, entries)), fixture, key);
}

function assertBadContainer(fixture: Fixture, version: Version, container: unknown): void {
  const field = version === 6 ? "overrides" : "resources";
  assertMalformed(load(fixture, { version, [field]: container }), fixture, undefined);
}

function assertEmpty(result: ToggleStateResult): void {
  assertToggles(result, new Map());
}

function assertTooNew(fixture: Fixture, whole: number, fractional: boolean): void {
  const version = whole - (fractional ? 0.5 : 0);
  const result = load(fixture, { version, files: {}, repositories: {} });
  assert.ok(result._tag === "err");
  assert.ok(result.error instanceof ToggleStateTooNew, result.error.message);
  assert.equal(result.error.version, version);
  assert.equal(result.error.path, fixture.statePath);
}

describe("legacy state migration properties", () => {
  test("v4, v5 and v6 documents load as the toggles their legacy meaning prescribes and stay stable when saved", () => {
    withFixture((fixture) => {
      assertProperty("migration", "legacy-meaning", (tc) => {
        const version = tc.draw(versions);
        const picks = tc.draw(choices);
        const extra = tc.draw(gs.sampledFrom(EXTRAS));
        assertMigrates(fixture, version, picks, extra);
      });
    });
  });

  test("one malformed legacy entry is reported by key and never skipped", () => {
    withFixture((fixture) => {
      assertProperty("migration", "malformed-entry", (tc) => {
        const version = tc.draw(versions);
        const picks = tc.draw(choices);
        const keyIsBad = tc.draw(gs.booleans());
        const key = tc.draw(gs.sampledFrom(BAD_KEYS));
        const value = tc.draw(badValues(version));
        const slot = tc.draw(gs.integers({ minValue: 0, maxValue: NAMES.length - 1 }));
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
          tc.draw(gs.sampledFrom<unknown>(BAD_CONTAINERS)),
        );
      });
    });
  });

  test("integer versions below 4 load as empty toggles whatever the body", () => {
    withFixture((fixture) => {
      assertProperty("migration", "ancient-version", (tc) => {
        const version = tc.draw(gs.integers({ minValue: -100_000, maxValue: 3 }));
        const body = tc.draw(gs.sampledFrom(BODIES));
        assertEmpty(load(fixture, { ...body, version }));
      });
    });
  });

  test("versions above 7 are too new and carry the version and path", () => {
    withFixture((fixture) => {
      assertProperty("migration", "too-new", (tc) => {
        const whole = tc.draw(gs.integers({ minValue: 8, maxValue: 100_000 }));
        assertTooNew(fixture, whole, tc.draw(gs.booleans()));
      });
    });
  });

  test("fractional versions up to 7, non-number versions and non-object documents are malformed", () => {
    withFixture((fixture) => {
      assertProperty("migration", "bad-version", (tc) => {
        const half = tc.draw(gs.integers({ minValue: -100_000, maxValue: 6 })) + 0.5;
        assertMalformed(load(fixture, { version: half, resources: {} }), fixture, undefined);
        const odd = tc.draw(gs.sampledFrom<unknown>(BAD_VERSIONS));
        assertMalformed(load(fixture, { version: odd, resources: {} }), fixture, undefined);
        assertMalformed(
          load(fixture, tc.draw(gs.sampledFrom<unknown>(BAD_DOCUMENTS))),
          fixture,
          undefined,
        );
      });
    });
  });
});
