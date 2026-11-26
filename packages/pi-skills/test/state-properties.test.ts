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
import {
  arrays,
  booleans,
  composite,
  integers,
  none,
  oneOf,
  recursive,
  sampledFrom,
  text,
  tuples,
} from "@hegeldev/hegel/generators";
import type { PrintableGenerator, RecursiveOptions } from "@hegeldev/hegel/generators";
import { Result } from "effect";
import { describe, test } from "vitest";
import { propertyTimeout } from "../../../test-support/hegel-settings";
import { resourcePathId } from "../resource-path";
import type { ResourcePath } from "../resource-path";
import type { ToggleValue } from "../resources";
import { ToggleStateFile } from "../state";
import type { ToggleStateResult } from "../state";
import { assertProperty } from "./hegel-property";
import { timeoutOverTenfold } from "./test-timeouts";

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

const pairs = (key: PrintableGenerator<string>, value: PrintableGenerator<unknown>) =>
  composite((tc) => Object.fromEntries(tc.draw(arrays(tuples(key, value), { maxSize: 4 }))));

const jsonWith = (options: RecursiveOptions): PrintableGenerator<unknown> =>
  recursive<unknown>(
    oneOf<unknown>(
      none(),
      booleans(),
      integers(),
      text({ maxSize: 8 }),
      sampledFrom(KEYS),
      sampledFrom(PATHS),
    ),
    (children) =>
      oneOf<unknown>(
        arrays(children, { maxSize: 4 }),
        pairs(oneOf(sampledFrom(KEYS), sampledFrom(PATHS), text({ maxSize: 4 })), children),
      ),
    options,
  );

const json = jsonWith({});
const entryJson = jsonWith({ maxLeaves: 8 });

const toggleish = oneOf<unknown>(
  sampledFrom(TOGGLES),
  entryJson,
  pairs(sampledFrom(KEYS), entryJson),
);

const fileish = oneOf<unknown>(entryJson, pairs(sampledFrom(PATHS), toggleish));

const repositoryish = oneOf<unknown>(
  entryJson,
  pairs(sampledFrom(PATHS), pairs(sampledFrom(RELATIVE), toggleish)),
);

const documentLike = composite((tc) => ({
  version: tc.draw(sampledFrom<unknown>(VERSIONS)),
  files: tc.draw(fileish),
  repositories: tc.draw(repositoryish),
  overrides: tc.draw(fileish),
  resources: tc.draw(fileish),
}));

const document = oneOf<unknown>(json, documentLike);

const stats = { ok: 0, err: 0 };

function isToggleValue(value: string): boolean {
  return value === "enabled" || value === "disabled";
}

function inTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pi-skills-props-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertWellFormed(result: ToggleStateResult): void {
  if (Result.isFailure(result)) {
    stats.err += 1;
    assert.ok(ERROR_TAGS.has(result.failure._tag), result.failure._tag);

    return;
  }

  stats.ok += 1;

  for (const [path, value] of result.success.files) {
    assertAbsoluteNormalized(path);
    assert.ok(!path.includes("\0"), path);
    assert.ok(isToggleValue(value), value);
  }

  for (const [repository, entries] of result.success.repositories) {
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
  readonly model: Map<ResourcePath, ToggleValue>;
};

function snapshot(statePath: string): string | undefined {
  return existsSync(statePath) ? readFileSync(statePath, "utf8") : undefined;
}

function inRepository(fixture: Fixture, path: string): boolean {
  return path.startsWith(`${fixture.root}/`);
}

function assertLoads(fixture: Fixture, model: ReadonlyMap<ResourcePath, ToggleValue>): void {
  const files = new Map([...model].filter(([path]) => !inRepository(fixture, path)));

  const entries = new Map(
    [...model].flatMap<[string, ToggleValue]>(([path, value]) =>
      inRepository(fixture, path) ? [[relative(fixture.root, path), value]] : [],
    ),
  );

  const repositories = entries.size === 0 ? new Map() : new Map([[fixture.repository, entries]]);

  for (const store of [fixture.store, new ToggleStateFile(fixture.statePath)]) {
    const loaded = store.load();
    assert.ok(Result.isSuccess(loaded));
    assert.deepEqual(loaded.success.files, files);
    assert.deepEqual(loaded.success.repositories, repositories);
  }
}

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
  assert.ok(Result.isSuccess(result));
  assertLoads(fixture, fixture.model);
}

