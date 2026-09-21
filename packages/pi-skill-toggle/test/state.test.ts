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
import { type ResourcePath, resourcePathId } from "../resource-path";
import type { ToggleOverrides } from "../resources";
import { ToggleStateFile, type ToggleStateResult } from "../state";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
  if (result._tag === "err") throw result.error;
  return result.value;
}

function expectFailure(result: ToggleStateResult, operation: "load" | "update"): void {
  expect(result).toMatchObject({ _tag: "err", error: { _tag: "ToggleStateError", operation } });
}

describe("ToggleStateFile", () => {
  test("a missing file is an empty state and loading never creates it", () => {
    const context = testContext();

    expect(overrides(context.store.load())).toEqual(new Map());
    expect(readdirSync(context.directory)).toEqual([]);
  });

  test("persists overrides by path, sorted, in a private file", () => {
    const context = testContext();
    const second = context.resourceFile("b");
    const first = context.resourceFile("a");

    overrides(context.store.set(second, "enabled"));
    const saved = overrides(context.store.set(first, "disabled"));

    expect([...saved]).toEqual([
      [second, "enabled"],
      [first, "disabled"],
    ]);
    expect(overrides(new ToggleStateFile(context.statePath).load())).toEqual(saved);
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

    expect([...overrides(context.store.set(cleared, "default"))]).toEqual([[kept, "enabled"]]);
  });

  test("keeps toggles written by another session between two updates", () => {
    const context = testContext();
    const mine = context.resourceFile("mine");
    const theirs = context.resourceFile("theirs");
    overrides(context.store.set(mine, "disabled"));
    overrides(new ToggleStateFile(context.statePath).set(theirs, "enabled"));

    const saved = overrides(context.store.set(mine, "default"));

    expect([...saved]).toEqual([[theirs, "enabled"]]);
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
    expect([...overrides(context.store.set(other, "disabled")).keys()]).toEqual([retained, other]);
  });

  test("reads version 4 and 5 state and rewrites it as version 6 on the next update", () => {
    for (const version of [4, 5]) {
      const context = testContext();
      const disabled = context.resourceFile("disabled");
      const enabled = context.resourceFile("enabled");
      const entry = { kind: "skill", origin: "global", owner: context.directory };
      context.writeState({
        version,
        resources: {
          [disabled]: { ...entry, enabled: false },
          ...(version === 5 ? { [enabled]: { ...entry, origin: "project", enabled: true } } : {}),
        },
      });

      const loaded = overrides(context.store.load());
      expect(loaded.get(disabled)).toBe("disabled");
      expect(loaded.get(enabled)).toBe(version === 5 ? "enabled" : undefined);

      overrides(context.store.set(disabled, "default"));
      expect(JSON.parse(readFileSync(context.statePath, "utf8"))).toEqual({
        version: 6,
        overrides: version === 5 ? { [enabled]: "enabled" } : {},
      });
    }
  });

  test("discards name-keyed state from before version 4", () => {
    const context = testContext();
    context.writeState({ version: 3, globalSkillPolicy: { research: "manual-only" } });

    expect(overrides(context.store.load())).toEqual(new Map());
  });

  test("returns malformed and unsupported state as a typed failure without replacing it", () => {
    const malformedStates: ReadonlyArray<unknown> = [
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

      expectFailure(context.store.load(), "load");
      expectFailure(context.store.set(context.resourceFile("skill"), "disabled"), "update");
      expect(readFileSync(context.statePath, "utf8")).toBe(before);
    }
  });

  test("surfaces unreadable state instead of treating it as empty", () => {
    const context = testContext();
    mkdirSync(context.statePath, { recursive: true });

    expectFailure(context.store.load(), "load");
    expectFailure(context.store.set(context.resourceFile("skill"), "disabled"), "update");
  });

  test("reports write failures and leaves no temporary files", () => {
    const context = testContext();
    const stateDirectory = dirname(context.statePath);
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);

    try {
      expectFailure(context.store.set(context.resourceFile("skill"), "disabled"), "update");
      expect(readdirSync(stateDirectory)).toEqual([]);
    } finally {
      chmodSync(stateDirectory, 0o700);
    }
  });
});
