import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseResourcePath, resourcePathId } from "../resource-path";

describe("resource paths", () => {
  test("resolves relative paths and relative working directories using platform semantics", () => {
    const cwd = join("project", "nested");
    const path = join("..", "skills", "SKILL.md");
    const id = resourcePathId(path, cwd);

    expect(id).toBe(resolve(cwd, path));
    expect(parseResourcePath(id)).toBe(id);
  });

  test("normalizes absolute persisted paths", () => {
    const path = `${resolve("skills")}/../other//SKILL.md`;

    expect(parseResourcePath(path)).toBe(resolve(path));
    expect(resourcePathId(path, "elsewhere")).toBe(resolve(path));
  });

  test.each(["", "relative/SKILL.md", `relative\0path`, `${tmpdir()}/bad\0path`])(
    "rejects unusable persisted input %j without throwing",
    (path) => {
      expect(parseResourcePath(path)).toBeUndefined();
    },
  );

  test("constructing a NUL-bearing identity violates the constructor invariant", () => {
    expect(() => resourcePathId("bad\0path", tmpdir())).toThrow("Schema validation failed");
    expect(() => resourcePathId("relative", `${tmpdir()}/bad\0cwd`)).toThrow(
      "Schema validation failed",
    );
  });

  test("does not dereference symlinks", () => {
    const directory = mkdtempSync(join(tmpdir(), "resource-path-"));
    try {
      const target = join(directory, "target");
      const link = join(directory, "link");
      mkdirSync(target);
      symlinkSync(target, link);
      const path = join(link, "SKILL.md");

      expect(resourcePathId(path, directory)).toBe(path);
      expect(parseResourcePath(path)).toBe(path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
