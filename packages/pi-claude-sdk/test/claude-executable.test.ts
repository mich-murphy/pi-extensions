import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  isBelowMinimumClaudeCode,
  MIN_CLAUDE_CODE_VERSION,
  resolveClaudeExecutable,
  tooOldClaudeCode,
} from "../sdk/claude-executable";

function file(path: string, mode: number): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, mode);
  return path;
}

describe("resolveClaudeExecutable", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claude-executable-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("uses an executable PI_CLAUDE_SDK_CLAUDE_PATH override without searching PATH", () => {
    const override = file(join(root, "custom", "claude-bin"), 0o755);
    const onPath = file(join(root, "bin", "claude"), 0o755);

    expect(
      resolveClaudeExecutable(
        { PI_CLAUDE_SDK_CLAUDE_PATH: ` ${override} `, PATH: join(onPath, "..") },
        "darwin",
      ),
    ).toBe(override);
  });

  test("treats a non-executable override as missing rather than searching PATH", () => {
    const override = file(join(root, "custom", "claude"), 0o644);
    const onPath = file(join(root, "bin", "claude"), 0o755);

    expect(
      resolveClaudeExecutable(
        { PI_CLAUDE_SDK_CLAUDE_PATH: override, PATH: join(onPath, "..") },
        "linux",
      ),
    ).toBeUndefined();
  });

  test("returns the first executable claude on PATH, skipping empty and non-executable entries", () => {
    file(join(root, "a", "claude"), 0o644);
    mkdirSync(join(root, "b", "claude"), { recursive: true });
    const expected = file(join(root, "c", "claude"), 0o755);
    file(join(root, "d", "claude"), 0o755);
    const path = ["", join(root, "a"), join(root, "b"), join(root, "c"), join(root, "d")].join(
      delimiter,
    );

    expect(resolveClaudeExecutable({ PATH: path, PI_CLAUDE_SDK_CLAUDE_PATH: "" }, "darwin")).toBe(
      expected,
    );
  });

  test("returns undefined when nothing is found", () => {
    expect(resolveClaudeExecutable({ PATH: join(root, "missing") }, "darwin")).toBeUndefined();
    expect(resolveClaudeExecutable({}, "linux")).toBeUndefined();
  });

  test("searches PATHEXT names on Windows", () => {
    const expected = file(join(root, "win", "claude.exe"), 0o644);

    expect(resolveClaudeExecutable({ PATH: join(root, "win"), PATHEXT: ".EXE" }, "win32")).toBe(
      expected,
    );
    expect(resolveClaudeExecutable({ PATH: join(root, "win") }, "win32")).toBe(expected);
  });
});

describe("Claude Code minimum version", () => {
  test("compares numerically against the minimum", () => {
    expect(isBelowMinimumClaudeCode("2.1.316 (Claude Code)")).toBe(true);
    expect(isBelowMinimumClaudeCode("2.0.999")).toBe(true);
    expect(isBelowMinimumClaudeCode(MIN_CLAUDE_CODE_VERSION)).toBe(false);
    expect(isBelowMinimumClaudeCode("2.1.1000")).toBe(false);
    expect(isBelowMinimumClaudeCode("3.0.0")).toBe(false);
  });

  test("does not reject an unparseable version", () => {
    expect(isBelowMinimumClaudeCode("unknown")).toBe(false);
  });

  test("reports a too-old version only from a system/init message", () => {
    const init = { type: "system", subtype: "init", claude_code_version: "2.1.316" };

    expect(tooOldClaudeCode(init)).toBe("2.1.316");
    expect(tooOldClaudeCode({ ...init, claude_code_version: "2.1.317" })).toBeUndefined();
    expect(tooOldClaudeCode({ ...init, claude_code_version: 2 })).toBeUndefined();
    expect(tooOldClaudeCode({ ...init, subtype: "status" })).toBeUndefined();
    expect(tooOldClaudeCode({ type: "assistant" })).toBeUndefined();
    expect(tooOldClaudeCode(null)).toBeUndefined();
  });
});
