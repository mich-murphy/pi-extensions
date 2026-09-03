import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resourcePathId } from "../resource-path";
import type { ToggleResource } from "../resources";
import {
  type SkillToggleState,
  type SkillToggleStateResult,
  SkillToggleStore,
  type SkillToggleStoreOptions,
} from "../state";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function expectFailure(result: SkillToggleStateResult, operation: "load" | "update"): void {
  expect(result._tag).toBe("err");
  if (result._tag === "err") {
    expect(result.error._tag).toBe("SkillToggleStateError");
    expect(result.error.operation).toBe(operation);
  }
}

function testContext(options: SkillToggleStoreOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-skill-toggle-"));
  temporaryDirectories.push(directory);
  const statePath = join(directory, "state", "pi-skill-toggle.json");
  return { directory, statePath, store: new SkillToggleStore(statePath, options) };
}

function resource(
  path: string,
  label: string,
  origin: "global" | "project" = "project",
  editability: ToggleResource["editability"] = "editable",
): ToggleResource {
  return {
    id: resourcePathId(path),
    kind: "skill",
    origin,
    owner: resourcePathId(dirname(dirname(path))),
    label,
    description: label,
    editability,
    order: 0,
  };
}

function loaded(result: SkillToggleStateResult): SkillToggleState {
  expect(result._tag).toBe("ok");
  if (result._tag === "err") throw result.error;
  return result.value;
}

