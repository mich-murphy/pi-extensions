import fs from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AttemptRecord } from "../eval-budget";
import { readRecallLedger } from "../recall-budget";
import type { EvalRegistry, Matcher } from "../scripts/evaluate";
import { REPAIR_ROOT } from "../scripts/evaluate-repair";
import {
  continuationExitCode,
  runRepairContinuation,
} from "../scripts/evaluate-repair-continuation";
import { json } from "../scripts/recall-contract";

const pkg = resolve("packages/pi-terminology");
// Historical fixtures must pass the unmodified paid-native source guard using its original bytes.
function historicalSourceReads(sources = ["index.ts", "ui.ts", "recall-aggregate-calibration.ts"]) {
  const originalRead = fs.readFileSync;
  const paths = new Map(
    sources.map((path) => [join(pkg, path), join(pkg, "evals/repair/source", `${path}.txt`)]),
  );
  vi.spyOn(fs, "readFileSync").mockImplementation((path, options) =>
    originalRead(typeof path === "string" ? (paths.get(resolve(path)) ?? path) : path, options),
  );
  syncBuiltinESMExports();
}
const directories: string[] = [];
const isSuccessfulContinuation = (a: AttemptRecord) =>
  a.recordId.startsWith("repair/develop-continue/") && a.status === "succeeded";
