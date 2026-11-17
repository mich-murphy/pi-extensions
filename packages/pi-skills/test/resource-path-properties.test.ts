import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { parseResourcePath, pathIsInsideOrEqual, resourcePathId } from "../resource-path";
import { assertProperty } from "./hegel-property";

/** A path segment that is never `.` or `..`; `..foo` is a legal name, not a parent reference. */
const segment = gs.oneOf(
  gs.text({ alphabet: "abc.", minSize: 1, maxSize: 3 }).map((text) => `s${text}`),
  gs.just("..foo"),
);
const segments = gs.arrays(segment, { maxSize: 4 });
const absolute = gs.text({ alphabet: "/.ab", maxSize: 12 }).map((text) => `/${text}`);

function assertContainment(parent: string, first: string[], second: string[]): void {
  const middle = join(parent, ...first);
  const leaf = join(middle, ...second);
  for (const [path, of] of [
    [parent, parent],
    [middle, parent],
    [leaf, middle],
    [leaf, parent],
  ] as const) {
    assert.ok(pathIsInsideOrEqual(path, of), `${path} inside ${of}`);
  }
  if (first.length > 0) {
    assert.ok(!pathIsInsideOrEqual(parent, middle), "a parent is not inside its child");
  }
}

function assertParses(raw: string, cwd: string): void {
  const parsed = parseResourcePath(raw);
  assert.equal(parsed, resolve(raw));
  assert.equal(parseResourcePath(parsed ?? ""), parsed);
  assert.equal(resourcePathId(raw, cwd), resolve(raw));
}

function assertNul(prefix: string, suffix: string): void {
  const path = `${prefix}\0${suffix}`;
  assert.equal(parseResourcePath(path), undefined);
  assert.throws(() => resourcePathId(path, "/"));
}

describe("resource path properties", () => {
  test("containment is reflexive, transitive and consistent with join", () => {
    assertProperty(
      "resource-path",
      "containment is reflexive, transitive and consistent with join",
      (tc) => {
        const parent = join("/", ...tc.draw(segments, "parent"));
        assertContainment(parent, tc.draw(segments, "first"), tc.draw(segments, "second"));
      },
    );
  });

  test("a sibling prefix is outside but a ..name segment is inside", () => {
    assertProperty(
      "resource-path",
      "a sibling prefix is outside but a ..name segment is inside",
      (tc) => {
        const parent = join("/", ...tc.draw(segments, "base"), "b");
        assert.ok(!pathIsInsideOrEqual(`${parent}c`, parent));
        assert.ok(pathIsInsideOrEqual(join(parent, "..foo"), parent));
        assert.ok(pathIsInsideOrEqual(join(parent, "..foo", "x"), parent));
        assert.ok(!pathIsInsideOrEqual(join(parent, ".."), parent));
      },
    );
  });

  test("parsing is idempotent and resourcePathId ignores cwd for absolute paths", () => {
    assertProperty(
      "resource-path",
      "parsing is idempotent and resourcePathId ignores cwd for absolute paths",
      (tc) => {
        assertParses(tc.draw(absolute, "raw"), join("/", ...tc.draw(segments, "cwd")));
      },
    );
  });

  test("relative persisted paths are rejected", () => {
    assertProperty("resource-path", "relative persisted paths are rejected", (tc) => {
      const raw = tc.draw(gs.text({ alphabet: "ab./", minSize: 1, maxSize: 8 }), "raw");
      assert.equal(parseResourcePath(raw.replace(/^\/+/u, "x")), undefined);
    });
  });

  test("NUL bytes are rejected by the parser and thrown on by resourcePathId", () => {
    assertProperty(
      "resource-path",
      "NUL bytes are rejected by the parser and thrown on by resourcePathId",
      (tc) => {
        assertNul(tc.draw(absolute, "prefix"), tc.draw(gs.text({ alphabet: "ab/", maxSize: 4 })));
      },
    );
  });
});
