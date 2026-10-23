import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  renameTerminologyCommands,
  verifyCommandRenameSource,
} from "../scripts/command-rename-compatibility";

const base = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, base), "utf8");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const archived = (path: string) => `evals/repair/source/${path}.txt`;
const withFiles = (files: Record<string, string>) => (path: string) => files[path] ?? read(path);

describe("explicit offline native source compatibility", () => {
  test("rewrites command registration and slash guidance, not ordinary terminology prose", () => {
    expect(
      renameTerminologyCommands(
        'registerCommand("terms-status"); /terms-preview off; /terms; Search terms: ',
      ),
    ).toBe(
      'registerCommand("terminology-status"); /terminology-preview off; /terminology; Search terms: ',
    );
  });
  test.each(["index.ts", "ui.ts"])(
    "current %s is exactly the deterministic rename of its preserved native archive",
    (path) => {
      const original = read(archived(path));
      expect(read(path)).toBe(renameTerminologyCommands(original));
      expect(read(path)).not.toBe(original);
      expect(() => {
        verifyCommandRenameSource(read, path, hash(original));
      }).not.toThrow();
      expect(() => {
        verifyCommandRenameSource(withFiles({ [path]: original }), path, hash(original));
      }).not.toThrow();
    },
  );
  test("no extra runtime change, even an added comment, is covered by this compatibility rule", () => {
    expect(() => {
      verifyCommandRenameSource(
        withFiles({ "index.ts": `${read("index.ts")}\n` }),
        "index.ts",
        hash(read(archived("index.ts"))),
      );
    }).toThrow("Frozen source drift beyond command-only rename");
  });
  test("a changed archive cannot authorize a different runtime", () => {
    const originalHash = hash(read(archived("index.ts")));
    expect(() => {
      verifyCommandRenameSource(
        withFiles({ [archived("index.ts")]: "changed" }),
        "index.ts",
        originalHash,
      );
    }).toThrow("Frozen source drift beyond command-only rename");
  });
  test("partial command migrations are rejected", () => {
    const original = read(archived("index.ts"));
    const partial = renameTerminologyCommands(original).replace(
      "Usage: /terminology-status",
      "Usage: /terms-status",
    );
    expect(() => {
      verifyCommandRenameSource(withFiles({ "index.ts": partial }), "index.ts", hash(original));
    }).toThrow("Frozen source drift beyond command-only rename");
  });
  test("accepts only the pinned optimized fitter paired with its original native archive", () => {
    const path = "recall-aggregate-calibration.ts";
    const original = read(archived(path));
    expect(read(path)).not.toBe(original);
    expect(() => {
      verifyCommandRenameSource(read, path, hash(original));
    }).not.toThrow();
    expect(() => {
      verifyCommandRenameSource(withFiles({ [path]: original }), path, hash(original));
    }).not.toThrow();
  });
  test.each(["recall-aggregate-calibration.ts", archived("recall-aggregate-calibration.ts")])(
    "rejects a one-byte mutation of %s",
    (changed) => {
      const path = "recall-aggregate-calibration.ts";
      expect(() => {
        verifyCommandRenameSource(
          withFiles({ [changed]: `${read(changed)}\n` }),
          path,
          hash(read(archived(path))),
        );
      }).toThrow("Frozen source drift beyond pinned optimizer");
    },
  );
  test("rejects a different supplied original hash, including the optimized source's own hash", () => {
    const path = "recall-aggregate-calibration.ts";
    expect(() => {
      verifyCommandRenameSource(read, path, hash(read(path)));
    }).toThrow("Frozen source drift beyond pinned optimizer");
  });
  test("the optimized hash cannot excuse a different source path", () => {
    const path = "native-matcher.ts";
    expect(() => {
      verifyCommandRenameSource(
        withFiles({ [path]: read("recall-aggregate-calibration.ts") }),
        path,
        hash(read(archived(path))),
      );
    }).toThrow("Frozen source drift: native-matcher.ts");
  });
  test("no classifier source change is excused as a command rename", () => {
    const path = "native-matcher.ts";
    expect(() => {
      verifyCommandRenameSource(
        withFiles({ [path]: `${read(path)}\n` }),
        path,
        hash(read(archived(path))),
      );
    }).toThrow("Frozen source drift: native-matcher.ts");
  });
});