function requireMatcher(matcher: Matcher | undefined): Matcher {
  if (matcher === undefined) {
    throw new Error("Missing injected matcher.");
  }
  return matcher;
}
async function setup(historical = true) {
  if (historical) {
    historicalSourceReads();
  }
  const root = await mkdtemp(join(tmpdir(), "repair-continuation-eval-"));
  directories.push(root);
  const repair = join(root, "repair");
  const continuation = join(repair, "continuation");
  await mkdir(continuation, { recursive: true });
  for (const [source, destination] of [
    ["evals/repair/development-ledger.json.txt", join(root, "ledger.json")],
    ["evals/recall/authorization.json", join(root, "authorization.json")],
    ["evals/repair/authorization.json", join(repair, "authorization.json")],
    ["evals/repair/operator-manifest.json.txt", join(repair, "manifest.json")],
    ["evals/repair/development-receipt.json.txt", join(repair, "repair.develop.receipt.json")],
    [
      "evals/repair/development-observations.jsonl",
      join(repair, "repair.develop.observations.jsonl"),
    ],
    ["evals/repair/result.json", join(repair, "STOPPED.json")],
    ["evals/repair/continuation/authorization.json", join(continuation, "authorization.json")],
  ] as const) {
    await copyFile(join(pkg, source), destination);
  }
  const createRegistry = vi.fn<() => Promise<EvalRegistry>>(async () => ({
    findOfType: () => undefined,
    classify: async () => {
      throw new Error("No native inference permitted in tests.");
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
  const options = {
    manifest: join(repair, "manifest.json"),
    authorization: join(continuation, "authorization.json"),
    runDir: root,
    matcher,
    createRegistry,
  };
  return {
    root,
    repair,
    continuation,
    matcher,
    createRegistry,
    options,
    run: runRepairContinuation,
  };
}

describe("append-only 196-request continuation", () => {
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    syncBuiltinESMExports();
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
  ])("literal development exit status for $result is $expected", ({ result, expected }) => {
    expect(continuationExitCode(result)).toBe(expected);
  });
  test("injection guards run before file/credential access", async () => {
    const createRegistry = vi.fn<() => Promise<EvalRegistry>>();
    await expect(
      runRepairContinuation({ manifest: "/missing", authorization: "/missing", createRegistry }),
    ).rejects.toThrow("BOTH");
    await expect(
      runRepairContinuation({
        manifest: "/missing",
        authorization: "/missing",
        runDir: REPAIR_ROOT,
        createRegistry,
        matcher: vi.fn<Matcher>(),
      }),
    ).rejects.toThrow("BOTH");
    expect(createRegistry).not.toHaveBeenCalled();
  });
  test("dry-run is registry-free and write-free with exactly196 pending rows", async () => {
    const s = await setup();
    const before = await readdir(s.continuation);
    const ledger = await readFile(join(s.root, "ledger.json"), "utf8");
    const result = await s.run({ ...s.options, dryRun: true });
    expect(result).toMatchObject({
      dryRun: true,
      planned: 196,
      replayAuthorized: false,
      writes: 0,
      calls: 0,
    });
    expect(s.matcher).not.toHaveBeenCalled();
    expect(s.createRegistry).not.toHaveBeenCalled();
    await expect(readdir(s.continuation)).resolves.toStrictEqual(before);
    await expect(readFile(join(s.root, "ledger.json"), "utf8")).resolves.toBe(ledger);
  });
  test("a stale lock is not stolen or followed by auth/provider setup", async () => {
    const s = await setup();
    await writeFile(join(s.root, "ledger.json.lock"), "12345\n");
    await expect(s.run(s.options)).rejects.toThrow("EEXIST");
    expect(s.matcher).not.toHaveBeenCalled();
    expect(s.createRegistry).not.toHaveBeenCalled();
    await expect(readFile(join(s.root, "ledger.json.lock"), "utf8")).resolves.toBe("12345\n");
  });
  test("first failure burns only one new reservation and cannot be retried", async () => {
    const s = await setup();
    s.matcher.mockRejectedValue(new Error("offline failure"));
    await expect(s.run(s.options)).rejects.toThrow("offline failure");
    const ledger = await readRecallLedger(join(s.root, "ledger.json"));
    expect(ledger.attempts).toHaveLength(1429);
    expect(ledger.attempts.at(-1)).toMatchObject({ status: "failed", reservedNanos: 2_752_512 });
    await expect(readdir(s.continuation)).resolves.toContain("receipt.json");
    await expect(readdir(s.continuation)).resolves.not.toContain("combined.complete.json");
    await expect(s.run(s.options)).rejects.toThrow("burned continuation receipt");
    expect(s.matcher).toHaveBeenCalledTimes(1);
    await expect(
      readFile(join(s.repair, "repair.develop.observations.jsonl"), "utf8"),
    ).resolves.toBe(
      await readFile(join(pkg, "evals/repair/development-observations.jsonl"), "utf8"),
    );
  });
  test("missing credentials burn the continuation receipt but reserve no attempt", async () => {
    const s = await setup();
    s.createRegistry.mockResolvedValue({
      findOfType: () => undefined,
      classify: async () => {
        throw new Error("must not classify");
      },
      getProviderAuthStatus: () => ({ configured: false }),
    });
    await expect(s.run(s.options)).rejects.toThrow("authentication unavailable");
    expect(s.matcher).not.toHaveBeenCalled();
    const unchanged = await readRecallLedger(join(s.root, "ledger.json"));
    expect(unchanged.attempts).toHaveLength(1428);
    await expect(readdir(s.continuation)).resolves.toContain("receipt.json");
    await expect(s.run(s.options)).rejects.toThrow("burned continuation receipt");
  });
  test.each([
    { path: "authorization.json", message: "Historical" },
    { path: "repair/authorization.json", message: "Historical" },
    { path: "repair/manifest.json", message: "Historical" },
    { path: "repair/repair.develop.receipt.json", message: "Historical" },
    { path: "repair/repair.develop.observations.jsonl", message: "Historical" },
    { path: "repair/STOPPED.json", message: "interruption marker" },
    { path: "ledger.json", message: "Stopped live ledger mutation" },
    { path: "repair/continuation/authorization.json", message: "Continuation authorization bytes" },
    { path: "repair/repair.develop.complete.json", message: "Existing completion" },
  ])("rejects changed $path before credentials or writes", async ({ path, message }) => {
    const s = await setup();
    await writeFile(join(s.root, path), "{}\n");
    await expect(s.run(s.options)).rejects.toThrow(message);
    expect(s.createRegistry).not.toHaveBeenCalled();
    expect(s.matcher).not.toHaveBeenCalled();
    await expect(readdir(s.continuation)).resolves.not.toContain("receipt.json");
  });
  test("an incomplete matrix settles failure and cannot complete or fit", async () => {
    const s = await setup();
    s.matcher.mockResolvedValue({ ok: true, value: { matches: [] } });
    await expect(s.run(s.options)).rejects.toThrow("Incomplete probability matrix");
    const ledger = await readRecallLedger(join(s.root, "ledger.json"));
    expect(ledger.attempts).toHaveLength(1429);
    expect(ledger.attempts.at(-1)?.status).toBe("failed");
    expect(s.matcher).toHaveBeenCalledTimes(1);
    await expect(readdir(s.continuation)).resolves.not.toContain("combined.complete.json");
    await expect(readdir(s.continuation)).resolves.not.toContain("report.json");
  });
  test.each([
    { path: "receipt.json", message: "Continuation receipt mutation" },
    { path: "source-manifest.json", message: "Continuation source manifest mutation" },
    {
      path: "source/scripts/evaluate-repair-continuation.ts.txt",
      message: "source archive mutation",
    },
  ])("$path mutation stops before a second reservation", async ({ path, message }) => {
    const s = await setup();
    const original = s.matcher.getMockImplementation();
    expect(original).toBeDefined();
    s.matcher.mockImplementation(async (...args) => {
      await writeFile(join(s.continuation, path), "{}\n");
      return requireMatcher(original)(...args);
    });
    await expect(s.run(s.options)).rejects.toThrow(message);
    const ledger = await readRecallLedger(join(s.root, "ledger.json"));
    expect(ledger.attempts).toHaveLength(1429);
    expect(ledger.attempts.at(-1)?.status).toBe("succeeded");
    expect(s.matcher).toHaveBeenCalledTimes(1);
    await expect(readdir(s.continuation)).resolves.not.toContain("combined.complete.json");
  });
  test("only196 injected calls complete a new non-native combined proof before fitting", async () => {
    const s = await setup();
    const originalReceipt = await readFile(join(s.repair, "repair.develop.receipt.json"), "utf8");
    const originalLedger = await readRecallLedger(join(s.root, "ledger.json"));
    const result = await s.run(s.options);
    expect(s.matcher).toHaveBeenCalledTimes(196);
    expect(result).toMatchObject({
      native: false,
      measured: false,
      accepted: false,
      developmentOnly: true,
      promotable: false,
      replayAuthorized: false,
      acceptanceExecuted: false,
      previewArtifactAvailable: false,
    });
    const completion = await json(join(s.continuation, "combined.complete.json"));
    expect(completion).toMatchObject({
      native: false,
      kind: "combined-development-after-interrupted-original",
      originalInterrupted: true,
      originalCompletionExists: false,
      originalCount: 416,
      continuationCount: 196,
      count: 612,
    });
    const ledger = await readRecallLedger(join(s.root, "ledger.json"));
    expect(ledger.attempts).toHaveLength(1624);
    expect(ledger.attempts.slice(0, 1428)).toStrictEqual(originalLedger.attempts);
    expect(ledger.attempts.slice(1428).every((a) => isSuccessfulContinuation(a))).toBe(true);
    await expect(readFile(join(s.repair, "repair.develop.receipt.json"), "utf8")).resolves.toBe(
      originalReceipt,
    );
    await expect(readdir(s.repair)).resolves.not.toContain("repair.develop.complete.json");
    await expect(readdir(s.continuation)).resolves.toContain("fit-seal.json");
    await expect(s.run(s.options)).rejects.toThrow("burned continuation receipt");
    expect(s.matcher).toHaveBeenCalledTimes(196);
  }, 120_000);
  test("the optimized fitter alone blocks paid continuation before credentials, calls or receipt writes", async () => {
    const s = await setup(false);
    historicalSourceReads(["index.ts", "ui.ts"]);
    await expect(runRepairContinuation({ ...s.options, dryRun: true })).rejects.toThrow(
      "Original frozen source drift.",
    );
    await expect(runRepairContinuation(s.options)).rejects.toThrow("Original frozen source drift.");
    expect(s.createRegistry).not.toHaveBeenCalled();
    expect(s.matcher).not.toHaveBeenCalled();
    await expect(readdir(s.continuation)).resolves.not.toContain("receipt.json");
  });
  test("CURRENT renamed runtime is blocked after historical filesystem fixtures have been restored", async () => {
    const s = await setup(false);
    await expect(runRepairContinuation({ ...s.options, dryRun: true })).rejects.toThrow(
      "Original frozen source drift.",
    );
    await expect(runRepairContinuation(s.options)).rejects.toThrow("Original frozen source drift.");
    expect(s.createRegistry).not.toHaveBeenCalled();
    expect(s.matcher).not.toHaveBeenCalled();
    await expect(readdir(s.continuation)).resolves.not.toContain("receipt.json");
  });
});
