import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readRecallLedger } from "../recall-budget";
import type { EvalRegistry, Matcher } from "../scripts/evaluate";
import { REPAIR_ROOT, repairExitCode, runRepairEvaluation } from "../scripts/evaluate-repair";
import type { RepairOptions } from "../scripts/evaluate-repair";
import { check, json } from "../scripts/recall-contract";
import {
  assertRepairLedger,
  assertRepairNative,
  assertRepairReplayFit,
  originalRepairLedger,
  repairRepeatIds,
} from "../scripts/repair-contract";
import type { RepairManifest } from "../scripts/repair-contract";

const pkg = resolve("packages/pi-terminology");
const dirs: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "repair-test-"));
  dirs.push(root);
  const repair = join(root, "repair");
  await mkdir(repair);
  await copyFile(join(pkg, "evals/recall/development-ledger.json.txt"), join(root, "ledger.json"));
  await copyFile(join(pkg, "evals/recall/authorization.json"), join(root, "authorization.json"));
  await copyFile(join(pkg, "evals/repair/authorization.json"), join(repair, "authorization.json"));
  const manifest = await json<RepairManifest>(join(pkg, "evals/repair/manifest-template.json"));
  manifest.develop.file = join(pkg, "evals/recall/calibration-consensus.json.txt");
  manifest.replay.file = join(pkg, "evals/repair/public-replay.json");
  const path = join(repair, "manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  const createRegistry = vi.fn<() => Promise<EvalRegistry>>(async () => ({
    findOfType: () => undefined,
    classify: async () => {
      throw new Error("No native calls permitted in tests");
    },
    getProviderAuthStatus: () => ({ configured: true }),
  }));
  const matcher = vi.fn<Matcher>(async (_registry, catalogue) => ({
    ok: true,
    value: {
      matches: catalogue.recognition.map((r) => ({
        concept: r.concept,
        recognition: r,
        probability: 0.01,
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
  return {
    root,
    repair,
    manifest,
    path,
    createRegistry,
    matcher,
    options: { phase: "develop" as const, manifest: path, runDir: root, createRegistry, matcher },
  };
}
describe("repair isolation and cumulative authorization", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const p of dirs.splice(0)) {
      await rm(p, { recursive: true, force: true });
    }
  });
  test.each([
    { result: undefined, expected: 0 },
    { result: null, expected: 0 },
    { result: true, expected: 0 },
    { result: {}, expected: 0 },
    { result: { stopPaidReplay: false }, expected: 0 },
    { result: { stopPaidReplay: "true" }, expected: 0 },
    { result: { stopPaidReplay: 1 }, expected: 0 },
    { result: { stopPaidReplay: true }, expected: 1 },
  ])("CLI exit for gate result $result is $expected", ({ result, expected }) => {
    expect(repairExitCode(result)).toBe(expected);
  });
  test.each([false, "false", 1, null, undefined])(
    "external JSON literal flags reject %s",
    (value) => {
      expect(() => {
        assertRepairNative(value);
      }).toThrow("literal true");
      expect(() => {
        assertRepairReplayFit(value);
      }).toThrow("STOP FURTHER PAID REPLAY");
    },
  );

  test("dry-run all phases is write-free, registry-free and matcher-free", async () => {
    const s = await setup();
    const before = await readdir(s.repair);
    const ledger = await readFile(join(s.root, "ledger.json"), "utf8");
    for (const phase of ["develop", "replay", "freeze-preview"] as const) {
      await expect(
        runRepairEvaluation({ ...s.options, phase, dryRun: true }),
      ).resolves.toMatchObject({
        dryRun: true,
        planned: { develop: 612, replay: 174, "freeze-preview": 0 }[phase],
      });
    }
    expect(s.createRegistry).not.toHaveBeenCalled();
    expect(s.matcher).not.toHaveBeenCalled();
    await expect(readdir(s.repair)).resolves.toStrictEqual(before);
    await expect(readFile(join(s.root, "ledger.json"), "utf8")).resolves.toBe(ledger);
  });
  test("test-root guard runs before any file or auth access, including dry-run", async () => {
    const registry = vi.fn<() => Promise<EvalRegistry>>();
    await expect(
      runRepairEvaluation({
        phase: "develop",
        manifest: "/not-created",
        runDir: "/not-created",
        createRegistry: registry,
        dryRun: true,
      }),
    ).rejects.toThrow("BOTH");
    expect(registry).not.toHaveBeenCalled();
  });
  test.each<Pick<RepairOptions, "runDir">>([{}, { runDir: REPAIR_ROOT }])(
    "injected boundaries cannot consume the real namespace with root %j",
    async (rootOptions) => {
      const createRegistry = vi.fn<() => Promise<EvalRegistry>>();
      const matcher = vi.fn<Matcher>();
      await expect(
        runRepairEvaluation({
          phase: "develop",
          manifest: "/not-created",
          ...rootOptions,
          createRegistry,
          matcher,
        }),
      ).rejects.toThrow("explicit isolated non-default root");
      expect(createRegistry).not.toHaveBeenCalled();
      expect(matcher).not.toHaveBeenCalled();
    },
  );
  test("missing original ledger cannot create fresh budget", async () => {
    const s = await setup();
    await rm(join(s.root, "ledger.json"));
    await expect(runRepairEvaluation(s.options)).rejects.toThrow("ENOENT");
    expect(s.createRegistry).not.toHaveBeenCalled();
  });
  test("authorization mutation and private/heldout path substitution fail before registry", async () => {
    const s = await setup();
    await writeFile(join(s.repair, "authorization.json"), "{}");
    await expect(runRepairEvaluation(s.options)).rejects.toThrow("authorization bytes");
    s.manifest.develop.file = join(s.root, "heldout.json");
    await writeFile(s.path, JSON.stringify(s.manifest));
    await expect(runRepairEvaluation(s.options)).rejects.toThrow("fixed public");
    expect(s.createRegistry).not.toHaveBeenCalled();
  });
  test("repeat IDs are seeded, distinct and preregistered", async () => {
    const s = await setup();
    const rows = await json<{ id: string }[]>(join(pkg, "evals/repair/public-replay.json"));
    expect(s.manifest.repeats).toStrictEqual(repairRepeatIds(rows.map((r) => r.id)));
    expect(new Set(s.manifest.repeats).size).toBe(24);
    s.manifest.repeats.reverse();
    await writeFile(s.path, JSON.stringify(s.manifest));
    await expect(runRepairEvaluation(s.options)).rejects.toThrow("Repeat precommitment");
    expect(s.createRegistry).not.toHaveBeenCalled();
  });
  test("prefix records cannot be replaced or reset", async () => {
    const original = await originalRepairLedger(pkg);
    const changed = structuredClone(original);
    const first = changed.attempts[0];
    check(first, "Missing archived attempt");
    const mutated = {
      ...changed,
      attempts: [{ ...first, recordId: `${first.recordId}mutated` }, ...changed.attempts.slice(1)],
    };
    expect(() => {
      assertRepairLedger(mutated, original);
    }).toThrow("prefix mutation");
  });
  test("failure consumes one reservation and burns exclusive receipt, no completion or retry", async () => {
    const s = await setup();
    s.matcher.mockRejectedValue(new Error("offline transport failure"));
    await expect(runRepairEvaluation(s.options)).rejects.toThrow("offline transport failure");
    const ledger = await readRecallLedger(join(s.root, "ledger.json"));
    expect(ledger.attempts).toHaveLength(1013);
    expect(ledger.attempts.at(-1)?.status).toBe("failed");
    await expect(readdir(s.repair)).resolves.not.toContain("repair.develop.complete.json");
    await expect(runRepairEvaluation(s.options)).rejects.toThrow("EEXIST");
    expect(s.matcher).toHaveBeenCalledTimes(1);
  });
  test("all 612 DI observations durable before failed fit; false native cannot freeze or replay", async () => {
    const s = await setup();
    const result = await runRepairEvaluation(s.options);
    expect(result).toMatchObject({
      feasible: false,
      stopPaidReplay: true,
      measured: false,
      accepted: false,
    });
    const complete = await json(join(s.repair, "repair.develop.complete.json"));
    expect(complete).toMatchObject({ native: false, count: 612 });
    const raw = await readFile(join(s.repair, "repair.develop.observations.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(612);
    const ledger = await readRecallLedger(join(s.root, "ledger.json"));
    expect(ledger.attempts).toHaveLength(1624);
    assertRepairLedger(ledger, await originalRepairLedger(pkg));
    await expect(runRepairEvaluation({ ...s.options, phase: "freeze-preview" })).rejects.toThrow(
      "Injected evidence",
    );
    await expect(runRepairEvaluation({ ...s.options, phase: "replay" })).rejects.toThrow(
      "Injected evidence",
    );
    expect(s.matcher).toHaveBeenCalledTimes(612);
  }, 120_000);
});
