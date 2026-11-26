import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { cacheDebugValue } from "../cache-debug";
import { resourcePathId } from "../resource-path";
import { ToggleStateFile, ToggleStateInvalidJson } from "../state";
import type { ToggleStateError, ToggleStateResult } from "../state";
import { noteView, TOGGLE_NOTE_TYPE } from "../toggle-note";

const directories: Array<string> = [];

function writeState(path: string, overrides: Readonly<Record<string, string>>): string {
  const text = `${JSON.stringify({ version: 7, files: overrides, repositories: {} }, null, 2)}\n`;
  writeFileSync(path, text);

  return text;
}

function noteMessage(customType: string) {
  const value = { role: "custom", customType, details: { version: 1, visible: ["/a"] } };

  return value;
}

function failure(result: ToggleStateResult): ToggleStateError {
  if (Result.isSuccess(result)) {
    throw new Error("expected the state operation to fail");
  }

  return result.failure;
}

function agentDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pi-skills-rename-"));
  directories.push(directory);
  const current = join(directory, "pi-skills.json");
  const legacy = join(directory, "pi-skill-toggle.json");

  const resource = (name: string) => {
    mkdirSync(join(directory, "skills", name), { recursive: true });
    const path = join(directory, "skills", name, "SKILL.md");
    writeFileSync(path, name);

    return resourcePathId(path, directory);
  };

  return { directory, current, legacy, resource, store: new ToggleStateFile(current) };
}

function loaded(result: ToggleStateResult): Record<string, string> {
  if (Result.isFailure(result)) {
    throw result.failure;
  }

  return Object.fromEntries(result.success.files);
}

describe("renamed names", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("state file rename", () => {
    test("the new file wins and the old one is ignored, even when it is invalid", () => {
      const agent = agentDirectory();
      const skill = agent.resource("a");
      writeState(agent.current, { [skill]: "enabled" });
      writeState(agent.legacy, { [skill]: "disabled" });

      expect(loaded(agent.store.load())).toStrictEqual({ [skill]: "enabled" });
      writeFileSync(agent.legacy, "{");
      expect(loaded(agent.store.load())).toStrictEqual({ [skill]: "enabled" });
    });

    test("only the old file: it is read, and the next save creates the new file and leaves the old one", () => {
      const agent = agentDirectory();
      const kept = agent.resource("kept");
      const added = agent.resource("added");
      const legacyText = writeState(agent.legacy, { [kept]: "disabled" });

      expect(loaded(agent.store.load())).toStrictEqual({ [kept]: "disabled" });
      expect(existsSync(agent.current)).toBe(false);

      expect(loaded(agent.store.set(added, "enabled"))).toStrictEqual({
        [kept]: "disabled",
        [added]: "enabled",
      });
      expect(readFileSync(agent.legacy, "utf8")).toBe(legacyText);
      expect(JSON.parse(readFileSync(agent.current, "utf8"))).toMatchObject({
        files: { [kept]: "disabled", [added]: "enabled" },
      });
      expect(loaded(new ToggleStateFile(agent.current).load())).toStrictEqual({
        [kept]: "disabled",
        [added]: "enabled",
      });
    });

    test("clearing an old choice saves an empty new file that then hides the old one", () => {
      const agent = agentDirectory();
      const skill = agent.resource("a");
      const legacyText = writeState(agent.legacy, { [skill]: "disabled" });

      expect(loaded(agent.store.set(skill, "default"))).toStrictEqual({});
      expect(loaded(agent.store.load())).toStrictEqual({});
      expect(readFileSync(agent.legacy, "utf8")).toBe(legacyText);
    });

    test("neither file: the state is empty and nothing is created", () => {
      const agent = agentDirectory();

      expect(loaded(agent.store.load())).toStrictEqual({});
      expect(readdirSync(agent.directory)).toStrictEqual([]);
    });

    test("an invalid old file is reported with its own path and is not rewritten", () => {
      const agent = agentDirectory();
      writeFileSync(agent.legacy, "{");
      const error = failure(agent.store.load());

      expect(error).toBeInstanceOf(ToggleStateInvalidJson);
      expect(error.path).toBe(agent.legacy);
      expect(failure(agent.store.set(agent.resource("a"), "enabled")).path).toBe(agent.legacy);
      expect(readFileSync(agent.legacy, "utf8")).toBe("{");
      expect(existsSync(agent.current)).toBe(false);
    });
  });

  describe("toggle note type rename", () => {
    test("notes use the new type and old notes are still recognised", () => {
      expect(TOGGLE_NOTE_TYPE).toBe("skills");
      expect(noteView(noteMessage("skills"))).toStrictEqual(new Set(["/a"]));
      expect(noteView(noteMessage("pi-skill-toggle"))).toStrictEqual(new Set(["/a"]));
      expect(noteView(noteMessage("pi-skills"))).toBeUndefined();
    });
  });

  describe("cache debug variable rename", () => {
    test("PI_SKILLS_CACHE_DEBUG wins and the old name is the fallback", () => {
      expect(cacheDebugValue({})).toBeUndefined();
      expect(cacheDebugValue({ PI_SKILL_TOGGLE_CACHE_DEBUG: "1" })).toBe("1");
      expect(
        cacheDebugValue({ PI_SKILLS_CACHE_DEBUG: "/x", PI_SKILL_TOGGLE_CACHE_DEBUG: "1" }),
      ).toBe("/x");
      expect(
        cacheDebugValue({ PI_SKILLS_CACHE_DEBUG: "0", PI_SKILL_TOGGLE_CACHE_DEBUG: "1" }),
      ).toBe("0");
    });
  });
});
