import { describe, expect, test } from "vitest";
import { isParallelBatch, isReadOnlyTool } from "../batch.ts";
import type { BatchCall } from "../batch.ts";

const SCRATCH = "/tmp/claude-1/-home-u-dev-x/0a1b/scratchpad";
const READ_ONLY: ReadonlySet<string> = new Set(["read", "ls"]);
const readOnly = (name: string): boolean => READ_ONLY.has(name);

const failing: BatchCall = { id: "r1", name: "read", args: { path: `${SCRATCH}/z5.png` } };
const missing = `ENOENT: no such file or directory, access '${SCRATCH}/z5.png'`;

function bash(id: string, command: string): BatchCall {
  return { id, name: "bash", args: { command } };
}

describe("isParallelBatch", () => {
  test.each([
    [
      "a sibling writes into the directory through a variable",
      [bash("b1", `S=${SCRATCH}; mkdir -p $S; for p in 5 25; do sips x --out $S/z$p.png; done`)],
      true,
    ],
    ["a sibling names the exact path", [bash("b1", `convert a.png ${SCRATCH}/z5.png`)], true],
    [
      "a sibling's nested arguments name the directory",
      [{ id: "e1", name: "edit", args: { edits: [{ newText: `out=${SCRATCH}` }] } }],
      true,
    ],
    [
      "a read-only sibling names the directory",
      [{ id: "l1", name: "ls", args: { path: SCRATCH } }],
      false,
    ],
    ["a sibling names a longer directory", [bash("b1", `mkdir -p ${SCRATCH}2`)], false],
    ["no sibling names the path", [bash("b1", "make all")], false],
    ["the failing call alone names the path", [], false],
  ])("is %s: %s", (_name, siblings, expected) => {
    expect(isParallelBatch(failing, missing, [failing, ...siblings], readOnly)).toBe(expected);
  });

  test("ignores errors that are not about a missing path", () => {
    const batch = [failing, bash("b1", `mkdir -p ${SCRATCH}`)];
    expect(
      isParallelBatch(failing, `EACCES: permission denied '${SCRATCH}/z5.png'`, batch, readOnly),
    ).toBe(false);
  });

  test("needs more than a top-level directory to match by directory", () => {
    const shallow: BatchCall = { id: "r1", name: "read", args: { path: "/tmp/a.png" } };
    const batch = [shallow, bash("b1", "cd /tmp && ls")];
    expect(isParallelBatch(shallow, "ENOENT: '/tmp/a.png'", batch, readOnly)).toBe(false);
  });
});

describe("isReadOnlyTool", () => {
  test.each([
    ["an unknown tool", undefined, false],
    ["Pi's read", { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } }, true],
    ["Pi's bash", { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } }, false],
    [
      "an extension tool named read",
      { name: "read", sourceInfo: { path: "/x.ts", source: "local" } },
      false,
    ],
    [
      "a tool marked read-only",
      {
        name: "webfetch",
        sourceInfo: { path: "/x.ts", source: "local" },
        annotations: { readOnlyHint: true },
      },
      true,
    ],
  ])("treats %s as read-only: %s", (_name, tool, expected) => {
    expect(isReadOnlyTool(tool)).toBe(expected);
  });
});
