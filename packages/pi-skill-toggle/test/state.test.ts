import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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

function overrides(result: ToggleStateResult): ToggleOverrides["files"] {
  if (result._tag === "err") {
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value.files;
}

function failureOrValue(result: ToggleStateResult): ToggleOverrides {
  if (result._tag === "err") {
    throw new Error(result.error.message, { cause: result.error });
  }
  return result.value;
}

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
      `${JSON.stringify({ version: 7, files: { [first]: "disabled", [second]: "enabled" }, repositories: {} }, null, 2)}\n`,
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

  test("preserves an unverifiable ELOOP entry while updating an accessible resource", () => {
    const context = testContext();
    const accessible = context.resourceFile("accessible");
    const loop = join(context.directory, "loop");
    symlinkSync("loop", loop);
    const unverifiable = resourcePathId(join(loop, "SKILL.md"), context.directory);
    context.writeState({ version: 7, repositories: {}, files: { [unverifiable]: "enabled" } });

    const saved = overrides(context.store.set(accessible, "disabled"));

    expect([...saved]).toStrictEqual([
      [unverifiable, "enabled"],
      [accessible, "disabled"],
    ]);
    expect(JSON.parse(readFileSync(context.statePath, "utf8"))).toStrictEqual({
      version: 7,
      repositories: {},
      files: { [accessible]: "disabled", [unverifiable]: "enabled" },
    });
  });

  test.each([4, 5])(
    "reads version %i state and rewrites it as version 7 on the next update",
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
        version: 7,
        repositories: {},
        files: {},
      });
    },
  );

  test.each([4, 5])(
    "keeps enabled version %i entries when rewriting them as version 7",
    (version) => {
      const context = testContext();
      const disabled = context.resourceFile("disabled");
      const enabled = context.resourceFile("enabled");
      const entry = { kind: "skill", origin: "global", owner: context.directory };
      context.writeState({
        version,
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
        version: 7,
        repositories: {},
        files: { [enabled]: "enabled" },
      });
    },
  );

  test.each([1, 2, 3])(
    "discards name-keyed version %i state without rewriting on load",
    (version) => {
      const context = testContext();
      context.writeState({ version, globalSkillPolicy: { research: "manual-only" } });
      const before = readFileSync(context.statePath, "utf8");

      expect(overrides(context.store.load())).toStrictEqual(new Map());
      expect(readFileSync(context.statePath, "utf8")).toBe(before);

      const enabled = context.resourceFile("enabled");
      overrides(context.store.set(enabled, "enabled"));
      expect(JSON.parse(readFileSync(context.statePath, "utf8"))).toStrictEqual({
        version: 7,
        repositories: {},
        files: { [enabled]: "enabled" },
      });
    },
  );

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
    ["array overrides", { version: 7, repositories: {}, files: [] }, ToggleStateMalformed],
    ["fractional version", { version: 4.5, overrides: {} }, ToggleStateMalformed],
    ["newer version", { version: 8, overrides: {} }, ToggleStateTooNew],
    [
      "unknown value",
      { version: 7, repositories: {}, files: { "/skill": "sometimes" } },
      ToggleStateMalformed,
    ],
    [
      "null value",
      { version: 7, repositories: {}, files: { "/skill": null } },
      ToggleStateMalformed,
    ],
    [
      "relative path",
      { version: 7, repositories: {}, files: { "relative/SKILL.md": "enabled" } },
      ToggleStateMalformed,
    ],
    [
      "NUL in path",
      { version: 7, repositories: {}, files: { "/a\u0000b": "enabled" } },
      ToggleStateMalformed,
    ],
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
      `Pi skill-toggle state at ${context.statePath} was written by a newer pi-skill-toggle (state version 9; this version reads up to 7). Update pi-skill-toggle, or remove the file to reset all toggles.`,
    );
    expect(messageFor({ version: 7, repositories: {}, files: { "/skill": "sometimes" } })).toBe(
      `Pi skill-toggle state at ${context.statePath} has an invalid entry for /skill. Fix or remove that entry, or remove the file to reset all toggles.`,
    );
    expect(messageFor({ version: 6 })).toBe(
      `Pi skill-toggle state at ${context.statePath} does not have the expected structure. Fix the file, or remove it to reset all toggles.`,
    );
  });

  test.each<readonly [string, Record<string, unknown>, string]>([
    [
      "absolute file paths",
      { files: { "/x/SKILL.md": "enabled", "/x/./SKILL.md": "disabled" }, repositories: {} },
      "/x/./SKILL.md",
    ],
    [
      "repository keys",
      {
        files: {},
        repositories: { "/x/.git": { "a.md": "enabled" }, "/x/.git/": { "b.md": "disabled" } },
      },
      "/x/.git/",
    ],
    [
      "repository-relative paths",
      {
        files: {},
        repositories: { "/x/.git": { "AGENTS.md": "enabled", "AGENTS.md/": "disabled" } },
      },
      "AGENTS.md/",
    ],
  ])("reports duplicate %s after normalization instead of keeping one", (_kind, policy, key) => {
    const context = testContext();
    context.writeState({ version: 7, ...policy });
    const before = readFileSync(context.statePath, "utf8");

    const failure = failureOf(context.store.load());
    expect(failure).toBeInstanceOf(ToggleStateMalformed);
    expect(failure).toMatchObject({ entry: key });
    expect(failure.message).toContain(`has an invalid entry for ${key}.`);
    expect(failureOf(context.store.set(context.resourceFile("skill"), "disabled"))).toBeInstanceOf(
      ToggleStateMalformed,
    );
    expect(readFileSync(context.statePath, "utf8")).toBe(before);
  });

  test("accepts a lone trailing-slash repository path as its bare spelling", () => {
    const context = testContext();
    context.writeState({
      version: 7,
      files: {},
      repositories: { "/x/.git/": { "nested/AGENTS.md/": "disabled" } },
    });

    const loaded = failureOrValue(context.store.load());
    expect([...loaded.repositories]).toStrictEqual([
      ["/x/.git", new Map([["nested/AGENTS.md", "disabled"]])],
    ]);
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