function probe(fixture: Fixture, path: ResourcePath): void {
  const stale = [...fixture.model.keys()].some(
    (key) => !inRepository(fixture, key) && !existsSync(key),
  );

  if (fixture.model.has(path) || stale) {
    return;
  }

  const before = snapshot(fixture.statePath);
  assert.ok(Result.isSuccess(fixture.store.set(path, "enabled")));
  assertLoads(fixture, new Map([...fixture.model, [path, "enabled"]]));
  assert.ok(Result.isSuccess(fixture.store.set(path, "default")));
  assertLoads(fixture, fixture.model);
  const after = snapshot(fixture.statePath);

  if (before === undefined) {
    assert.deepEqual(JSON.parse(after ?? ""), { version: 7, files: {}, repositories: {} });
  } else {
    assert.equal(after, before);
  }
}

type Workspace = {
  readonly statePath: string;
  readonly root: string;
  readonly paths: readonly ResourcePath[];
};

function withWorkspace(run: (workspace: Workspace) => void): void {
  inTemporaryDirectory((directory) => {
    const root = join(directory, "checkout");
    mkdirSync(join(root, ".git"), { recursive: true });

    const paths = Array.from({ length: SLOTS }, (_, index) => {
      const file = join(index < 2 ? directory : root, `r${index}`, "SKILL.md");
      mkdirSync(dirname(file), { recursive: true });

      return resourcePathId(file, directory);
    });

    run({ statePath: join(directory, "state", "pi-skills.json"), root, paths });
  });
}

function resetWorkspace(workspace: Workspace): void {
  rmSync(workspace.statePath, { force: true });

  for (const [index, path] of workspace.paths.entries()) {
    writeFileSync(path, `r${index}`);
  }
}

function assertSequence(workspace: Workspace, steps: readonly (readonly [number, Action])[]): void {
  resetWorkspace(workspace);
  const { statePath, root, paths } = workspace;

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
    arrays(tuples(integers({ minValue: 0, maxValue: SLOTS - 1 }), sampledFrom(ACTIONS)), {
      maxSize: 14,
    }),
  );
}

describe("state properties", () => {
  test(
    "loading arbitrary JSON-ish documents never throws and yields well-formed overrides",
    () => {
      withLoader((load) => {
        assertProperty("state", "load-never-throws", (tc) => {
          assertWellFormed(load(JSON.stringify(tc.draw(document))));
        });
      });
      assertBothOutcomes();
    },
    propertyTimeout(timeoutOverTenfold(90_000, 6200)),
  );

  test(
    "loading arbitrary text never throws",
    () => {
      withLoader((load) => {
        assertProperty("state", "load-text", (tc) => {
          assertWellFormed(load(tc.draw(text({ maxSize: 40 }))));
        });
      });
    },
    propertyTimeout(timeoutOverTenfold(30_000, 500)),
  );

  test(
    "set/clear sequences match a map model, survive reload, and round-trip file bytes",
    () => {
      withWorkspace((workspace) => {
        assertProperty("state", "set-clear-model", (tc) => {
          assertSequence(workspace, drawSteps(tc));
        });
      });
    },
    propertyTimeout(timeoutOverTenfold(150_000, 10_500)),
  );

  test("a stale entry is pruned by the next update (example)", () => {
    withWorkspace((workspace) => {
      assertSequence(workspace, [
        [0, "enabled"],
        [1, "disabled"],
        [0, "toggle-file"],
        [2, "enabled"],
        [0, "probe"],
        [1, "probe"],
      ]);
    });
  });
});
