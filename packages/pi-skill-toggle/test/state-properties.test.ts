import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { resourcePathId } from "../resource-path";
import type { ResourcePath } from "../resource-path";
import type { ToggleValue } from "../resources";
import { ToggleStateFile } from "../state";
import type { ToggleStateResult } from "../state";
import { assertProperty } from "./hegel-property";

const ERROR_TAGS = new Set([
  "ToggleStateUnavailable",
  "ToggleStateInvalidJson",
  "ToggleStateTooNew",
  "ToggleStateMalformed",
]);
const KEYS = ["__proto__", "version", "files", "repositories", "overrides", "resources", "enabled"];
const PATHS = [
  "/a/b",
  "/a/b/",
  "/a//b",
  "/",
  "/a/../b",
  "rel",
  "",
  "/__proto__",
  "__proto__",
  "/a\0b",
];
const RELATIVE = [
  "x/SKILL.md",
  "x/",
  "../x",
  "/abs",
  "./x",
  "a/./b",
  "..",
  ".",
  "",
  "a\0b",
  "__proto__",
];
const VERSIONS = [-1, 0, 3, 4, 5, 6, 7, 8, 1.5, 7.5, "7", null, true];
const TOGGLES = ["enabled", "disabled", "default", "", 1];

const pairs = (key: gs.PrintableGenerator<string>, value: gs.PrintableGenerator<unknown>) =>
  gs.composite((tc) =>
    Object.fromEntries(tc.draw(gs.arrays(gs.tuples(key, value), { maxSize: 4 }))),
  );

const json: gs.PrintableGenerator<unknown> = gs.recursive<unknown>(
  gs.oneOf<unknown>(
    gs.none(),
    gs.booleans(),
    gs.integers(),
    gs.text({ maxSize: 8 }),
    gs.sampledFrom(KEYS),
    gs.sampledFrom(PATHS),
  ),
  (children) =>
    gs.oneOf<unknown>(
      gs.arrays(children, { maxSize: 4 }),
      pairs(
        gs.oneOf(gs.sampledFrom(KEYS), gs.sampledFrom(PATHS), gs.text({ maxSize: 4 })),
        children,
      ),
    ),
);

const toggleish = gs.oneOf<unknown>(
  gs.sampledFrom(TOGGLES),
  json,
  pairs(gs.sampledFrom(KEYS), json),
);
const fileish = gs.oneOf<unknown>(json, pairs(gs.sampledFrom(PATHS), toggleish));
const repositoryish = gs.oneOf<unknown>(
  json,
  pairs(gs.sampledFrom(PATHS), pairs(gs.sampledFrom(RELATIVE), toggleish)),
);
const documentLike = gs.composite((tc) => ({
  version: tc.draw(gs.sampledFrom<unknown>(VERSIONS)),
  files: tc.draw(fileish),
  repositories: tc.draw(repositoryish),
  overrides: tc.draw(fileish),
  resources: tc.draw(fileish),
}));
const document = gs.oneOf<unknown>(json, documentLike);

const stats = { ok: 0, err: 0 };

function isToggleValue(value: unknown): boolean {
  return value === "enabled" || value === "disabled";
}

function inTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-skill-toggle-props-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every value a successful load returns satisfies the documented type invariants. */
function assertWellFormed(result: ToggleStateResult): void {
  if (result._tag === "err") {
    stats.err += 1;
    assert.ok(ERROR_TAGS.has(result.error._tag), result.error._tag);
    return;
  }
  stats.ok += 1;
  for (const [path, value] of result.value.files) {
    assertAbsoluteNormalized(path);
    assert.ok(!path.includes("\0"), path);
    assert.ok(isToggleValue(value), value);
  }
  for (const [repository, entries] of result.value.repositories) {
    assertAbsoluteNormalized(repository);
    for (const [path, value] of entries) {
      assertRelativeEntry(path);
      assert.ok(isToggleValue(value), value);
    }
  }
}

function assertAbsoluteNormalized(path: string): void {
  assert.ok(isAbsolute(path) && resolve(path) === path, path);
}

function assertRelativeEntry(path: string): void {
  assert.ok(path !== "" && path !== "." && path !== ".." && !path.startsWith("../"), path);
  assert.ok(!isAbsolute(path) && !path.includes("\0") && normalize(path) === path, path);
}

function assertBothOutcomes(): void {
  assert.ok(stats.ok > 0 && stats.err > 0, JSON.stringify(stats));
}

type Loader = (content: string) => ToggleStateResult;

/** One temp directory per property run; each case overwrites the same state file. */
function withLoader(run: (load: Loader) => void): void {
  inTemporaryDirectory((directory) => {
    const path = join(directory, "state.json");
    run((content) => {
      writeFileSync(path, content);
      return new ToggleStateFile(path).load();
    });
  });
}

type Action = "enabled" | "disabled" | "default" | "toggle-file" | "probe";
const ACTIONS: readonly Action[] = ["enabled", "disabled", "default", "toggle-file", "probe"];
const SLOTS = 4;

type Fixture = {
  readonly statePath: string;
  readonly store: ToggleStateFile;
  readonly paths: readonly ResourcePath[];
  readonly repository: string;
  readonly root: string;
  /** Every explicit choice by resource path, whether it is stored as a file or repository entry. */
  readonly model: Map<ResourcePath, ToggleValue>;
};

function snapshot(statePath: string): string | undefined {
  return existsSync(statePath) ? readFileSync(statePath, "utf8") : undefined;
}

