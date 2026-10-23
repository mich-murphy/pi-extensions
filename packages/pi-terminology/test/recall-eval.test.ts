/* oxlint-disable typescript/no-non-null-assertion -- Validated complete probability matrices and fixed test fixtures make mandatory indexed lookups safe. */
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as recallBudget from "../recall-budget";
import { readRecallLedger } from "../recall-budget";
import type { EvalRegistry, Matcher } from "../scripts/evaluate";
import { recallExitCode, runRecallEvaluation } from "../scripts/evaluate-recall";
import {
  hashFile,
  json,
  loadRecallCatalogue,
  normalizedPromptHash,
} from "../scripts/recall-contract";
import type { RecallFixture, RecallManifest, RecallSeal } from "../scripts/recall-contract";
import { acceptance, assertDevelopment, rankPilot, scoreRecall } from "../scripts/recall-scoring";
import type { RecallObservation } from "../scripts/recall-scoring";
import { renderReminder } from "../ui";

const pkg = resolve("packages/pi-terminology");
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const dirs: string[] = [];

const write = async (path: string, data: unknown) => writeFile(path, JSON.stringify(data));
const entry = (name: string, kind: "synthetic" | "private", records: number) => ({
  name,
  kind,
  records,
  file: `${name}.json`,
  sha256: "a".repeat(64),
});
function calibrationFixture(ids: string[], i: number) {
  return {
    id: `cal${i}`,
    prompt: `fresh calibration fixture ${i}`,
    named: [],
    labels: Object.fromEntries(
      ids.map((id, index) => [id, i < 510 && index === i % 51 ? "positive" : "negative"]),
    ),
  };
}
function mockProbability(label: string | undefined) {
  return label === "positive" ? 0.95 : 0.01;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "recall-eval-"));
  dirs.push(root);
  const catalogue = await loadRecallCatalogue(join(pkg, "evals/recall/baseline-core.json"));
  const ids = catalogue.concepts.map((c) => c.id);
  const pilot = Array.from({ length: 200 }, (_, i) => ({
    id: `p${i}`,
    prompt: `consumed unique prompt ${i}`,
    labels: Object.fromEntries(
      ids.map((id, index) => [id, index === i % 51 ? "positive" : "negative"]),
    ),
    named: [],
  }));
  await write(join(root, "pilot.json"), pilot);
  const manifest: RecallManifest = {
    schemaVersion: 1,
    pilot: [
      { ...entry("pilot", "synthetic", 200), sha256: await hashFile(join(root, "pilot.json")) },
    ],
    calibration: [entry("calibration", "synthetic", 612)],
    heldout: [entry("synthetic", "synthetic", 550), entry("private", "private", 200)],
    repeats: Array.from({ length: 24 }, (_, i) => `h${i}`),
    seal: { file: "seal.json" },
  };
  const manifestPath = join(root, "manifest.json");
  await write(manifestPath, manifest);
  const seal: RecallSeal = {
    schemaVersion: 1,
    manifestHash: await hashFile(manifestPath),
    independentAgent: "blind-validator",
    checks: {
      normalizedDuplicates: true,
      crossSplit: true,
      sessionDisjoint: true,
      scenarioFamilyDisjoint: true,
      consumedOverlap: true,
      coverage: true,
    },
    coverage: {
      pilot: Object.fromEntries(ids.map((id) => [id, 3])),
      calibration: Object.fromEntries(ids.map((id) => [id, 10])),
      synthetic: Object.fromEntries(ids.map((id) => [id, 10])),
      privatePositivePrompts: 20,
    },
  };
  await write(join(root, "seal.json"), seal);
  await copyFile(join(pkg, "evals/recall/authorization.json"), join(root, "authorization.json"));
  return { root, ids, manifest, manifestPath, seal, pilot };
}
describe("new recall phase isolation and preflight", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("every dry-run is write-free, auth-free, and never opens uncreated heldout/calibration files", async () => {
    const s = await setup();
    const before = await readdir(s.root);
    const auth = vi.fn<() => Promise<EvalRegistry>>();
    const matcher = vi.fn<Matcher>();
    for (const phase of ["pilot", "calibrate", "freeze", "verify"] as const) {
      const result = await runRecallEvaluation({
        phase,
        manifest: s.manifestPath,
        runDir: s.root,
        dryRun: true,
        createRegistry: auth,
        matcher,
      });
      expect(result).toMatchObject({ dryRun: true, phase, totalPlanned: 1786 });
    }
    expect(auth).not.toHaveBeenCalled();
    expect(matcher).not.toHaveBeenCalled();
    await expect(readdir(s.root)).resolves.toStrictEqual(before);
  });
  test.each([
    ["neither", (_matcher: Matcher, _registry: () => Promise<EvalRegistry>) => ({})],
    ["matcher-only", (matcher: Matcher, _registry: () => Promise<EvalRegistry>) => ({ matcher })],
    [
      "registry-only",
      (_matcher: Matcher, createRegistry: () => Promise<EvalRegistry>) => ({ createRegistry }),
    ],
  ] as const)(
    "test-only root with %s injections refuses before data reads, auth or ledger writes",
    async (_label, inject) => {
      const s = await setup();
      // A regressed guard must fail on missing data, never reach real auth in this test.
      await rm(join(s.root, "pilot.json"));
      const before = await readdir(s.root);
      const matcher = vi.fn<Matcher>();
      const createRegistry = vi.fn<() => Promise<EvalRegistry>>();
      await expect(
        runRecallEvaluation({
          phase: "pilot",
          manifest: s.manifestPath,
          runDir: s.root,
          ...inject(matcher, createRegistry),
        }),
      ).rejects.toThrow(/test-only runDir requires both/u);
      expect(matcher).not.toHaveBeenCalled();
      expect(createRegistry).not.toHaveBeenCalled();
      await expect(readdir(s.root)).resolves.toStrictEqual(before);
      await expect(
        runRecallEvaluation({
          phase: "pilot",
          manifest: s.manifestPath,
          runDir: s.root,
          dryRun: true,
        }),
      ).resolves.toMatchObject({ dryRun: true });
      await expect(readdir(s.root)).resolves.toStrictEqual(before);
    },
  );
  test.each(["synthetic", "calibration", "pilot"] as const)(
    "blocks ALL paid phases for a sealed %s coverage gap",
    async (split) => {
      const s = await setup();
      s.seal.coverage[split][s.ids[0]!] = 0;
      await write(join(s.root, "seal.json"), s.seal);
      const auth = vi.fn<() => Promise<EvalRegistry>>();
      await expect(
        runRecallEvaluation({
          phase: "pilot",
          manifest: s.manifestPath,
          runDir: s.root,
          createRegistry: auth,
        }),
      ).rejects.toThrow(/coverage/u);
      expect(auth).not.toHaveBeenCalled();
      await expect(readdir(s.root)).resolves.not.toContain("pilot.receipt.json");
    },
  );
  test("requires all independent checks and 20 distinct private-positive prompts", async () => {
    const s = await setup();
    s.seal.coverage.privatePositivePrompts = 19;
    await write(join(s.root, "seal.json"), s.seal);
    await expect(
      runRecallEvaluation({ phase: "pilot", manifest: s.manifestPath, runDir: s.root }),
    ).rejects.toThrow(/private positive/u);
    s.seal.coverage.privatePositivePrompts = 20;
    s.seal.checks.sessionDisjoint = false;
    await write(join(s.root, "seal.json"), s.seal);
    await expect(
      runRecallEvaluation({ phase: "pilot", manifest: s.manifestPath, runDir: s.root }),
    ).rejects.toThrow(/prevalidation/u);
  });
  test.each(["false", 1, {}, undefined])(
    "prevalidation rejects nonboolean/missing check %j before auth",
    async (value) => {
      const s = await setup();
      const malformed = { ...s.seal, checks: { ...s.seal.checks, coverage: value } };
      await write(join(s.root, "seal.json"), malformed);
      const createRegistry = vi.fn<() => Promise<EvalRegistry>>();
      await expect(
        runRecallEvaluation({
          phase: "pilot",
          manifest: s.manifestPath,
          runDir: s.root,
          createRegistry,
        }),
      ).rejects.toThrow(/prevalidation/u);
      expect(createRegistry).not.toHaveBeenCalled();
    },
  );
  test("duplicate preflight burns phase before data reads/auth; second invocation cannot resume", async () => {
    const s = await setup();
    s.pilot[1]!.prompt = `  CONSUMED   unique prompt 0 `;
    await write(join(s.root, "pilot.json"), s.pilot);
    s.manifest.pilot[0]!.sha256 = await hashFile(join(s.root, "pilot.json"));
    await write(s.manifestPath, s.manifest);
    s.seal.manifestHash = await hashFile(s.manifestPath);
    await write(join(s.root, "seal.json"), s.seal);
    const auth = vi.fn<() => Promise<EvalRegistry>>();
    const options = {
      phase: "pilot" as const,
      manifest: s.manifestPath,
      runDir: s.root,
      createRegistry: auth,
      matcher: vi.fn<Matcher>(),
    };
    await expect(runRecallEvaluation(options)).rejects.toThrow(/duplicate/u);
    await expect(readdir(s.root)).resolves.toContain("pilot.receipt.json");
    expect(auth).not.toHaveBeenCalled();
    await expect(runRecallEvaluation(options)).rejects.toThrow(/EEXIST/u);
  });
  test("seal binds exact manifest bytes; authorization mutation fails without auth", async () => {
    const s = await setup();
    await writeFile(s.manifestPath, `${await readFile(s.manifestPath, "utf8")}\n`);
    await expect(
      runRecallEvaluation({
        phase: "pilot",
        manifest: s.manifestPath,
        runDir: s.root,
        dryRun: true,
      }),
    ).rejects.toThrow(/seal binding/u);
    s.seal.manifestHash = await hashFile(s.manifestPath);
    await write(join(s.root, "seal.json"), s.seal);
    await write(join(s.root, "authorization.json"), {});
    await expect(
      runRecallEvaluation({
        phase: "pilot",
        manifest: s.manifestPath,
        runDir: s.root,
        dryRun: true,
      }),
    ).rejects.toThrow(/authorization/u);
  });
  test("failed native boundary retains durable reservation and burns phase with zero retries", async () => {
    const s = await setup();
    const matcher = vi.fn<Matcher>(async () => {
      const ledger = await readRecallLedger(join(s.root, "ledger.json"));
      expect(ledger.attempts).toHaveLength(1);
      expect(ledger.attempts[0]!.status).toBe("reserved");
      return { ok: false, reason: "error" };
    });
    const createRegistry = vi.fn<() => Promise<EvalRegistry>>(async () => ({
      findOfType: () => undefined,
      classify: async () => {
        throw new Error("Unexpected native classify in injected test.");
      },
      getProviderAuthStatus: () => ({ configured: true }),
    }));
    const options = {
      phase: "pilot" as const,
      manifest: s.manifestPath,
      runDir: s.root,
      matcher,
      createRegistry,
    };
    await expect(runRecallEvaluation(options)).rejects.toThrow(/phase burned/u);
    expect(matcher).toHaveBeenCalledTimes(1);
    const failedLedger = await readRecallLedger(join(s.root, "ledger.json"));
    expect(failedLedger.attempts[0]!.status).toBe("failed");
    await expect(runRecallEvaluation(options)).rejects.toThrow(/EEXIST/u);
    expect(matcher).toHaveBeenCalledTimes(1);
    await expect(readdir(s.root)).resolves.not.toContain("pilot.complete.json");
  });
  test("full mocked development lifecycle is auditable but cannot produce portable native freeze; completions are single-use and bound", async () => {
    const s = await setup();
    const calibration = Array.from({ length: 612 }, (_, i) => calibrationFixture(s.ids, i));
    await write(join(s.root, "calibration.json"), calibration);
    s.manifest.calibration[0]!.sha256 = await hashFile(join(s.root, "calibration.json"));
    await write(s.manifestPath, s.manifest);
    s.seal.manifestHash = await hashFile(s.manifestPath);
    await write(join(s.root, "seal.json"), s.seal);
    const expected = new Map([...s.pilot, ...calibration].map((row) => [row.prompt, row.labels]));
    const matcher = vi.fn<Matcher>(async (_registry, catalogue, prompt) => ({
      ok: true,
      value: {
        matches: catalogue.recognition.map((r) => ({
          concept: r.concept,
          recognition: r,
          probability: mockProbability(expected.get(prompt)![r.conceptId]),
          tip: r.tip,
        })),
        usage: {
          input: 20,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    }));
    const createRegistry = vi.fn<() => Promise<EvalRegistry>>(async () => ({
      findOfType: () => undefined,
      classify: async () => {
        throw new Error("Unexpected native classify in injected test.");
      },
      getProviderAuthStatus: () => ({ configured: true }),
    }));
    const originalSync = recallBudget.syncRecallEvidence;
    const sync = vi.spyOn(recallBudget, "syncRecallEvidence").mockImplementation(async (path) => {
      await expect(
        readFile(path.replace("observations.jsonl", "complete.json"), "utf8"),
      ).rejects.toThrow(/ENOENT/u);
      await originalSync(path);
    });
    const common = { manifest: s.manifestPath, runDir: s.root, matcher, createRegistry };
    const pilot = await runRecallEvaluation({ ...common, phase: "pilot" });
    expect(pilot).toMatchObject({ selected: "baseline" });
    expect(matcher).toHaveBeenCalledTimes(400);
    const completionPath = join(s.root, "pilot.complete.json");
    const completion = await json<{
      native: boolean;
      binding: { sources: Record<string, string> };
    }>(completionPath);
    expect(completion.native).toBe(false);
    expect(sync).toHaveBeenCalledWith(join(s.root, "pilot.observations.jsonl"));
    // A test-only root never permits default-native collection or another paid ledger.
    const nativeTarget = await mkdtemp(join(tmpdir(), "recall-native-refusal-"));
    dirs.push(nativeTarget);
    for (const name of [
      "manifest.json",
      "seal.json",
      "authorization.json",
      "pilot.complete.json",
      "pilot.report.json",
      "pilot.observations.jsonl",
      "ledger.json",
    ]) {
      await copyFile(join(s.root, name), join(nativeTarget, name));
    }
    await expect(
      runRecallEvaluation({
        phase: "calibrate",
        manifest: join(nativeTarget, "manifest.json"),
        runDir: nativeTarget,
      }),
    ).rejects.toThrow(/test-only runDir requires both/u);
    const refusedLedger = await readRecallLedger(join(nativeTarget, "ledger.json"));
    expect(refusedLedger.attempts).toHaveLength(400);
    const truthyCompletion = { ...completion, native: "true" };
    await write(join(nativeTarget, "pilot.complete.json"), truthyCompletion);
    await expect(
      runRecallEvaluation({
        ...common,
        phase: "verify",
        manifest: join(nativeTarget, "manifest.json"),
        runDir: nativeTarget,
      }),
    ).rejects.toThrow(/provenance must be a boolean/u);
    const original = JSON.stringify(completion);
    completion.binding.sources["selection.ts"] = "mutated";
    await write(completionPath, completion);
    await expect(runRecallEvaluation({ ...common, phase: "calibrate" })).rejects.toThrow(
      /binding mutation/u,
    );
    expect(matcher).toHaveBeenCalledTimes(400);
    // This failed phase is burned, even after restoring source bindings.
    await writeFile(completionPath, original);
    await expect(runRecallEvaluation({ ...common, phase: "calibrate" })).rejects.toThrow(/EEXIST/u);
    // A distinct isolated copy starts from the completed pilot; no failed phase is resumed.
    const target = await mkdtemp(join(tmpdir(), "recall-copy-"));
    dirs.push(target);
    const copiedFiles = await readdir(s.root);
    for (const file of copiedFiles.filter((name) => !name.startsWith("calibrate."))) {
      await copyFile(join(s.root, file), join(target, file));
    }
    const copy = { ...common, manifest: join(target, "manifest.json"), runDir: target };
    await runRecallEvaluation({ ...copy, phase: "calibrate" });
    expect(matcher).toHaveBeenCalledTimes(1012);
    const completedLedger = await readRecallLedger(join(target, "ledger.json"));
    expect(completedLedger.attempts).toHaveLength(1012);
    const reportPath = join(target, "calibrate.report.json");
    const originalReport = await readFile(reportPath, "utf8");
    const tampered = await json<{ thresholds: Record<string, number> }>(reportPath);
    tampered.thresholds[s.ids[0]!] = 0.8;
    await write(reportPath, tampered);
    await expect(runRecallEvaluation({ ...copy, phase: "verify" })).rejects.toThrow(
      /evidence mutation/u,
    );
    await writeFile(reportPath, originalReport);
    await expect(runRecallEvaluation({ ...copy, phase: "freeze" })).rejects.toThrow(
      /mock evidence/u,
    );
    await expect(readdir(target)).resolves.not.toContain("frozen.json");
    expect(createRegistry).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledTimes(2);
    sync.mockRestore();
  }, 30_000);
  test("normalizes unicode, whitespace and case for duplicate protection", () => {
    expect(normalizedPromptHash("Ａ  B\nC")).toBe(normalizedPromptHash("a b c"));
  });
});
function evidence() {
  const ids = Array.from({ length: 51 }, (_, i) => `c${i}`);
  const rows: RecallFixture[] = Array.from({ length: 530 }, (_, i) => ({
    id: `r${i}`,
    prompt: `unique ${i}`,
    kind: i < 510 ? "synthetic" : "private",
    named: [],
    labels: Object.fromEntries(
      ids.map((id, index) => [
        id,
        (i < 510 ? index === i % 51 : id === "c50") ? "positive" : "negative",
      ]),
    ),
  }));
  const observations: Mutable<RecallObservation>[] = rows.map((row) => ({
    observation: {
      id: row.id,
      split: "heldout",
      repeat: 0,
      alreadyNamed: [],
      probabilities: Object.fromEntries(
        ids.map((id) => [id, { native: row.labels[id] === "positive" ? 0.95 : 0.01 }]),
      ),
    },
    latencyMs: 1,
    inputTokens: 10,
    outputTokens: 0,
  }));
  return {
    rows,
    observations,
    ids,
    thresholds: Object.fromEntries(ids.map((id) => [id, 0.9])),
    old10: Object.fromEntries(ids.slice(0, 10).map((id) => [id, 0.9])),
  };
}
describe("recall gates include every concept/opportunity and archived old10 gain", () => {
  test("CLI result status differentiates durable acceptance failure from collection success", () => {
    expect(recallExitCode({ passed: false })).toBe(1);
    expect(recallExitCode({ passed: true })).toBe(0);
    expect(recallExitCode({ dryRun: true })).toBe(0);
    expect(recallExitCode(null)).toBe(0);
  });
  test("passes genuine complete high-recall evidence with positive private prompt gain", () => {
    const s = evidence();
    const result = acceptance(s.rows, s.observations, s.thresholds, s.old10);
    expect(result).toMatchObject({
      passed: true,
      privatePositivePrompts: 20,
      usefulPrivatePromptGain: 20,
    });
    expect(result.metrics.macro.recall).toBe(1);
    expect(result.metrics.overall.overall.conservativePrecision).toBe(1);
  });
  test("fails recall of ANY one synthetic concept even when aggregate scores remain excellent", () => {
    const s = evidence();
    for (const o of s.observations
      .filter((row) => row.observation.probabilities.c49!.native! > 0.9)
      .slice(0, 4)) {
      o.observation.probabilities.c49!.native = 0.1;
    }
    expect(acceptance(s.rows, s.observations, s.thresholds, s.old10).passed).toBe(false);
  });
  test("requires 10 distinct unnamed synthetic positives per concept, not repeat-inflated opportunities", () => {
    const s = evidence();
    for (const r of s.rows.filter((row) => row.labels.c49 === "positive").slice(0, 1)) {
      r.named.push("c49");
    }
    for (const o of s.observations
      .filter((row) => row.observation.probabilities.c49!.native! > 0.9)
      .slice(0, 1)) {
      o.observation.alreadyNamed.push("c49");
    }
    expect(acceptance(s.rows, s.observations, s.thresholds, s.old10).passed).toBe(false);
  });
  test("fails private precision and recall separately and never substitutes synthetic aggregate", () => {
    const s = evidence();
    for (const o of s.observations.slice(510)) {
      o.observation.probabilities.c50!.native = 0.1;
    }
    expect(acceptance(s.rows, s.observations, s.thresholds, s.old10).passed).toBe(false);
    for (const o of s.observations.slice(510)) {
      o.observation.probabilities.c50!.native = 0.95;
      o.observation.probabilities.c1!.native = 0.95;
    }
    expect(acceptance(s.rows, s.observations, s.thresholds, s.old10).passed).toBe(false);
  });
  test("requires 20 real private-positive prompts and strictly positive gain, not equal usefulness", () => {
    const s = evidence();
    s.rows[510]!.labels.c50 = "negative";
    s.observations[510]!.observation.probabilities.c50!.native = 0.01;
    expect(acceptance(s.rows, s.observations, s.thresholds, s.old10).passed).toBe(false);
    const full = evidence();
    const baseline: Record<string, number> = { ...full.old10, c50: 0.9 };
    delete baseline.c0;
    expect(acceptance(full.rows, full.observations, full.thresholds, baseline).passed).toBe(false);
  });
  test("keeps ambiguous hits and suppression in scored/conservative diagnostics", () => {
    const s = evidence();
    s.rows[0]!.labels.c1 = "ambiguous";
    s.observations[0]!.observation.probabilities.c1!.native = 0.95;
    s.observations[1]!.observation.alreadyNamed.push("c1");
    const metrics = scoreRecall(s.rows, s.observations, s.thresholds, "heldout");
    expect(metrics.overall.overall.ambiguousHits).toBe(1);
    expect(metrics.overall.overall.overSuppressedFn).toBe(1);
    expect(metrics.overall.overall.conservativePrecision!).toBeLessThan(
      metrics.overall.overall.precision!,
    );
  });
  test("development gates reject gaps, incomplete/out-of-grid thresholds, missing positives and recall loss", () => {
    const s = evidence();
    const metrics = scoreRecall(s.rows, s.observations, s.thresholds, "heldout");
    expect(() => {
      assertDevelopment(metrics, s.thresholds, []);
    }).not.toThrow(Error);
    expect(() => {
      assertDevelopment(metrics, s.thresholds, ["c1"]);
    }).toThrow(Error);
    expect(() => {
      assertDevelopment(metrics, { ...s.thresholds, c0: 0.799 }, []);
    }).toThrow(Error);
    expect(() => {
      assertDevelopment(metrics, s.old10, []);
    }).toThrow(Error);
    const weak = structuredClone(metrics) as Mutable<typeof metrics>;
    weak.overall.perConcept.c0!.distinctUnnamedPositivePrompts = 9;
    expect(() => {
      assertDevelopment(weak, s.thresholds, []);
    }).toThrow(Error);
    const low = structuredClone(metrics) as Mutable<typeof metrics>;
    low.overall.overall.recall = 0.849;
    expect(() => {
      assertDevelopment(low, s.thresholds, []);
    }).toThrow(Error);
  });
  test("pilot scoring uses disjoint fixed folds and returns a complete whole-profile candidate", () => {
    const s = evidence();
    const ranking = rankPilot(s.rows, s.observations, s.ids);
    expect(ranking.eligible).toBe(true);
    expect(ranking.precision).toBe(1);
    expect(ranking.recall).toBe(1);
    expect(Object.keys(ranking.candidateThresholds)).toHaveLength(51);
  });
});

function fourCandidates() {
  const ids = ["c3", "c2", "c10", "c1"];
  const row: RecallFixture = {
    id: "four",
    prompt: "four unnamed candidates",
    kind: "private",
    named: [],
    labels: { c1: "positive", c10: "negative", c2: "ambiguous", c3: "positive" },
  };
  const observation: Mutable<RecallObservation> = {
    observation: {
      id: row.id,
      split: "heldout",
      repeat: 0,
      alreadyNamed: [],
      probabilities: {
        c1: { native: 0.91 },
        c10: { native: 0.94 },
        c2: { native: 0.92 },
        c3: { native: 0.99 },
      },
    },
    latencyMs: 1,
    inputTokens: 10,
    outputTokens: 0,
  };
  return { row, observation, thresholds: Object.fromEntries(ids.map((id) => [id, 0.9])) };
}
describe("actual first-three displayed names, not all selected candidates", () => {
  test("canonical ID order masks hidden TP/FP without mutating observations or claiming named suppression", () => {
    const s = fourCandidates();
    const before = structuredClone(s.observation);
    const metrics = scoreRecall([s.row], [s.observation], s.thresholds, "heldout");
    expect(metrics.overall.overall).toMatchObject({
      tp: 1,
      fp: 1,
      fn: 1,
      ambiguousHits: 1,
      overSuppressedFn: 0,
    });
    expect(metrics.candidateSelected.overall.overall).toMatchObject({
      tp: 2,
      fp: 1,
      fn: 0,
      ambiguousHits: 1,
    });
    expect(metrics.widgetTruncatedPositiveAssignments).toBe(1);
    expect(metrics.overall.perConcept.c3).toMatchObject({
      tp: 0,
      fn: 1,
      distinctUnnamedPositivePrompts: 1,
    });
    expect(s.observation).toStrictEqual(before);
    expect(s.observation.observation.alreadyNamed).toStrictEqual([]);
    s.row.labels.c3 = "negative";
    const negative = scoreRecall([s.row], [s.observation], s.thresholds, "heldout");
    expect(negative.overall.overall.fp).toBe(1);
    expect(negative.candidateSelected.overall.overall.fp).toBe(2);
    expect(negative.widgetTruncatedPositiveAssignments).toBe(0);
  });
  test("named guard precedes slot allocation, so fourth eligible term becomes visible", () => {
    const s = fourCandidates();
    s.row.named = ["c1"];
    s.observation.observation.alreadyNamed = ["c1"];
    const metrics = scoreRecall([s.row], [s.observation], s.thresholds, "heldout");
    expect(metrics.overall.overall).toMatchObject({ tp: 1, fp: 1, fn: 0, redundantReminderFp: 0 });
    expect(metrics.overall.perConcept.c3!.tp).toBe(1);
    expect(metrics.widgetTruncatedPositiveAssignments).toBe(0);
  });
  test("useful private prompt gain uses visible names and baseline gets its own three slots", () => {
    const s = fourCandidates();
    s.row.labels = { c1: "negative", c10: "negative", c2: "negative", c3: "positive" };
    const result = acceptance([s.row], [s.observation], s.thresholds, { c3: 0.9 });
    expect(result).toMatchObject({
      usefulPrivatePrompts: 0,
      baselineUsefulPrivatePrompts: 1,
      usefulPrivatePromptGain: -1,
    });
    expect(result.metrics.candidateSelected.overall.overall.tp).toBe(1);
    expect(result.baseline.overall.overall.tp).toBe(1);
  });
  test("raw per-concept-perfect candidates cannot satisfy development gates when widget truncation hides positives", () => {
    const s = evidence();
    for (const row of s.rows) {
      for (const id of s.ids) {
        row.labels[id] = "positive";
      }
    }
    for (const observation of s.observations) {
      for (const id of s.ids) {
        observation.observation.probabilities[id]!.native = 0.95;
      }
    }
    const metrics = scoreRecall(s.rows, s.observations, s.thresholds, "heldout");
    expect(metrics.candidateSelected.overall.overall.recall).toBe(1);
    expect(metrics.overall.overall.recall).toBeLessThan(0.85);
    expect(() => {
      assertDevelopment(metrics, s.thresholds, []);
    }).toThrow(/Development precision\/recall/u);
    expect(acceptance(s.rows, s.observations, s.thresholds, s.old10).passed).toBe(false);
  });
  test("pinned actual renderReminder names precisely the first three matches in compiled recognition order", async () => {
    const catalogue = await loadRecallCatalogue(join(pkg, "evals/recall/baseline-core.json"));
    const recognitionIds = catalogue.recognition.map((item) => item.conceptId);
    expect(recognitionIds).toStrictEqual(recognitionIds.toSorted((a, b) => a.localeCompare(b)));
    const matches = catalogue.recognition.slice(0, 4).map((recognition) => ({
      recognition,
      concept: recognition.concept,
      probability: 0.95,
      tip: recognition.tip,
    }));
    const rendered = renderReminder(matches).join("\n");
    expect(rendered).toBe(
      `Terms: ${matches
        .slice(0, 3)
        .map((match) => match.concept.label)
        .join(
          ", ",
        )} +1 more. Ctrl+Shift+T or /terminology for details; /terminology-hide <id> hides one.`,
    );
    expect(rendered).not.toContain(matches[3]!.concept.label);
    const probabilities = Object.fromEntries(
      matches.map((match) => [match.concept.id, { native: match.probability }]),
    );
    const row: RecallFixture = {
      id: "render-contract",
      prompt: "unnamed discussion",
      kind: "synthetic",
      named: [],
      labels: Object.fromEntries(matches.map((match) => [match.concept.id, "positive"])),
    };
    const observation: RecallObservation = {
      observation: { id: row.id, repeat: 0, split: "heldout", alreadyNamed: [], probabilities },
      latencyMs: 1,
      inputTokens: 10,
      outputTokens: 0,
    };
    const score = scoreRecall(
      [row],
      [observation],
      Object.fromEntries(matches.map((match) => [match.concept.id, 0.9])),
      "heldout",
    );
    expect(score.overall.overall).toMatchObject({ tp: 3, fn: 1 });
    expect(score.overall.perConcept[matches[3]!.concept.id]!.tp).toBe(0);
  });
});
