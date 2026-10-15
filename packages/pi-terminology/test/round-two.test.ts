import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ATTEMPT_RESERVATION_NANOS, openLedger, readLedger } from "../eval-budget";
import type { EvalFixture } from "../eval-metrics";
import { parseCli, runEvaluation } from "../scripts/evaluate";
import type { EvalOptions, EvalRegistry, Matcher } from "../scripts/evaluate";
import { runOfflineOperation } from "../scripts/round-two-offline";
import {
  artifactHash,
  hashBytes,
  isRecord,
  readJson,
  roundContext,
  readRoundState,
  reserveRoundAttempt,
} from "../scripts/round-two-state";
import type { Variant } from "../scripts/round-two-state";
import { historicalCatalogue } from "./historical-fixture";

const archivedCatalogue = historicalCatalogue();

const registry: EvalRegistry = {
  findOfType: () => undefined,
  classify: async () => {
    throw new Error("offline only");
  },
  getProviderAuthStatus: () => ({ configured: true }),
};
const now = () => new Date("2026-10-14T00:00:00Z");
const concepts = archivedCatalogue.concepts.map((concept) => concept.id);

function fixtures(count: number, prefix: string): EvalFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index)}`,
    prompt: `Synthetic ${prefix} behavior ${String(index)}`,
    applicable: [concepts[index % 6] ?? ""],
    displayed: [concepts[index % 6] ?? ""],
  }));
}

const entry = (split: string, records: readonly EvalFixture[]) => ({
  file: `${split}.json`,
  records: records.length,
  sha256: hashBytes(JSON.stringify(records)),
});

function overlapFixtures(
  records: readonly EvalFixture[],
  development: readonly EvalFixture[],
): readonly EvalFixture[] {
  return records.map((fixture, index) =>
    index === 0
      ? { ...fixture, prompt: `  ${(development[0]?.prompt ?? "").toUpperCase()}  ` }
      : fixture,
  );
}
function sparseFixtures(records: readonly EvalFixture[]): readonly EvalFixture[] {
  return records.map((fixture, index) =>
    index % 6 === 0 && index > 12 ? { ...fixture, applicable: [], displayed: [] } : fixture,
  );
}

function unicodeFixtures(records: readonly EvalFixture[]): readonly EvalFixture[] {
  return records.map((fixture, index) =>
    index === 0 ? { ...fixture, id: "development\u2028\u2029first" } : fixture,
  );
}

function changedPolicy(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("dummy policy missing");
  }
  return { ...value, threshold: 0.91 };
}

describe("round two synthetic workflow", () => {
  let root = "";
  let calls = 0;
  let dev: readonly EvalFixture[] = [];
  let heldout: readonly EvalFixture[] = [];
  let instructionProb = 0.8;
  let criteriaProb = 0.9;
  let fail = false;
  let checkReservation = false;
  const evalsDir = () => join(root, "evals", "v2");
  const ledgerPath = () => join(root, "agent", "eval-ledger.json");
  const output = (variant: Variant | "heldout") => join(root, variant);
  const paths = () => ({
    catalogue: archivedCatalogue,
    ledgerPath: ledgerPath(),
    evalsDir: evalsDir(),
    policyPath: join(root, "policy.json"),
    now,
  });
  const matcher: Matcher = async (_registry, catalogue, prompt) => {
    calls += 1;
    if (checkReservation) {
      const ledger = await readLedger(ledgerPath());
      expect(ledger.attempts.at(-1)?.status).toBe("reserved");
      let key = "with-criteria";
      if (prompt.includes("acceptance")) {
        key = "heldout";
      } else if (catalogue.recognition[0]?.questionStyle === "instructions-focused") {
        key = "instructions-focused";
      }
      await expect(
        readJson(join(root, "agent", `round-2-${key}-receipt.json`)),
      ).resolves.toHaveProperty("planned");
    }
    if (fail) {
      return { ok: false, reason: "error" };
    }
    const fixture = [...dev, ...heldout].find((item) => item.prompt === prompt);
    const probability =
      catalogue.recognition[0]?.questionStyle === "instructions-focused"
        ? instructionProb
        : criteriaProb;
    return {
      ok: true,
      value: {
        usage: {
          input: 100,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        matches: catalogue.recognition.map((recognition) => ({
          recognition,
          concept: recognition.concept,
          tip: recognition.tip,
          probability:
            fixture?.displayed.includes(recognition.conceptId) === true ? probability : 0.01,
        })),
      },
    };
  };
  const blockAtCompletion =
    (blockage: string): Matcher =>
    async (...args) => {
      const result = await matcher(...args);
      if (calls === 200) {
        await mkdir(blockage);
      }
      return result;
    };
  const options = (
    variant: Variant | "heldout",
    extra: Partial<EvalOptions> = {},
  ): EvalOptions => ({
    dataset: "v2",
    catalogue: archivedCatalogue,
    ...(variant === "heldout" ? {} : { variant }),
    split: variant === "heldout" ? "heldout" : "development",
    repetitions: 2,
    outputDir: output(variant),
    dryRun: false,
    writePolicy: false,
    ledgerPath: ledgerPath(),
    evalsDir: evalsDir(),
    policyPath: join(root, "policy.json"),
    createRegistry: async () => registry,
    matcher,
    runId: variant,
    now,
    ...extra,
  });
  const both = async () => {
    await runEvaluation(options("instructions-focused"));
    await runEvaluation(options("with-criteria"));
  };
  const select = async () =>
    runOfflineOperation(
      {
        operation: "select",
        instructionsRun: output("instructions-focused"),
        criteriaRun: output("with-criteria"),
        output: join(root, "selection"),
      },
      paths(),
    );
  const freeze = async () =>
    runOfflineOperation(
      { operation: "freeze", selection: join(root, "selection"), output: "" },
      paths(),
    );
  const writeManifest = async () => {
    await writeFile(join(evalsDir(), "development.json"), JSON.stringify(dev));
    await writeFile(join(evalsDir(), "heldout.json"), JSON.stringify(heldout));
    await writeFile(
      join(evalsDir(), "manifest.json"),
      JSON.stringify({
        development: entry("development", dev),
        heldout: entry("heldout", heldout),
      }),
    );
  };
  const legacyReceipt = async (records: readonly EvalFixture[]) => {
    await mkdir(join(root, "agent"), { recursive: true });
    const text = JSON.stringify(records);
    await writeFile(join(root, "evals", "heldout.json"), text);
    await writeFile(
      join(root, "evals", "manifest.json"),
      JSON.stringify({
        heldout: { file: "heldout.json", sha256: hashBytes(text), records: records.length },
      }),
    );
    await writeFile(
      join(root, "agent", "heldout-receipt.json"),
      JSON.stringify({ heldoutFixtureHash: hashBytes(text) }),
    );
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "terminology-round-two-"));
    calls = 0;
    instructionProb = 0.8;
    criteriaProb = 0.9;
    fail = false;
    checkReservation = false;
    dev = fixtures(30, "development");
    heldout = fixtures(40, "acceptance");
    await mkdir(join(evalsDir(), "candidates"), { recursive: true });
    const text = await readFile(
      new URL("../evals/v2/candidates/with-criteria.json", import.meta.url),
      "utf8",
    );
    const document: unknown = JSON.parse(text);
    if (!isRecord(document) || !Array.isArray(document.recognition)) {
      throw new Error("invalid dummy catalogue");
    }
    await writeFile(join(evalsDir(), "candidates", "with-criteria.json"), text);
    await writeFile(
      join(evalsDir(), "candidates", "instructions-focused.json"),
      JSON.stringify({
        ...document,
        recognition: document.recognition.map((item: unknown) => {
          if (!isRecord(item)) {
            throw new Error("invalid dummy recognition");
          }
          return { ...item, questionStyle: "instructions-focused" };
        }),
      }),
    );
    await writeManifest();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("closed CLI variants and offline operations preserve the original default", () => {
    expect(
      parseCli(["--dataset", "v2", "--split", "development", "--variant", "instructions-focused"]),
    ).toMatchObject({ dataset: "v2", variant: "instructions-focused" });
    expect(
      parseCli([
        "--dataset",
        "v2",
        "--operation",
        "select",
        "--instructions-run",
        "a",
        "--criteria-run",
        "b",
        "--output",
        "c",
      ]),
    ).toMatchObject({ operation: "select", instructionsRun: "a", criteriaRun: "b" });
    for (const argv of [
      ["--dataset", "v3", "--split", "development"],
      ["--variant", "with-criteria", "--split", "development"],
      ["--dataset", "v2", "--variant", "third", "--split", "development"],
      ["--dataset", "v2", "--operation", "paid"],
      ["--dataset", "v2", "--operation", "select", "--split", "heldout"],
    ]) {
      expect(() => parseCli(argv)).toThrow(Error);
    }
  });
  test("dry run never opens credentials, held-out prompts, or creates files", async () => {
    await rm(join(evalsDir(), "heldout.json"));
    await expect(
      runEvaluation(
        options("instructions-focused", {
          dryRun: true,
          createRegistry: async () => {
            throw new Error("credential access");
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: "dry-run", plannedAttempts: 60 });
    await expect(readdir(root)).resolves.toStrictEqual(["evals"]);
    expect(calls).toBe(0);
  });
  test("requires exactly 60 attempts and fixed development variants", async () => {
    await expect(runEvaluation(options("with-criteria", { repetitions: 1 }))).rejects.toThrow(
      "two repetitions",
    );
    await expect(runEvaluation(options("with-criteria", { writePolicy: true }))).rejects.toThrow(
      "offline joint",
    );
    const missingVariant = options("heldout", { split: "development" });
    await expect(runEvaluation(missingVariant)).rejects.toThrow("fixed development");
  });
  test("reserves and writes immutable receipts before every first dispatch; cannot rerun with another ID", async () => {
    checkReservation = true;
    await runEvaluation(options("instructions-focused"));
    expect(calls).toBe(60);
    await expect(
      runEvaluation(
        options("instructions-focused", {
          outputDir: join(root, "new-output"),
          runId: "new-process",
        }),
      ),
    ).rejects.toThrow("already started");
    expect(calls).toBe(60);
  });
  test("joint offline selection and explicit freeze require both clean runs and do not dispatch", async () => {
    dev = unicodeFixtures(dev);
    await writeManifest();
    await runEvaluation(options("instructions-focused"));
    await expect(select()).rejects.toThrow(Error);
    await runEvaluation(options("with-criteria"));
    await expect(select()).resolves.toMatchObject({
      outcome: "selected",
      selectedCandidate: "with-criteria",
    });
    await expect(freeze()).resolves.toMatchObject({
      outcome: "frozen",
      selectedCandidate: "with-criteria",
    });
    expect(calls).toBe(120);
    await expect(readJson(join(root, "policy.json"))).resolves.toMatchObject({
      measured: false,
      threshold: 0.9,
    });
    await expect(freeze()).rejects.toThrow("already frozen");
  });
  test("ties use candidate ID, and freeze requires the exact selected runtime core", async () => {
    criteriaProb = instructionProb;
    await both();
    await expect(select()).resolves.toMatchObject({ selectedCandidate: "instructions-focused" });
    await expect(freeze()).rejects.toThrow("bundled core");
  });
  test("no qualifying candidate stops before any held-out prompt access", async () => {
    instructionProb = 0.1;
    criteriaProb = 0.1;
    await both();
    await rm(join(evalsDir(), "heldout.json"));
    await expect(select()).resolves.toMatchObject({
      outcome: "no-policy",
      selectedCandidate: null,
    });
    await expect(freeze()).rejects.toThrow("no candidate qualifies");
    await expect(runEvaluation(options("heldout"))).rejects.toThrow("no policy file");
    expect(calls).toBe(120);
  });
  test("both run artifacts and selection snapshots are integrity checked", async () => {
    await both();
    await select();
    await writeFile(join(root, "selection", "policy.json"), "{}");
    await expect(freeze()).rejects.toThrow("unmeasured policy mismatch");
    await writeFile(join(output("with-criteria"), "observations.jsonl"), "{}\n");
    await expect(
      runOfflineOperation(
        {
          operation: "select",
          instructionsRun: output("instructions-focused"),
          criteriaRun: output("with-criteria"),
          output: join(root, "tampered"),
        },
        paths(),
      ),
    ).rejects.toThrow("immutable native receipt");
  });
  test("one failed attempt burns its variant, retains the reservation, and leaves complete failure artifacts", async () => {
    fail = true;
    await expect(runEvaluation(options("instructions-focused"))).resolves.toMatchObject({
      outcome: "error",
    });
    expect(calls).toBe(1);
    const ledger = await readLedger(ledgerPath());
    expect(ledger.attempts[0]).toMatchObject({
      status: "failed",
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
    });
    await expect(
      readJson(join(output("instructions-focused"), "integrity.json")),
    ).resolves.toHaveProperty("artifactHash");
    fail = false;
    await runEvaluation(options("with-criteria"));
    await expect(select()).rejects.toThrow("did not complete cleanly");
  });
  test("held-out runs 80 times only at the frozen threshold and marks policy measured on pass", async () => {
    await both();
    await select();
    await freeze();
    checkReservation = true;
    const report = await runEvaluation(
      options("heldout", {
        writePolicy: true,
        matcher: async (...args) => {
          await expect(readJson(join(root, "policy.json"))).resolves.toHaveProperty(
            "measured",
            false,
          );
          return matcher(...args);
        },
      }),
    );
    const sealedHash = await artifactHash(output("heldout"));
    await expect(readJson(join(output("heldout"), "integrity.json"))).resolves.toHaveProperty(
      "artifactHash",
      sealedHash,
    );
    await expect(readJson(join(root, "agent", "round-2.json"))).resolves.toHaveProperty(
      "receipts.heldout.artifactHash",
      sealedHash,
    );
    expect(report).toMatchObject({ outcome: "passed", plannedAttempts: 80, threshold: 0.9 });
    expect(calls).toBe(200);
    await expect(readJson(join(root, "policy.json"))).resolves.toMatchObject({ measured: true });
    await expect(readJson(join(output("heldout"), "run.json"))).resolves.toHaveProperty(
      "sweep",
      null,
    );
  });
  test.each([
    { stage: "integrity creation", blockage: "heldout/integrity.json", code: "EEXIST" },
    {
      stage: "native finalization",
      blockage: `agent/round-2.json.${String(process.pid)}.tmp`,
      code: "EISDIR",
    },
  ])(
    "$stage failure after 200 fake calls leaves runtime policy unmeasured and burns the receipt",
    async ({ blockage, code }) => {
      await both();
      await select();
      await freeze();
      const frozenPolicy = await readFile(join(root, "policy.json"), "utf8");
      const nativeReceipt = await readFile(
        join(root, "agent", "round-2-with-criteria-receipt.json"),
        "utf8",
      );
      await expect(
        runEvaluation(
          options("heldout", {
            writePolicy: true,
            matcher: blockAtCompletion(join(root, blockage)),
          }),
        ),
      ).rejects.toThrow(code);
      expect(calls).toBe(200);
      await expect(readFile(join(root, "policy.json"), "utf8")).resolves.toBe(frozenPolicy);
      await expect(readJson(join(root, "policy.json"))).resolves.toHaveProperty("measured", false);
      await expect(readJson(join(root, "agent", "round-2.json"))).resolves.toHaveProperty(
        "receipts.heldout.artifactHash",
        null,
      );
      await expect(
        readJson(join(root, "agent", "round-2-heldout-receipt.json")),
      ).resolves.toMatchObject({
        planned: 80,
        outputDir: output("heldout"),
      });
      await expect(
        readFile(join(root, "agent", "round-2-with-criteria-receipt.json"), "utf8"),
      ).resolves.toBe(nativeReceipt);
      const observations = await readFile(join(output("heldout"), "observations.jsonl"), "utf8");
      expect(observations.trimEnd().split("\n")).toHaveLength(80);
      const ledger = await readLedger(ledgerPath());
      expect(ledger.attempts).toHaveLength(200);
      expect(ledger.attempts.every((item) => item.status === "succeeded")).toBe(true);
      expect(ledger.attempts.reduce((sum, item) => sum + item.reservedNanos, 0)).toBe(
        200 * ATTEMPT_RESERVATION_NANOS,
      );
      await expect(
        runEvaluation(options("heldout", { outputDir: join(root, "retry"), runId: "retry" })),
      ).rejects.toThrow("already started");
      expect(calls).toBe(200);
    },
  );
  test("cumulative reservations preserve 108 old attempts plus 200 new attempts", async () => {
    const ledger = await openLedger(ledgerPath());
    for (let index = 0; index < 108; index += 1) {
      const id = `legacy/development/${String(index)}`;
      await ledger.reserve(id);
      await ledger.settleFailure(id);
    }
    await ledger.close();
    await both();
    await select();
    await freeze();
    await runEvaluation(options("heldout"));
    const final = await readLedger(ledgerPath());
    expect(final.attempts).toHaveLength(308);
    expect(final.attempts.reduce((sum, item) => sum + item.reservedNanos, 0)).toBe(847_773_696);
    const capped = await openLedger(ledgerPath());
    await expect(reserveRoundAttempt(capped, "heldout", "round-2/heldout/extra/0")).rejects.toThrow(
      "dispatch allowance exhausted",
    );
    await capped.close();
    await expect(
      runEvaluation(options("heldout", { runId: "new-process", outputDir: join(root, "retry") })),
    ).rejects.toThrow("budget");
  });
  test("canonical prompt reuse fails after receipt and before calls, regardless of labels", async () => {
    heldout = overlapFixtures(heldout, dev);
    await writeManifest();
    await both();
    await select();
    await freeze();
    const report = await runEvaluation(options("heldout"));
    expect(report.outcome).toBe("error");
    expect(calls).toBe(120);
    await expect(readJson(join(output("heldout"), "round-receipt.json"))).resolves.toHaveProperty(
      "planned",
      80,
    );
  });
  test("four distinct eligible positive prompts per concept is mandatory", async () => {
    heldout = sparseFixtures(heldout);
    await writeManifest();
    await both();
    await select();
    await freeze();
    await expect(runEvaluation(options("heldout", { writePolicy: true }))).resolves.toMatchObject({
      outcome: "error",
    });
    expect(calls).toBe(120);
    await expect(readJson(join(root, "policy.json"))).resolves.toMatchObject({ measured: false });
  });
  test("a held-out recall failure leaves policy unmeasured and prevents reruns", async () => {
    await both();
    await select();
    await freeze();
    criteriaProb = 0.1;
    await expect(runEvaluation(options("heldout", { writePolicy: true }))).resolves.toMatchObject({
      outcome: "failed",
    });
    await expect(readJson(join(root, "policy.json"))).resolves.toMatchObject({ measured: false });
    await expect(
      runEvaluation(options("heldout", { outputDir: join(root, "again") })),
    ).rejects.toThrow("already started");
  });
  test("missing, corrupt or mismatched native state fails closed without resetting allowance", async () => {
    await runEvaluation(options("instructions-focused"));
    await rm(join(root, "agent", "round-2.json"));
    await expect(runEvaluation(options("with-criteria"))).rejects.toThrow("missing round receipt");
    await writeFile(join(root, "agent", "round-2.json"), "not json");
    await expect(
      runEvaluation(options("with-criteria", { outputDir: join(root, "third") })),
    ).rejects.toThrow("corrupt round receipt");
    expect(calls).toBe(60);
  });
  test("legacy consumed prompts cannot become fresh held-out by relabeling or formatting", async () => {
    const old = fixtures(2, "old-heldout");
    await legacyReceipt(old);
    const originalReceipt = await readFile(join(root, "agent", "heldout-receipt.json"), "utf8");
    heldout = overlapFixtures(heldout, old);
    await writeManifest();
    await both();
    await select();
    await freeze();
    await expect(runEvaluation(options("heldout"))).resolves.toMatchObject({ outcome: "error" });
    expect(calls).toBe(120);
    await expect(readFile(join(root, "agent", "heldout-receipt.json"), "utf8")).resolves.toBe(
      originalReceipt,
    );
  });
  test("legacy consumption hash and immutable native variant receipts fail closed", async () => {
    await legacyReceipt(fixtures(2, "legacy"));
    await writeFile(join(root, "evals", "heldout.json"), "[]");
    await expect(runEvaluation(options("instructions-focused"))).rejects.toThrow(
      "legacy consumed fixture was modified",
    );
    await legacyReceipt(fixtures(2, "legacy"));
    await runEvaluation(options("instructions-focused", { outputDir: join(root, "fresh") }));
    await writeFile(join(root, "agent", "round-2-instructions-focused-receipt.json"), "{}");
    await expect(runEvaluation(options("with-criteria"))).rejects.toThrow(
      "immutable receipt mismatch",
    );
    expect(calls).toBe(60);
  });
  test("a held-out transport failure never marks the policy measured", async () => {
    await both();
    await select();
    await freeze();
    fail = true;
    await expect(runEvaluation(options("heldout", { writePolicy: true }))).resolves.toMatchObject({
      outcome: "error",
    });
    expect(calls).toBe(121);
    await expect(readJson(join(root, "policy.json"))).resolves.toMatchObject({ measured: false });
  });
  test("exact native policy binding is required before any held-out load", async () => {
    await both();
    await select();
    await freeze();
    const policy = await readJson(join(root, "policy.json"));
    await writeFile(join(root, "policy.json"), JSON.stringify(changedPolicy(policy)));
    await rm(join(evalsDir(), "heldout.json"));
    await expect(runEvaluation(options("heldout"))).rejects.toThrow("exactly match");
    expect(calls).toBe(120);
  });
  test("round state rejects ledger drift and changed catalogue or manifest metadata", async () => {
    await runEvaluation(options("instructions-focused"));
    const context = await roundContext(evalsDir(), ledgerPath());
    const ledger = await openLedger(ledgerPath());
    await ledger.reserve("unrelated-change");
    await expect(readRoundState(context, ledger)).rejects.toThrow("budget binding mismatch");
    await ledger.close();
  });
});
