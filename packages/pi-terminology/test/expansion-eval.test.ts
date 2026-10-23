/* oxlint-disable vitest/no-conditional-in-test -- Parameterized failure fixtures deliberately exercise alternate native outcomes, not conditional assertions. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { criteriaHash } from "../catalogue";
import { ATTEMPT_RESERVATION_NANOS, readLedger } from "../eval-budget";
import type { EvalRegistry } from "../scripts/evaluate";
import { main, runExpansion } from "../scripts/evaluate-expansion";
import type {
  ExpansionFixture,
  ExpansionManifest,
  ExpansionOptions,
} from "../scripts/evaluate-expansion";
import type { Catalogue, Policy } from "../types";
import { composeGlossaries } from "../validation";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ids = Array.from({ length: 51 }, (_, i) => `core:concept-${i}`);
const model = {
  type: "classifier",
  provider: "typesafe",
  api: "typesafe-system-one",
  id: "jev-latest",
  name: "Jev",
  baseUrl: "https://example.invalid",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65_536,
} as ClassifierModel<"typesafe-system-one">;
const usage = {
  input: 100,
  output: 1,
  totalTokens: 101,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function catalogue(): Catalogue {
  const r = composeGlossaries([
    {
      schemaVersion: 1,
      namespace: "core",
      concepts: ids.map((id, i) => ({
        id,
        label: `Practice ${i}`,
        definition: "A software practice.",
        domain: "testing",
        references: [],
      })),
      recognition: ids.map((conceptId) => ({
        conceptId,
        matches: "Current requested work.",
        doesNotMatch: "Hypothetical work.",
        tip: "A software practice.",
        questionStyle: "no-criteria",
      })),
    },
  ]);
  if (!r.ok) {
    throw new Error(r.errors.join("\n"));
  }
  return r.value;
}
function fixture(id: string, prompt = `Implement work ${id}`): ExpansionFixture {
  return {
    id,
    prompt,
    labels: Object.fromEntries(ids.map((conceptId) => [conceptId, "positive"])),
    named: [],
  };
}
describe("expansion experiment protocol", () => {
  let root: string;
  let options: ExpansionOptions;
  let manifest: ExpansionManifest;
  let calls: number;
  let answer: () => ClassifierResult;
  let factory: ReturnType<typeof vi.fn<() => Promise<EvalRegistry>>>;
  async function persistManifest() {
    await writeFile(options.manifest, JSON.stringify(manifest));
  }
  async function split(name: string, fixtures: ExpansionFixture[]) {
    const text = JSON.stringify(fixtures);
    await writeFile(join(root, `${name}.json`), text);
    return {
      name,
      file: `${name}.json`,
      sha256: sha(text),
      records: fixtures.length,
      kind: name === "private" ? ("private" as const) : ("synthetic" as const),
    };
  }
  async function run(phase: ExpansionOptions["phase"], extra: Partial<ExpansionOptions> = {}) {
    return runExpansion({ ...options, phase, output: join(root, `${phase}-out`), ...extra });
  }
  async function freeze() {
    await expect(run("tune")).resolves.toHaveProperty("outcome", "tuned");
    await expect(run("freeze")).resolves.toHaveProperty("outcome", "frozen");
  }
  /* oxlint-disable vitest/no-standalone-expect -- Native registry mock asserts request and durable reservation invariants on every test dispatch. */
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "expansion-eval-"));
    calls = 0;
    const cat = catalogue();
    const baseline: Policy = {
      schemaVersion: 1,
      model: "jev-1.13.0",
      catalogueHash: cat.hash,
      criteriaHash: criteriaHash(cat),
      fixtureHash: "a".repeat(64),
      threshold: 0.9,
      conceptThresholds: Object.fromEntries(ids.slice(0, 10).map((id) => [id, 0.9])),
      precisionTarget: 0.9,
      measuredDisplayedPrecision: 1,
      measured: true,
    };
    answer = () => ({
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-1.13.0",
      timestamp: 1,
      stopReason: "stop",
      usage,
      answers: Object.fromEntries(ids.map((id) => [id, { type: "bool", probability: 0.95 }])),
    });
    factory = vi.fn<() => Promise<EvalRegistry>>(async (): Promise<EvalRegistry> => ({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only classifier lookup is used; the SDK method is generic over all model kinds.
      findOfType: (() => model) as EvalRegistry["findOfType"],
      getProviderAuthStatus: () => ({ configured: true }),
      classify: async (classified, context, opts) => {
        calls += 1;
        expect(classified.id).toBe("jev-1.13.0");
        expect(Object.keys(context.questions)).toHaveLength(51);
        expect(opts).toMatchObject({ timeoutMs: 5000, maxRetries: 0 });
        const beforeDispatch = await readLedger(join(root, "eval-ledger.json"));
        expect(beforeDispatch.attempts.at(-1)).toMatchObject({
          status: "reserved",
          reservedNanos: ATTEMPT_RESERVATION_NANOS,
        });
        const phase = calls <= 3 ? "tune" : "verify";
        await expect(readFile(join(root, `${phase}-receipt.json`), "utf8")).resolves.toContain(
          "planned",
        );
        return answer();
      },
    }));
    options = {
      phase: "tune",
      runDir: root,
      output: join(root, "tune-out"),
      manifest: join(root, "manifest.json"),
      catalogue: cat,
      baseline,
      createRegistry: factory,
      policyPath: join(root, "published.json"),
    };
    // A useful new-concept private hit, but no useful old-ten hit, is necessary for gain.
    const privateRow = fixture("private");
    privateRow.named = ids.slice(0, 10);
    privateRow.prompt = `Implement current work using ${ids
      .slice(0, 10)
      .map((_, i) => `Practice ${i}`)
      .join(" and ")}.`;
    manifest = {
      schemaVersion: 1,
      development: [
        await split("development", [fixture("dev1"), fixture("dev2"), fixture("dev3")]),
      ],
      heldout: [
        await split("synthetic", [fixture("synthetic")]),
        await split("private", [privateRow]),
      ],
    };
    await persistManifest();
  });
  /* oxlint-enable vitest/no-standalone-expect */
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  test("dry-run and freeze never open heldout content or construct auth", async () => {
    await rm(join(root, "synthetic.json"));
    await rm(join(root, "private.json"));
    const before = await readdir(root);
    await expect(run("tune", { dryRun: true })).resolves.toMatchObject({
      outcome: "dry-run",
      plannedAttempts: 3,
      heldoutContentRead: false,
    });
    expect(factory).not.toHaveBeenCalled();
    await expect(readdir(root)).resolves.toStrictEqual(before);
    await freeze();
    expect(calls).toBe(3);
    await expect(run("verify", { dryRun: true })).resolves.toMatchObject({
      outcome: "dry-run",
      plannedAttempts: 2,
      heldoutContentRead: false,
    });
    expect(calls).toBe(3);
  });
  test("native lifecycle measures selectors, compares subset and publishes only after report", async () => {
    manifest.repeats = ["synthetic"];
    await persistManifest();
    await freeze();
    const report = await run("verify", { writePolicy: true });
    expect(report).toMatchObject({
      outcome: "passed",
      policyWritten: true,
      completedAttempts: 3,
      usefulPrivatePromptGain: 1,
      repeatObservations: 1,
      repeatStability: {
        probes: 1,
        selectedSetAgreements: 1,
        selectedSetAgreementRate: 1,
        maximumProbabilityDelta: 0,
      },
    });
    const promotionText = await readFile(join(root, "verify-out/promotion-receipt.json"), "utf8");
    const publishedText = await readFile(join(root, "published.json"), "utf8");
    const reportText = await readFile(join(root, "verify-out/report.json"), "utf8");
    expect(promotionText).toContain(sha(publishedText));
    expect(promotionText).toContain(sha(reportText));
    expect(calls).toBe(6);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This file is produced by the runner under test.
    const policy = JSON.parse(await readFile(join(root, "published.json"), "utf8")) as Policy;
    expect(policy.measured).toBe(true);
    expect(Object.keys(policy.conceptThresholds ?? {})).toHaveLength(51);
    expect(JSON.parse(await readFile(join(root, "verify-out/report.json"), "utf8"))).toMatchObject({
      outcome: "passed",
    });
    const settled = await readLedger(join(root, "eval-ledger.json"));
    expect(settled.attempts).toHaveLength(6);
    await expect(run("verify", { output: join(root, "replay") })).rejects.toThrow(/./u);
    expect(calls).toBe(6);
  });
  test("insufficient development positives are gaps, never selectively disabled policy", async () => {
    manifest.development = [await split("development", [fixture("only")])];
    await persistManifest();
    const report = await run("tune");
    expect(report.outcome).toBe("gaps");
    expect(report.gaps).toStrictEqual(ids.toSorted());
    await expect(run("freeze")).rejects.toThrow(/gaps/u);
    expect(calls).toBe(1);
  });
  test.each(["throw", "usage", "missing"])(
    "%s failure burns reservation and receipt without retries",
    async (problem) => {
      answer = () => {
        if (problem === "throw") {
          throw new Error("PRIVATE AUTH ERROR");
        }
        return {
          api: "typesafe-system-one",
          provider: "typesafe",
          model: "jev-1.13.0",
          timestamp: 1,
          stopReason: "stop",
          ...(problem === "usage" ? {} : { usage }),
          answers: {},
        };
      };
      await expect(run("tune")).resolves.toMatchObject({ outcome: "error", policyWritten: false });
      expect(calls).toBe(1);
      const settled = await readLedger(join(root, "eval-ledger.json"));
      expect(settled.attempts[0]).toMatchObject({
        status: "failed",
        reservedNanos: ATTEMPT_RESERVATION_NANOS,
      });
      await expect(run("tune", { output: join(root, "escape") })).rejects.toThrow(/./u);
      expect(calls).toBe(1);
    },
  );
  test("mutation during native calls prevents freezing/promotion", async () => {
    const original = answer;
    answer = () => {
      Object.assign(options.baseline ?? {}, { threshold: 0.81 });
      return original();
    };
    await expect(run("tune")).resolves.toMatchObject({ outcome: "error" });
    await expect(run("freeze")).rejects.toThrow(/./u);
  });
  test("tampering with tuning artifacts is rejected before heldout auth", async () => {
    await freeze();
    await writeFile(join(root, "tuning-observations.json"), "[]");
    await expect(run("verify")).rejects.toThrow(/tampering/u);
    expect(calls).toBe(3);
  });
  test("heldout dataset mutation is rejected after single-use receipt, before native calls", async () => {
    await freeze();
    await writeFile(join(root, "private.json"), "[]");
    await expect(run("verify")).rejects.toThrow(/SHA-256/u);
    expect(calls).toBe(3);
    await expect(readFile(join(root, "verify-receipt.json"), "utf8")).resolves.toContain("binding");
  });
  test("freshness rejects reused normalized development prompts", async () => {
    manifest.heldout[0] = await split("synthetic", [
      fixture("different-id", "  IMPLEMENT   work dev1  "),
    ]);
    await persistManifest();
    await freeze();
    await expect(run("verify")).rejects.toThrow(/overlaps/u);
    expect(calls).toBe(3);
  });
  test("refuses auth/ledger/profile overrides and adaptive or excessive repeats", async () => {
    for (const flag of ["--auth", "--ledger", "--profile"]) {
      await expect(main([flag, "x"])).rejects.toThrow(/./u);
    }
    manifest.repeats = Array.from({ length: 13 }, (_, i) => String(i));
    await persistManifest();
    await expect(run("tune", { dryRun: true })).rejects.toThrow(/repeat/u);
    expect(calls).toBe(0);
  });
  test("private precision and synthetic per-concept recall independently block promotion", async () => {
    await freeze();
    answer = () => ({
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-1.13.0",
      timestamp: 1,
      stopReason: "stop",
      usage,
      answers: Object.fromEntries(ids.map((id) => [id, { type: "bool", probability: 0 }])),
    });
    const report = await run("verify", { writePolicy: true });
    expect(report).toMatchObject({
      outcome: "failed",
      policyWritten: false,
      usefulPrivatePromptGain: 0,
    });
    await expect(readFile(join(root, "published.json"))).rejects.toThrow(/ENOENT/u);
  });
  test("frozen threshold tampering is refused before native auth", async () => {
    await freeze();
    const file = join(root, "freeze.json");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately mutate one field of a runner-generated fixture.
    const value = JSON.parse(await readFile(file, "utf8")) as {
      thresholds: Record<string, number>;
    };
    value.thresholds[ids[0] ?? ""] = 0.8;
    await writeFile(file, JSON.stringify(value));
    await expect(run("verify")).rejects.toThrow(/thresholds/u);
    expect(calls).toBe(3);
  });
  test("transport failure contributes to real deadline completion rate", async () => {
    await freeze();
    answer = () => {
      throw new Error("private provider detail");
    };
    await expect(run("verify")).resolves.toMatchObject({
      outcome: "error",
      latency: {
        dispatchedAttempts: 1,
        completedWithin5s: 0,
        completedWithin5sRate: 0,
        failedAttempts: 1,
      },
    });
    expect(calls).toBe(4);
  });
  test("completion seal rejects jointly changed tuning report and derived observations", async () => {
    await run("tune");
    await writeFile(join(root, "tuning-observations.json"), "[]");
    await expect(run("freeze")).rejects.toThrow(/seal/u);
    expect(calls).toBe(3);
  });
});
