import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resourcePathId } from "../resource-path";
import type { ResourcePath } from "../resource-path";
import type { ToggleOverrides } from "../resources";
import { ToggleStateFile } from "../state";
import type { ToggleStateResult } from "../state";

const temporaryDirectories: string[] = [];

function testContext() {
  const directory = mkdtempSync(join(tmpdir(), "pi-skill-toggle-"));
  temporaryDirectories.push(directory);
  const statePath = join(directory, "state", "pi-skill-toggle.json");
  const writeState = (state: unknown): void => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, typeof state === "string" ? state : JSON.stringify(state));
  };
  const resourceFile = (name: string): ResourcePath => {
    const path = join(directory, name, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, name);
    return resourcePathId(path, directory);
  };
  return { directory, statePath, writeState, resourceFile, store: new ToggleStateFile(statePath) };
}

function overrides(result: ToggleStateResult): ToggleOverrides {
  if (result._tag === "err") {
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value;
}

/** The shape of a state result that failed during `operation`. */
function stateFailure(operation: "load" | "update") {
  return { _tag: "err", error: { _tag: "ToggleStateError", operation } };
}

describe("toggleStateFile", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a missing file is an empty state and loading never creates it", () => {
    const context = testContext();

    expect(overrides(context.store.load())).toStrictEqual(new Map());
    expect(readdirSync(context.directory)).toStrictEqual([]);
  });

  test("persists overrides by path, sorted, in a private file", () => {
    const context = testContext();
    const second = context.resourceFile("b");
    const first = context.resourceFile("a");

    overrides(context.store.set(second, "enabled"));
    const saved = overrides(context.store.set(first, "disabled"));

    expect([...saved]).toStrictEqual([
      [second, "enabled"],
      [first, "disabled"],
    ]);
    expect(overrides(new ToggleStateFile(context.statePath).load())).toStrictEqual(saved);
    expect(readFileSync(context.statePath, "utf8")).toBe(
      `${JSON.stringify({ version: 6, overrides: { [first]: "disabled", [second]: "enabled" } }, null, 2)}\n`,
    );
    expect(statSync(context.statePath).mode & 0o777).toBe(0o600);
  });

  test("clears one override with default and keeps the others", () => {
    const context = testContext();
    const kept = context.resourceFile("kept");
    const cleared = context.resourceFile("cleared");
    overrides(context.store.set(kept, "enabled"));
    overrides(context.store.set(cleared, "enabled"));

    expect([...overrides(context.store.set(cleared, "default"))]).toStrictEqual([
      [kept, "enabled"],
    ]);
  });

  test("keeps toggles written by another session between two updates", () => {
    const context = testContext();
    const mine = context.resourceFile("mine");
    const theirs = context.resourceFile("theirs");
    overrides(context.store.set(mine, "disabled"));
    overrides(new ToggleStateFile(context.statePath).set(theirs, "enabled"));

    const saved = overrides(context.store.set(mine, "default"));

    expect([...saved]).toStrictEqual([[theirs, "enabled"]]);
  });

  test("updates drop entries whose file no longer exists, loads do not", () => {
    const context = testContext();
    const retained = context.resourceFile("retained");
    const removed = context.resourceFile("removed");
    const other = context.resourceFile("other");
    overrides(context.store.set(retained, "enabled"));
    overrides(context.store.set(removed, "enabled"));
    rmSync(removed);

    expect(overrides(context.store.load()).has(removed)).toBe(true);
    expect([...overrides(context.store.set(other, "disabled")).keys()]).toStrictEqual([
      retained,
      other,
    ]);
  });

  test.each([4, 5])(
    "reads version %i state and rewrites it as version 6 on the next update",
    (version) => {
      const context = testContext();
      const disabled = context.resourceFile("disabled");
      const enabled = context.resourceFile("enabled");
      const entry = { kind: "skill", origin: "global", owner: context.directory };
      context.writeState({ version, resources: { [disabled]: { ...entry, enabled: false } } });

      const loaded = overrides(context.store.load());
      expect(loaded.get(disabled)).toBe("disabled");
      expect(loaded.get(enabled)).toBeUndefined();

      overrides(context.store.set(disabled, "default"));
      expect(JSON.parse(readFileSync(context.statePath, "utf8"))).toStrictEqual({
        version: 6,
        overrides: {},
      });
    },
  );

  test("keeps enabled version 5 entries when rewriting them as version 6", () => {
    const context = testContext();
    const disabled = context.resourceFile("disabled");
    const enabled = context.resourceFile("enabled");
    const entry = { kind: "skill", origin: "global", owner: context.directory };
    context.writeState({
      version: 5,
      resources: {
        [disabled]: { ...entry, enabled: false },
        [enabled]: { ...entry, origin: "project", enabled: true },
      },
    });

    const loaded = overrides(context.store.load());
    expect(loaded.get(disabled)).toBe("disabled");
    expect(loaded.get(enabled)).toBe("enabled");

    overrides(context.store.set(disabled, "default"));
    expect(JSON.parse(readFileSync(context.statePath, "utf8"))).toStrictEqual({
      version: 6,
      overrides: { [enabled]: "enabled" },
    });
  });

  test("discards name-keyed state from before version 4", () => {
    const context = testContext();
    context.writeState({ version: 3, globalSkillPolicy: { research: "manual-only" } });

    expect(overrides(context.store.load())).toStrictEqual(new Map());
  });

  test("returns malformed and unsupported state as a typed failure without replacing it", () => {
    const malformedStates: readonly unknown[] = [
      "{broken",
      "",
      null,
      [],
      {},
      { version: "6", overrides: {} },
      { version: 6 },
      { version: 6, overrides: [] },
      { version: 7, overrides: {} },
      { version: 6, overrides: { "/skill": "sometimes" } },
      { version: 6, overrides: { "/skill": null } },
      { version: 6, overrides: { "relative/SKILL.md": "enabled" } },
      { version: 5, resources: { "/skill": null } },
      { version: 5, resources: { "/skill": { enabled: "yes" } } },
    ];

    for (const malformed of malformedStates) {
      const context = testContext();
      context.writeState(malformed);
      const before = readFileSync(context.statePath, "utf8");

      expect(context.store.load()).toMatchObject(stateFailure("load"));
      expect(context.store.set(context.resourceFile("skill"), "disabled")).toMatchObject(
        stateFailure("update"),
      );
      expect(readFileSync(context.statePath, "utf8")).toBe(before);
    }
  });

  test("surfaces unreadable state instead of treating it as empty", () => {
    const context = testContext();
    mkdirSync(context.statePath, { recursive: true });

    expect(context.store.load()).toMatchObject(stateFailure("load"));
    expect(context.store.set(context.resourceFile("skill"), "disabled")).toMatchObject(
      stateFailure("update"),
    );
  });

  test("reports write failures and leaves no temporary files", () => {
    const context = testContext();
    const stateDirectory = dirname(context.statePath);
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);

    try {
      expect(context.store.set(context.resourceFile("skill"), "disabled")).toMatchObject(
        stateFailure("update"),
      );
      expect(readdirSync(stateDirectory)).toStrictEqual([]);
    } finally {
      chmodSync(stateDirectory, 0o700);
    }
  });
});
