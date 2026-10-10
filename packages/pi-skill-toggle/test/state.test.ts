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
import {
  ToggleStateFile,
  ToggleStateInvalidJson,
  ToggleStateMalformed,
  ToggleStateTooNew,
} from "../state";
import type { ToggleStateError, ToggleStateResult } from "../state";

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

/** The failure of a state result, which must have failed. */
function failureOf(result: ToggleStateResult): ToggleStateError {
  if (result._tag === "ok") {
    throw new Error("expected the state operation to fail");
  }
  return result.error;
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

  test.each<
    readonly [
      string,
      unknown,
      typeof ToggleStateInvalidJson | typeof ToggleStateTooNew | typeof ToggleStateMalformed,
    ]
  >([
    ["invalid JSON", "{broken", ToggleStateInvalidJson],
    ["empty file", "", ToggleStateInvalidJson],
    ["null", null, ToggleStateMalformed],
    ["array", [], ToggleStateMalformed],
    ["no version", {}, ToggleStateMalformed],
    ["string version", { version: "6", overrides: {} }, ToggleStateMalformed],
    ["missing overrides", { version: 6 }, ToggleStateMalformed],
    ["array overrides", { version: 6, overrides: [] }, ToggleStateMalformed],
    ["fractional version", { version: 4.5, overrides: {} }, ToggleStateMalformed],
    ["newer version", { version: 7, overrides: {} }, ToggleStateTooNew],
    ["unknown value", { version: 6, overrides: { "/skill": "sometimes" } }, ToggleStateMalformed],
    ["null value", { version: 6, overrides: { "/skill": null } }, ToggleStateMalformed],
    [
      "relative path",
      { version: 6, overrides: { "relative/SKILL.md": "enabled" } },
      ToggleStateMalformed,
    ],
    ["NUL in path", { version: 6, overrides: { "/a\u0000b": "enabled" } }, ToggleStateMalformed],
    ["null v5 entry", { version: 5, resources: { "/skill": null } }, ToggleStateMalformed],
    [
      "bad v5 flag",
      { version: 5, resources: { "/skill": { enabled: "yes" } } },
      ToggleStateMalformed,
    ],
  ])("returns %s as a typed failure without replacing the file", (_name, malformed, errorClass) => {
    const context = testContext();
    context.writeState(malformed);
    const before = readFileSync(context.statePath, "utf8");

    expect(failureOf(context.store.load())).toBeInstanceOf(errorClass);
    expect(failureOf(context.store.set(context.resourceFile("skill"), "disabled"))).toBeInstanceOf(
      errorClass,
    );
    expect(readFileSync(context.statePath, "utf8")).toBe(before);
  });

  test("tells the user exactly what is wrong with the file", () => {
    const context = testContext();
    const messageFor = (state: unknown): string => {
      context.writeState(state);
      return failureOf(context.store.load()).message;
    };

    expect(messageFor("{broken")).toBe(
      `Pi skill-toggle state at ${context.statePath} is not valid JSON. Fix the file, or remove it to reset all toggles.`,
    );
    expect(messageFor({ version: 9, overrides: {} })).toBe(
      `Pi skill-toggle state at ${context.statePath} was written by a newer pi-skill-toggle (state version 9; this version reads up to 6). Update pi-skill-toggle, or remove the file to reset all toggles.`,
    );
    expect(messageFor({ version: 6, overrides: { "/skill": "sometimes" } })).toBe(
      `Pi skill-toggle state at ${context.statePath} has an invalid entry for /skill. Fix or remove that entry, or remove the file to reset all toggles.`,
    );
    expect(messageFor({ version: 6 })).toBe(
      `Pi skill-toggle state at ${context.statePath} does not have the expected structure. Fix the file, or remove it to reset all toggles.`,
    );
  });

  test("surfaces unreadable state instead of treating it as empty", () => {
    const context = testContext();
    mkdirSync(context.statePath, { recursive: true });

    const loadFailure = failureOf(context.store.load());
    expect(loadFailure).toMatchObject({
      _tag: "ToggleStateUnavailable",
      operation: "load",
      code: "EISDIR",
    });
    expect(loadFailure.message).toBe(
      `Could not load Pi skill-toggle state at ${context.statePath}: the path is a folder, not a file. Move the folder away.`,
    );
    expect(failureOf(context.store.set(context.resourceFile("skill"), "disabled"))).toMatchObject({
      _tag: "ToggleStateUnavailable",
      operation: "update",
      code: "EISDIR",
    });
  });

  test("propagates a bug instead of reporting it as a state failure", () => {
    // SAFETY: Deliberately invalid input; a NUL byte makes Node throw a TypeError (a defect).
    const store = new ToggleStateFile(`${tmpdir()}/bad\0path.json`);

    expect(() => store.load()).toThrow(TypeError);
    expect(() => store.set(resourcePathId("/skill", "/"), "disabled")).toThrow(TypeError);
  });

  test("reports write failures and leaves no temporary files", () => {
    const context = testContext();
    const stateDirectory = dirname(context.statePath);
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o500);

    try {
      const failure = failureOf(context.store.set(context.resourceFile("skill"), "disabled"));
      expect(failure).toMatchObject({
        _tag: "ToggleStateUnavailable",
        operation: "update",
        code: "EACCES",
      });
      expect(failure.message).toContain("permission was denied");
      expect(readdirSync(stateDirectory)).toStrictEqual([]);
    } finally {
      chmodSync(stateDirectory, 0o700);
    }
  });
});
