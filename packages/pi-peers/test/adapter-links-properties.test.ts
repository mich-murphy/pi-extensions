import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { LinkTable } from "../adapter/links.js";

const machines = ["beta", "dev-01", "laptop"] as const;
const states = ["up", "down", "probing"] as const;
type Entry = { state: (typeof states)[number]; since: number; nextProbe?: number };
type World = { table: LinkTable; model: Map<string, Entry> };

function drawEntry(tc: TestCase): Entry {
  const state = tc.draw(gs.sampledFrom([...states]), "state");
  const since = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }), "since");
  const probe = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }), "probe");
  return probe === 0 ? { state, since } : { state, since, nextProbe: probe };
}
function changed(before: Entry | undefined, entry: Entry): boolean {
  return (
    before?.state !== entry.state ||
    before.since !== entry.since ||
    before.nextProbe !== entry.nextProbe
  );
}
function clearStep(world: World): void {
  assert.equal(
    world.table.clear(),
    world.model.size > 0,
    "clear reports a change only if non-empty",
  );
  world.model.clear();
}
function applyStep(tc: TestCase, world: World): void {
  const machineId = tc.draw(gs.sampledFrom([...machines]), "machine");
  const entry = drawEntry(tc);
  const expected = changed(world.model.get(machineId), entry);
  assert.equal(world.table.apply({ machineId, ...entry }), expected, "change detection");
  world.model.set(machineId, entry);
}
function step(tc: TestCase, world: World): void {
  const clear = tc.draw(gs.integers({ minValue: 0, maxValue: 9 }), "clear") === 0;
  if (clear) {
    clearStep(world);
  } else {
    applyStep(tc, world);
  }
}
function checkDown(world: World): void {
  for (const machineId of machines) {
    const known = world.model.get(machineId);
    assert.equal(
      world.table.down(machineId),
      known !== undefined && known.state !== "up",
      "down exactly while a known link is not up",
    );
  }
  assert.equal(world.table.list().length, world.model.size, "one entry per machine");
}
function run(tc: TestCase): void {
  const world: World = { table: new LinkTable(), model: new Map() };
  const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }), "steps");
  for (let index = 0; index < steps; index += 1) {
    step(tc, world);
    checkDown(world);
  }
}

describe("adapter link-state tracking", () => {
  test(
    "the table mirrors the latest frame per machine and reports a change exactly when one happened",
    () => {
      assertHegel(propertySettings(200), run);
    },
    propertyTimeout(20_000),
  );
});