/** Slots inside the fake checkout are stored repository-relative; the others by absolute path. */
function inRepository(fixture: Fixture, path: string): boolean {
  return path.startsWith(`${fixture.root}/`);
}

function assertLoads(fixture: Fixture, model: ReadonlyMap<ResourcePath, ToggleValue>): void {
  const files = new Map([...model].filter(([path]) => !inRepository(fixture, path)));
  const entries = new Map(
    [...model]
      .filter(([path]) => inRepository(fixture, path))
      .map(([path, value]) => [relative(fixture.root, path), value]),
  );
  const repositories = entries.size === 0 ? new Map() : new Map([[fixture.repository, entries]]);
  for (const store of [fixture.store, new ToggleStateFile(fixture.statePath)]) {
    const loaded = store.load();
    assert.equal(loaded._tag, "ok");
    assert.ok(loaded._tag === "ok");
    assert.deepEqual(loaded.value.files, files);
    assert.deepEqual(loaded.value.repositories, repositories);
  }
}

/** Absolute entries whose file is gone are pruned by the next update; repository ones never are. */
function prune(fixture: Fixture): void {
  for (const path of fixture.model.keys()) {
    if (!inRepository(fixture, path) && !existsSync(path)) {
      fixture.model.delete(path);
    }
  }
}

function applySet(fixture: Fixture, path: ResourcePath, value: ToggleValue | "default"): void {
  prune(fixture);
  if (value === "default") {
    fixture.model.delete(path);
  } else {
    fixture.model.set(path, value);
  }
  const result = fixture.store.set(path, value);
  assert.equal(result._tag, "ok");
  assertLoads(fixture, fixture.model);
}

/** Set then clear an unset path: the state file returns to its prior bytes (or to an empty state). */
function probe(fixture: Fixture, path: ResourcePath): void {
  const stale = [...fixture.model.keys()].some(
    (key) => !inRepository(fixture, key) && !existsSync(key),
  );
  if (fixture.model.has(path) || stale) {
    return;
  }
  const before = snapshot(fixture.statePath);
  assert.equal(fixture.store.set(path, "enabled")._tag, "ok");
  assertLoads(fixture, new Map([...fixture.model, [path, "enabled"]]));
  assert.equal(fixture.store.set(path, "default")._tag, "ok");
  assertLoads(fixture, fixture.model);
  const after = snapshot(fixture.statePath);
  if (before === undefined) {
    assert.deepEqual(JSON.parse(after ?? ""), { version: 7, files: {}, repositories: {} });
  } else {
    assert.equal(after, before);
  }
}

function assertSequence(steps: readonly (readonly [number, Action])[]): void {
  inTemporaryDirectory((directory) => {
    const statePath = join(directory, "state", "pi-skill-toggle.json");
    const root = join(directory, "checkout");
    mkdirSync(join(root, ".git"), { recursive: true });
    const paths = Array.from({ length: SLOTS }, (_, index) => {
      const file = join(index < 2 ? directory : root, `r${index}`, "SKILL.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `r${index}`);
      return resourcePathId(file, directory);
    });
    const fixture: Fixture = {
      statePath,
      store: new ToggleStateFile(statePath),
      paths,
      repository: realpathSync(join(root, ".git")),
      root,
      model: new Map(),
    };
    assertLoads(fixture, new Map());
    for (const [slot, action] of steps) {
      const path = paths[slot];
      assert.ok(path);
      applyAction(fixture, path, action);
    }
  });
}

function applyAction(fixture: Fixture, path: ResourcePath, action: Action): void {
  if (action === "toggle-file") {
    if (existsSync(path)) {
      rmSync(path);
    } else {
      writeFileSync(path, "back");
    }
  } else if (action === "probe") {
    probe(fixture, path);
  } else {
    applySet(fixture, path, action);
  }
}

function drawSteps(tc: TestCase): (readonly [number, Action])[] {
  return tc.draw(
    gs.arrays(
      gs.tuples(gs.integers({ minValue: 0, maxValue: SLOTS - 1 }), gs.sampledFrom(ACTIONS)),
      {
        maxSize: 14,
      },
    ),
  );
}

describe("state properties", () => {
  // About 1.5s alone, spent in the recursive JSON generator rather than in load(); under a loaded
  // coverage run it exceeded vitest's 5s default, so it gets headroom instead of a smaller generator.
  test("loading arbitrary JSON-ish documents never throws and yields well-formed overrides", () => {
    withLoader((load) => {
      assertProperty("state", "load-never-throws", (tc) => {
        assertWellFormed(load(JSON.stringify(tc.draw(document))));
      });
    });
    assertBothOutcomes();
  }, 15_000);

  test("loading arbitrary text never throws", () => {
    withLoader((load) => {
      assertProperty("state", "load-text", (tc) => {
        assertWellFormed(load(tc.draw(gs.text({ maxSize: 40 }))));
      });
    });
  });

  test("set/clear sequences match a map model, survive reload, and round-trip file bytes", () => {
    assertProperty("state", "set-clear-model", (tc) => {
      assertSequence(drawSteps(tc));
    });
  });

  test("a stale entry is pruned by the next update (example)", () => {
    assertSequence([
      [0, "enabled"],
      [1, "disabled"],
      [0, "toggle-file"],
      [2, "enabled"],
      [0, "probe"],
      [1, "probe"],
    ]);
  });
});