describe("SkillToggleStore", () => {
  test("stores enabled project resources by path and preserves same-named resources independently", () => {
    const context = testContext();
    const firstPath = join(context.directory, "client-a", "deploy", "SKILL.md");
    const secondPath = join(context.directory, "client-b", "deploy", "SKILL.md");
    mkdirSync(dirname(firstPath), { recursive: true });
    mkdirSync(dirname(secondPath), { recursive: true });
    writeFileSync(firstPath, "first");
    writeFileSync(secondPath, "second");
    const first = resource(firstPath, "deploy");
    const second = resource(secondPath, "deploy");

    loaded(context.store.setValue(first, "enabled", [first, second]));
    const state = loaded(context.store.setValue(second, "enabled", [first, second]));

    expect(Object.keys(state.resources)).toEqual([firstPath, secondPath]);
  });

  test("rejects invalid runtime toggle values", () => {
    const context = testContext();
    const path = join(context.directory, "invalid", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "skill");

    // SAFETY: Reflect.apply intentionally bypasses the static input type to test runtime validation.
    const result = Reflect.apply(context.store.setValue, context.store, [
      resource(path, "invalid"),
      "unexpected",
    ]) as SkillToggleStateResult;

    expectFailure(result, "update");
    expect(context.store.load()).toMatchObject({ _tag: "ok", value: { resources: {} } });
  });

  test("cleanup removes missing paths while retaining every existing setting", () => {
    const context = testContext();
    const retainedPath = join(context.directory, "retained", "SKILL.md");
    const removedPath = join(context.directory, "removed", "SKILL.md");
    mkdirSync(dirname(retainedPath), { recursive: true });
    mkdirSync(dirname(removedPath), { recursive: true });
    writeFileSync(retainedPath, "retained");
    writeFileSync(removedPath, "removed");
    const retained = resource(retainedPath, "same-name");
    const removed = resource(removedPath, "same-name");
    loaded(context.store.setValue(retained, "enabled", [retained, removed]));
    loaded(context.store.setValue(removed, "enabled", [retained, removed]));

    rmSync(removedPath);
    const state = loaded(context.store.load([retained]));

    expect(Object.keys(state.resources)).toEqual([retainedPath]);
    expect(state.resources[retainedPath]).toMatchObject({ enabled: true });
  });

  test("project defaults and manual-only updates remove persisted overrides", () => {
    const context = testContext();
    const path = join(context.directory, "toggle", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "toggle");
    const editable = resource(path, "toggle");
    loaded(context.store.setValue(editable, "enabled", [editable]));

    expect(loaded(context.store.setValue(editable, "disabled", [editable])).resources).toEqual({});
    loaded(context.store.setValue(editable, "enabled", [editable]));
    const locked = resource(path, "toggle", "project", "manual-only");

    expect(loaded(context.store.setValue(locked, "enabled", [locked])).resources).toEqual({});
  });

  test("removes an override when changed metadata makes it the default", () => {
    const context = testContext();
    const path = join(context.directory, "moved", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "moved");
    const global = resource(path, "moved", "global");
    loaded(context.store.setValue(global, "disabled", [global]));
    const project = resource(path, "moved", "project");

    expect(loaded(context.store.load([project])).resources).toEqual({});
  });

  test("source-authored manual-only skills cannot retain an extension override", () => {
    const context = testContext();
    const path = join(context.directory, "manual", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "manual");
    const editable = resource(path, "manual");
    loaded(context.store.setValue(editable, "enabled", [editable]));

    const locked = resource(path, "manual", "project", "manual-only");
    const state = loaded(context.store.load([locked]));

    expect(state.resources).toEqual({});
  });

  test("discards pre-v4 state instead of carrying layered policy forward", () => {
    const context = testContext();
    mkdirSync(dirname(context.statePath), { recursive: true });
    writeFileSync(
      context.statePath,
      JSON.stringify({
        version: 3,
        globalSkillPolicy: { research: "manual-only" },
      }),
    );

    expect(loaded(context.store.load()).resources).toEqual({});
    expect(JSON.parse(readFileSync(context.statePath, "utf8"))).toEqual({
      version: 5,
      resources: {},
    });
  });

  test("migrates version 4 while dropping project-skill disables that are now defaults", () => {
    const context = testContext();
    const globalPath = join(context.directory, "global", "SKILL.md");
    const projectPath = join(context.directory, "project", "SKILL.md");
    mkdirSync(dirname(globalPath), { recursive: true });
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(globalPath, "global");
    writeFileSync(projectPath, "project");
    const global = resource(globalPath, "global", "global");
    const project = resource(projectPath, "project");
    mkdirSync(dirname(context.statePath), { recursive: true });
    writeFileSync(
      context.statePath,
      JSON.stringify({
        version: 4,
        resources: {
          [globalPath]: { kind: "skill", origin: "global", owner: global.owner, enabled: false },
          [projectPath]: {
            kind: "skill",
            origin: "project",
            owner: project.owner,
            enabled: false,
          },
        },
      }),
    );

    const migrated = loaded(context.store.load([global, project]));

    expect(migrated).toEqual({
      version: 5,
      resources: {
        [globalPath]: { kind: "skill", origin: "global", owner: global.owner, enabled: false },
      },
    });
  });

  test("returns malformed state as a typed failure without replacing it", () => {
    const context = testContext();
    mkdirSync(dirname(context.statePath), { recursive: true });
    writeFileSync(context.statePath, "{broken");

    const result = context.store.load();

    expectFailure(result, "load");
    expect(readFileSync(context.statePath, "utf8")).toBe("{broken");
  });

  test("rejects unsupported versions and every malformed persisted resource field", () => {
    const malformedStates: ReadonlyArray<unknown> = [
      null,
      [],
      {},
      { version: 5 },
      { version: 5, resources: [] },
      { version: 6, resources: {} },
      { version: 5, resources: { "/skill": null } },
      {
        version: 5,
        resources: {
          "/skill": { kind: "other", origin: "global", owner: "/", enabled: false },
        },
      },
      {
        version: 5,
        resources: {
          "/skill": { kind: "skill", origin: "other", owner: "/", enabled: false },
        },
      },
      {
        version: 5,
        resources: {
          "/skill": { kind: "skill", origin: "global", owner: 1, enabled: false },
        },
      },
      {
        version: 5,
        resources: {
          "/skill": { kind: "skill", origin: "global", owner: "/", enabled: "yes" },
        },
      },
      {
        version: 4,
        resources: {
          "/skill": { kind: "skill", origin: "global", owner: "/", enabled: true },
        },
      },
    ];

    for (const malformed of malformedStates) {
      const context = testContext();
      mkdirSync(dirname(context.statePath), { recursive: true });
      writeFileSync(context.statePath, JSON.stringify(malformed));

      expectFailure(context.store.load(), "load");
      expect(JSON.parse(readFileSync(context.statePath, "utf8"))).toEqual(malformed);
    }
  });

  test("recovers abandoned and stale invalid state locks", () => {
    const abandoned = testContext({ lockTimeoutMs: 100 });
    mkdirSync(dirname(abandoned.statePath), { recursive: true });
    writeFileSync(`${abandoned.statePath}.lock`, "999999\n");

    expect(loaded(abandoned.store.load())).toEqual({ version: 5, resources: {} });

    const stale = testContext({ lockTimeoutMs: 100, staleLockMs: 1 });
    mkdirSync(dirname(stale.statePath), { recursive: true });
    const staleLockPath = `${stale.statePath}.lock`;
    writeFileSync(staleLockPath, "not-a-pid\n");
    const old = new Date(0);
    utimesSync(staleLockPath, old, old);

    expect(loaded(stale.store.load())).toEqual({ version: 5, resources: {} });
  });

  test("does not remove active or fresh invalid state locks", () => {
    const cases = [
      { contents: `${process.pid}\n`, staleLockMs: 0 },
      { contents: "not-a-pid\n", staleLockMs: 60_000 },
    ];

    for (const lock of cases) {
      const context = testContext({ lockTimeoutMs: 0, staleLockMs: lock.staleLockMs });
      mkdirSync(dirname(context.statePath), { recursive: true });
      const lockPath = `${context.statePath}.lock`;
      writeFileSync(lockPath, lock.contents);

      expectFailure(context.store.load(), "load");
      expect(readFileSync(lockPath, "utf8")).toBe(lock.contents);
    }
  });

  test("reports atomic replacement failures and removes temporary files", () => {
    const context = testContext({
      beforeRename: () => {
        throw new Error("injected rename failure");
      },
    });
    const path = join(context.directory, "skill", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "skill");

    const result = context.store.setValue(resource(path, "skill"), "disabled");

    expectFailure(result, "update");
    expect(readdirSync(dirname(context.statePath)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });
});
