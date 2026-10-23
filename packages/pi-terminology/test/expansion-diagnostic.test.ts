import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { criteriaHash, loadCatalogue } from "../catalogue";
import { ATTEMPT_RESERVATION_NANOS, openLedger, readLedger } from "../eval-budget";
import { runExpansionDiagnostic } from "../scripts/diagnose-expansion-preflight";
import type { EvalRegistry } from "../scripts/evaluate";
import type { ExpansionFixture, ExpansionManifest } from "../scripts/evaluate-expansion";
import { stableHash } from "../validation";

const PACKAGE = resolve("packages/pi-terminology");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const usage = {
  input: 100,
  output: 1,
  totalTokens: 101,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
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
const sources = [
  "catalogue.ts",
  "index.ts",
  "ui.ts",
  "state.ts",
  "types.ts",
  "eval-metrics.ts",
  "classifier-request.ts",
  "native-matcher.ts",
  "selection.ts",
  "real-prompt-metrics.ts",
  "validation.ts",
  "eval-budget.ts",
  "scripts/evaluate.ts",
  "scripts/evaluate-expansion.ts",
  "glossary/core.json",
  "glossary/policy.json",
  "evals/production/core.json",
  "evals/production/policy.json",
];
describe("non-promoting expansion diagnostic", () => {
  let root: string;
  const catalogue = loadCatalogue().catalogue;
  const ids = catalogue.concepts.map((c) => c.id);
  let pins: Record<string, string>;
  let manifest: ExpansionManifest;
  let calls: number;
  let answer: () => ClassifierResult;
  const createRegistry = vi.fn<() => Promise<EvalRegistry>>();
  const row = (id: string): ExpansionFixture => ({
    id,
    prompt: `Implement diagnostic current work ${id}`,
    labels: Object.fromEntries(ids.map((concept) => [concept, "positive"])),
    named: [],
  });
  async function put(file: string, value: unknown) {
    const text = `${JSON.stringify(value)}\n`;
    await writeFile(join(root, file), text);
    return sha(text);
  }
  async function run(dry = false) {
    return runExpansionDiagnostic(dry, { root, catalogue, pins, createRegistry });
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "expansion-diagnostic-"));
    calls = 0;
    createRegistry.mockReset();
    await mkdir(join(root, "verify"));
    await mkdir(join(root, "tune"));
    const ledger = await openLedger(join(root, "eval-ledger.json"));
    for (let i = 0; i < 120; i += 1) {
      await ledger.reserve(`tune/dev-${i}/0`);
      await ledger.settleSuccess(`tune/dev-${i}/0`, usage);
    }
    const ledgerHash = stableHash(ledger.snapshot());
    await ledger.close();
    const dev = Array.from({ length: 120 }, (_, i) => row(`dev-${i}`));
    const synthetic = Array.from({ length: 148 }, (_, i) => row(`synthetic-${i}`));
    const privateRows = Array.from({ length: 80 }, (_, i) => row(`private-${i}`));
    privateRows[79] = {
      ...row("private-79"),
      prompt: privateRows[0]?.prompt ?? "",
      labels: Object.fromEntries(ids.map((concept) => [concept, "negative"])),
    };
    const development = [
      {
        name: "dev",
        kind: "synthetic" as const,
        file: "dev.json",
        records: 120,
        sha256: await put("dev.json", dev),
      },
    ];
    manifest = {
      schemaVersion: 1,
      development,
      heldout: [
        {
          name: "synthetic",
          kind: "synthetic",
          file: "synthetic.json",
          records: 148,
          sha256: await put("synthetic.json", synthetic),
        },
        {
          name: "private",
          kind: "private",
          file: "private.json",
          records: 80,
          sha256: await put("private.json", privateRows),
        },
      ],
      repeats: synthetic.slice(0, 12).map((r) => r.id),
    };
    const manifestHash = await put("manifest.json", manifest);
    const tuningReport = await put("tuning-report.json", {});
    const tuningObservations = await put("tuning-observations.json", []);
    await writeFile(join(root, "tune/observations.jsonl"), "");
    await put("tuning-completion.json", {
      reportHash: tuningReport,
      observationsHash: tuningObservations,
      originalObservations: join(root, "tune/observations.jsonl"),
      originalHash: sha(""),
      ledgerHash,
    });
    // A real native log is nonempty; use one provenance-only observation consistently in both artifacts.
    await writeFile(join(root, "tune/observations.jsonl"), "{}\n");
    const obsHash = await put("tuning-observations.json", [{}]);
    await put("tuning-completion.json", {
      reportHash: tuningReport,
      observationsHash: obsHash,
      originalObservations: join(root, "tune/observations.jsonl"),
      originalHash: sha("{}\n"),
      ledgerHash,
    });
    const baseline: unknown = JSON.parse(
      await readFile(join(PACKAGE, "evals/production/policy.json"), "utf8"),
    );
    const sourceHashes = Object.fromEntries<string>(
      await Promise.all(
        sources.map(async (file): Promise<readonly [string, string]> => [
          file,
          sha(await readFile(join(PACKAGE, file), "utf8")),
        ]),
      ),
    );
    const freezeHash = await put("freeze.json", {
      binding: {
        manifest: manifestHash,
        catalogue: stableHash(catalogue),
        criteria: criteriaHash(catalogue),
        baseline: stableHash(baseline),
        sources: sourceHashes,
      },
      thresholds: Object.fromEntries(ids.map((id) => [id, 0.9])),
      tuningReport,
      tuningObservations: obsHash,
      developmentPrompts: dev.map((r) => sha(r.prompt.toLowerCase())),
      ledgerHash,
    });
    pins = {
      "manifest.json": manifestHash,
      "freeze.json": freezeHash,
      "verify-receipt.json": await put("verify-receipt.json", { burned: true }),
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
    createRegistry.mockImplementation(async () => ({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only classifier lookup is exercised by the SDK matcher.
      findOfType: (() => model) as EvalRegistry["findOfType"],
      getProviderAuthStatus: () => ({ configured: true }),
      classify: async (classified, context, opts) => {
        calls += 1;
        if (
          classified.id !== "jev-1.13.0" ||
          Object.keys(context.questions).length !== 51 ||
          opts?.maxRetries !== 0 ||
          opts.timeoutMs !== 5000
        ) {
          throw new Error("Native contract mismatch");
        }
        const beforeDispatch = await readLedger(join(root, "eval-ledger.json"));
        if (beforeDispatch.attempts.at(-1)?.status !== "reserved") {
          throw new Error("Reservation missing");
        }
        await readFile(join(root, "diagnostic-receipt.json"));
        return answer();
      },
    }));
  });
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });
  test("dry run is read-only and never constructs auth", async () => {
    const before = await readdir(root, { recursive: true });
    await expect(run(true)).resolves.toMatchObject({
      outcome: "diagnostic-only",
      plannedAttempts: 239,
      duplicatesExcluded: 1,
    });
    await expect(readdir(root, { recursive: true })).resolves.toStrictEqual(before);
    expect(createRegistry).not.toHaveBeenCalled();
  });
  test("native deduplicated journey retains reservations, fuses disagreement and never promotes", async () => {
    const policyBefore = await readFile(join(PACKAGE, "glossary/policy.json"), "utf8");
    const report = await run();
    expect(report).toMatchObject({
      outcome: "diagnostic-only",
      complete: true,
      policyWritten: false,
      originalAcceptanceBlocked: true,
      policyUnchanged: true,
      completedAttempts: 239,
      repeatStability: { probes: 12, selectedSetAgreements: 12 },
      budget: { attempts: 359, jevReservedNanos: 359 * ATTEMPT_RESERVATION_NANOS },
    });
    expect(report).toHaveProperty("metrics.private.overall.ambiguousHits", 51);
    expect(JSON.stringify(report)).not.toContain("private-0");
    expect(JSON.stringify(report)).not.toContain("Implement diagnostic");
    expect(calls).toBe(239);
    await expect(readFile(join(PACKAGE, "glossary/policy.json"), "utf8")).resolves.toBe(
      policyBefore,
    );
    await expect(run()).rejects.toThrow(/120/u);
    expect(calls).toBe(239);
  });
  test("failure retains full reservation, reports latency and forbids replay", async () => {
    answer = () => {
      throw new Error("PRIVATE CREDENTIAL DETAILS");
    };
    await expect(run()).resolves.toMatchObject({
      outcome: "diagnostic-only",
      complete: false,
      policyWritten: false,
      latency: { dispatchedAttempts: 1, failedAttempts: 1, completedWithin5sRate: 0 },
    });
    const ledger = await readLedger(join(root, "eval-ledger.json"));
    expect(ledger.attempts.at(-1)).toMatchObject({
      status: "failed",
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
    });
    await expect(run()).rejects.toThrow(/120/u);
    expect(calls).toBe(1);
  });
  test("tampered commitments and nonempty original verify refuse before auth", async () => {
    await writeFile(join(root, "verify/unexpected"), "x");
    await expect(run()).rejects.toThrow(/empty/u);
    expect(createRegistry).not.toHaveBeenCalled();
  });
  test("fixture mutation cannot trigger any heldout call", async () => {
    await writeFile(join(root, "private.json"), "[]");
    await expect(run()).rejects.toThrow(/commitment/u);
    expect(calls).toBe(0);
  });
  test("even one prior heldout reservation disqualifies recovery", async () => {
    const ledger = await openLedger(join(root, "eval-ledger.json"));
    await ledger.reserve("verify/prior/0");
    await ledger.close();
    await expect(run()).rejects.toThrow(/120/u);
    expect(createRegistry).not.toHaveBeenCalled();
  });
  test("invalid native usage burns reservation and never produces scored acceptance", async () => {
    const original = answer;
    answer = () => ({ ...original(), usage: { ...usage, input: 0 } });
    const report = await run();
    expect(report).toMatchObject({
      outcome: "diagnostic-only",
      complete: false,
      policyWritten: false,
    });
    expect(report).not.toHaveProperty("metrics");
    const ledger = await readLedger(join(root, "eval-ledger.json"));
    expect(ledger.attempts.at(-1)).toMatchObject({
      status: "failed",
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
    });
    expect(calls).toBe(1);
  });
  test("auth failure consumes diagnostic receipt even with zero native calls", async () => {
    createRegistry.mockRejectedValueOnce(new Error("PRIVATE AUTH FAILURE"));
    const report = await run();
    expect(report).toMatchObject({
      complete: false,
      outcome: "diagnostic-only",
      policyWritten: false,
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE AUTH FAILURE");
    await expect(readFile(join(root, "diagnostic-receipt.json"), "utf8")).resolves.toContain(
      "originalAcceptanceBlocked",
    );
    await expect(run()).rejects.toThrow(/exist/u);
    expect(createRegistry).toHaveBeenCalledTimes(1);
    expect(calls).toBe(0);
  });
  test("frozen evidence tampering fails before any diagnostic reservation", async () => {
    await writeFile(join(root, "freeze.json"), "{}");
    await expect(run()).rejects.toThrow(/Pinned/u);
    const ledger = await readLedger(join(root, "eval-ledger.json"));
    expect(ledger.attempts).toHaveLength(120);
    expect(createRegistry).not.toHaveBeenCalled();
  });
});
