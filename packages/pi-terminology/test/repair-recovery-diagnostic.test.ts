import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import type { Ledger } from "../eval-budget";
import { diagnoseRepairRecovery } from "../scripts/diagnose-repair-recovery";

const base = new URL("../", import.meta.url);
const directory = "evals/repair/";
const read = (path: string) => readFileSync(new URL(path, base), "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Typed deserialization of fixed test fixtures before deliberate mutation.
const parse = <T>(text: string) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Fixed public fixtures are deliberately mutated by these boundary tests.
  JSON.parse(text) as T;
// The interrupted native run froze index.ts/ui.ts before the terms->terminology command rename.
// Historical fixtures read those two sources from the byte-verified native archive so the unit tests
// keep exercising the original contract; the CURRENT renamed runtime is asserted separately below.
const historicalSources = new Set(["index.ts", "ui.ts"]);
const historical = (path: string) =>
  read(historicalSources.has(path) ? `${directory}source/${path}.txt` : path);
function reader(overrides: Record<string, string> = {}) {
  return vi.fn<(path: string) => string>((path) => overrides[path] ?? historical(path));
}
function artifact(name: string, bytes: string) {
  const result = parse<{ artifacts: Record<string, string> }>(read(`${directory}result.json`));
  result.artifacts[name] = digest(bytes);
  return reader({
    [`${directory}${name}`]: bytes,
    [`${directory}result.json`]: JSON.stringify(result),
  });
}
function ledger(change: (value: Ledger) => unknown) {
  const name = "development-ledger.json.txt";
  return artifact(name, JSON.stringify(change(parse<Ledger>(read(`${directory}${name}`)))));
}
function patch(value: Ledger, index: number, changes: Record<string, unknown>) {
  return {
    ...value,
    attempts: value.attempts.map((a, i) => (i === index ? { ...a, ...changes } : a)),
  };
}
function observations(change: (rows: Observation[]) => Observation[]) {
  const name = "development-observations.jsonl";
  const rows = read(`${directory}${name}`)
    .trim()
    .split("\n")
    .map((line) => parse<Observation>(line));
  return artifact(
    name,
    `${change(rows)
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
}
type Observation = {
  observation: { id: string; probabilities: Record<string, { native: number }> };
};
function first(rows: Observation[]) {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Missing fixture.");
  }
  return row;
}
function unreadableSource(path: string) {
  if (path === "index.ts") {
    throw new Error("missing");
  }
  return historical(path);
}
const publicPath = ([path]: [string]) =>
  !path.includes("..") && !/(?:private|heldout|acceptance)/iu.test(path) && !path.startsWith("/");

describe("offline interrupted-repair recovery diagnostic", () => {
  test("verifies public evidence and derives exactly the unattempted suffix without authority", () => {
    const fileReader = reader();
    const result = diagnoseRepairRecovery(fileReader);
    const rows = parse<{ id: string }[]>(read("evals/recall/calibration-consensus.json.txt"));
    expect(result).toMatchObject({
      status: "public-evidence-consistent",
      authorized: false,
      nativeCalls: 0,
      privateLedgerChecked: false,
      continuationImplemented: false,
      sourceCount: 26,
      preservedObservations: 416,
      sourceDrift: [],
      development: {
        additionalCalls: 196,
        additionalReservedNanos: 539_492_352,
        totalCalls: 1624,
        totalReservedNanos: 4_470_079_488,
      },
      conditionalReplay: {
        additionalCalls: 370,
        totalCalls: 1798,
        totalReservedNanos: 4_949_016_576,
      },
    });
    expect(result.pendingIds).toStrictEqual(rows.slice(416).map((row) => row.id));
    expect(new Set(result.pendingIds).size).toBe(196);
    expect(result.blockers).toHaveLength(2);
    expect(fileReader.mock.calls.every(publicPath)).toBe(true);
  });

  test("reports current source drift without pretending public evidence or paid authority changed", () => {
    const result = diagnoseRepairRecovery(
      reader({ "index.ts": `${historical("index.ts")}\n// changed\n` }),
    );
    expect(result.status).toBe("blocked-source-drift");
    expect(result.sourceDrift).toStrictEqual(["index.ts"]);
    expect(result.authorized).toBe(false);
    expect(result.blockers).toHaveLength(3);
  });

  test("treats an unreadable current source as drift", () => {
    expect(diagnoseRepairRecovery(unreadableSource).sourceDrift).toStrictEqual(["index.ts"]);
  });

  test("blocks the CURRENT renamed runtime against the original native source contract", () => {
    const result = diagnoseRepairRecovery((path) => read(path));
    expect(result.status).toBe("blocked-source-drift");
    expect(result.sourceDrift).toStrictEqual(["index.ts", "ui.ts"]);
    expect(result.authorized).toBe(false);
    expect(result.blockers).toHaveLength(3);
  });

  test("rejects changed archived source bytes", () => {
    expect(() =>
      diagnoseRepairRecovery(reader({ [`${directory}source/index.ts.txt`]: "changed" })),
    ).toThrow("Archive mutation");
  });

  test("rejects changed receipt and fixed dataset bytes", () => {
    expect(() =>
      diagnoseRepairRecovery(reader({ [`${directory}development-receipt.json.txt`]: "{}" })),
    ).toThrow("Artifact mutation");
    expect(() =>
      diagnoseRepairRecovery(reader({ "evals/recall/calibration-consensus.json.txt": "[]" })),
    ).toThrow("Fixed dataset mutation");
  });

  test("rejects missing or reordered preserved observations even when artifact hash is updated", () => {
    expect(() => diagnoseRepairRecovery(observations((rows) => rows.slice(1)))).toThrow(
      "Incomplete preserved observation prefix",
    );
    expect(() => diagnoseRepairRecovery(observations((rows) => rows.toReversed()))).toThrow(
      "Observation order mutation",
    );
  });

  test("rejects missing questions and non-probabilities in the preserved matrix", () => {
    expect(() =>
      diagnoseRepairRecovery(
        observations((rows) => {
          delete first(rows).observation.probabilities["core:refactoring"];
          return rows;
        }),
      ),
    ).toThrow("Incomplete probability matrix");
    expect(() =>
      diagnoseRepairRecovery(
        observations((rows) => {
          first(rows).observation.probabilities["core:refactoring"] = { native: 1.01 };
          return rows;
        }),
      ),
    ).toThrow("Invalid probability");
  });

  test("rejects mutations to the original 1012-attempt ledger prefix", () => {
    expect(() =>
      diagnoseRepairRecovery(ledger((value) => patch(value, 0, { recordId: "changed" }))),
    ).toThrow("Original ledger prefix mutation");
  });

  test("rejects duplicate or mismatched repair attempts", () => {
    expect(() =>
      diagnoseRepairRecovery(
        ledger((value) =>
          patch(value, 1013, {
            recordId: value.attempts[1012]?.recordId,
          }),
        ),
      ),
    ).toThrow("Duplicate attempt");
    expect(() =>
      diagnoseRepairRecovery(
        ledger((value) =>
          patch(value, 1012, {
            recordId: "repair/develop/wrong/0",
          }),
        ),
      ),
    ).toThrow("Repair ledger/observation mismatch");
  });

  test.each(["reserved", "failed"])("rejects %s repair attempts", (status) => {
    expect(() => diagnoseRepairRecovery(ledger((value) => patch(value, 1012, { status })))).toThrow(
      "Unsettled/failed attempt",
    );
  });

  test("rejects altered reservation accounting", () => {
    expect(() =>
      diagnoseRepairRecovery(ledger((value) => patch(value, 1012, { reservedNanos: 0 }))),
    ).toThrow("wrong reservation");
    const value = parse<{ budget: { capNanos: number } }>(read(`${directory}result.json`));
    value.budget.capNanos = 6_000_000_000;
    expect(() =>
      diagnoseRepairRecovery(reader({ [`${directory}result.json`]: JSON.stringify(value) })),
    ).toThrow("Shared cap mutation");
  });

  test("CLI accepts no paths or dispatch flags and prints only the public diagnostic", () => {
    const script = fileURLToPath(new URL("scripts/diagnose-repair-recovery.ts", base));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "jiti/register", script, ...args], {
        encoding: "utf8",
      });
    const blocked = run();
    expect(blocked.stderr).not.toContain("Recovery diagnostic refused");
    expect(blocked.status).toBe(1);
    expect(parse<unknown>(blocked.stdout)).toMatchObject({
      status: "blocked-source-drift",
      authorized: false,
      sourceDrift: ["index.ts", "ui.ts"],
    });
    const refused = run("--dispatch");
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("refused");
  });
});
