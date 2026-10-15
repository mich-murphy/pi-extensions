import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { criteriaHash } from "../catalogue";
import { classifierWireQuestions } from "../classifier-request";
import { ATTEMPT_RESERVATION_NANOS, emptyLedger, openLedger, readLedger } from "../eval-budget";
import { matchWithNativeClassifier } from "../native-matcher";
import { main, runProductionVerification } from "../scripts/verify-production";
import type {
  ProductionRegistry,
  ProductionVerificationOptions,
} from "../scripts/verify-production";
import type { Catalogue, Policy } from "../types";
import { composeGlossaries } from "../validation";

const A = "core:alpha";
const B = "core:beta";
const model: ClassifierModel<"typesafe-system-one"> = {
  type: "classifier",
  id: "jev-latest",
  name: "Jev",
  api: "typesafe-system-one",
  provider: "typesafe",
  baseUrl: "https://example.invalid/",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
};
const usage = {
  input: 100,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 101,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function catalogue(): Catalogue {
  const composed = composeGlossaries([
    {
      schemaVersion: 1,
      namespace: "core",
      concepts: [A, B].map((id) => ({
        id,
        label: id === A ? "Alpha technique" : "Beta technique",
        domain: "testing",
        definition: "A software practice.",
        references: [],
      })),
      recognition: [A, B].map((conceptId) => ({
        conceptId,
        matches: "Current real work.",
        doesNotMatch: "A hypothetical question.",
        tip: "A software practice.",
        questionStyle: "no-criteria",
      })),
    },
  ]);
  if (!composed.ok) {
    throw new Error(composed.errors.join("\n"));
  }
  return composed.value;
}
type Fixture = {
  id: string;
  prompt: string;
  labels: Record<string, "positive" | "negative" | "ambiguous">;
  named: string[];
};
function fixture(
  id: string,
  label: "positive" | "negative" | "ambiguous" = "positive",
  prompt = `Perform current work ${id}`,
): Fixture {
  return { id, prompt, labels: { [A]: label, [B]: label }, named: [] as string[] };
}

const DEFAULT_PROBABILITIES = { [A]: 0.85, [B]: 0.91 };
function native(probabilities: Record<string, number> = DEFAULT_PROBABILITIES): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-1.13.0",
    timestamp: 1,
    stopReason: "stop",
    usage,
    answers: Object.fromEntries(
      Object.entries(probabilities).map(([id, probability]) => [id, { type: "bool", probability }]),
    ),
  };
}

function failedAnswer(problem: string): ClassifierResult {
  if (problem === "throws") {
    throw new Error("PRIVATE-TEXT-AND-TOKEN");
  }
  const value = native();
  if (problem === "missing-answer") {
    return native({ [A]: 1 });
  }
  if (problem === "missing-usage") {
    const { usage: _usage, ...rest } = value;
    return rest;
  }
  if (problem === "invalid-usage") {
    return { ...value, usage: { ...usage, input: 0 } };
  }
  if (problem === "nan") {
    return native({ [A]: Number.NaN, [B]: 1 });
  }
  return { ...value, stopReason: "error" };
}

function invalidFixtures(problem: string): Fixture[] {
  const value = fixture("public-1");
  if (problem === "duplicate-id") {
    return [value, value];
  }
  if (problem === "incomplete-labels") {
    return [{ ...value, labels: { [A]: "positive" } }];
  }
  if (problem === "unknown-label") {
    return [{ ...value, labels: { ...value.labels, "core:unknown": "negative" } }];
  }
  if (problem === "named-negative") {
    return [{ ...fixture("negative", "negative"), named: [A] }];
  }
  if (problem === "no-positive") {
    return [fixture("negative", "negative")];
  }
  if (problem === "empty") {
    return [];
  }
  return Array.from({ length: 81 }, (_, i) => fixture(`fixture-${i}`));
}
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing test dependency.");
  }
  return value;
}
function invalidPolicy(original: Policy, problem: string): Policy {
  const policy = { ...original };
  if (problem === "measured") {
    policy.measured = true;
    policy.measuredDisplayedPrecision = 1;
    policy.fixtureHash = sha("manifest");
  }
  if (problem === "missing-map") {
    delete policy.conceptThresholds;
  }
  if (problem === "old-target") {
    delete policy.precisionTarget;
  }
  if (problem === "wrong-hash") {
    policy.criteriaHash = sha("stale");
  }
  return policy;
}
function thresholdAnswer(prompt: string): ClassifierResult {
  return prompt.endsWith("low") ? native({ [A]: 0.849, [B]: 0.909 }) : native();
}
function recallAnswer(prompt: string): ClassifierResult {
  return native({ [A]: 1, [B]: prompt.endsWith("public-1") ? 1 : 0 });
}

describe("single-use local production verification", () => {
  let root: string;
  let options: ProductionVerificationOptions;
  let calls: number;
  let createRegistry: ReturnType<typeof vi.fn<() => Promise<ProductionRegistry>>>;
  let answer: (prompt: string) => ClassifierResult;
  let contexts: unknown[];
  let wire: unknown[];
  const ledgerPath = () =>
    join(root, "agent", "pi-terminology", "production-verification", "eval-ledger.json");
  const receiptPath = () =>
    join(root, "agent", "pi-terminology", "production-verification", "receipt.json");

  async function datasets(synthetic: readonly Fixture[], privateFixtures?: readonly Fixture[]) {
    const sets = [
      { name: "public", kind: "synthetic", fixtures: synthetic },
      ...(privateFixtures === undefined
        ? []
        : [{ name: "local", kind: "private", fixtures: privateFixtures }]),
    ];
    const entries = [];
    for (const set of sets) {
      const file = `${set.name}.json`;
      const bytes = JSON.stringify(set.fixtures);
      await writeFile(join(root, file), bytes);
      entries.push({
        name: set.name,
        kind: set.kind,
        file,
        sha256: sha(bytes),
        records: set.fixtures.length,
      });
    }
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, datasets: entries, precisionTarget: 0.9 }),
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "production-verification-"));
    calls = 0;
    contexts = [];
    wire = [];
    answer = () => native();
    const value = catalogue();
    const policy: Policy = {
      schemaVersion: 1,
      model: "jev-1.13.0",
      catalogueHash: value.hash,
      criteriaHash: criteriaHash(value),
      fixtureHash: "pending",
      threshold: 0.99,
      conceptThresholds: { [A]: 0.85, [B]: 0.91 },
      precisionTarget: 0.9,
      measuredDisplayedPrecision: 0,
      measured: false,
    };
    const registry: ProductionRegistry = {
      findOfType: (type, provider, id) => {
        expect([type, provider, id]).toStrictEqual(["classifier", "typesafe", "jev-latest"]);
        return model;
      },
      getProviderAuthStatus: () => ({ configured: true }),
      classify: async (classified, context, classifierOptions) => {
        calls += 1;
        const ledger = await readLedger(ledgerPath());
        expect(ledger.attempts.at(-1)).toMatchObject({
          status: "reserved",
          reservedNanos: ATTEMPT_RESERVATION_NANOS,
        });
        const receipt = JSON.parse(await readFile(receiptPath(), "utf8")) as unknown;
        expect(receipt).toMatchObject({
          threshold: 0.99,
          conceptThresholds: { [A]: 0.85, [B]: 0.91 },
        });
        expect(classified.id).toBe("jev-1.13.0");
        expect(classifierOptions).toMatchObject({ maxRetries: 0, timeoutMs: 5000 });
        expect(classifierOptions?.signal).toBeInstanceOf(AbortSignal);
        contexts.push(context);
        const questions = Object.fromEntries(
          Object.entries(context.questions).map(([id, question]) => [
            id,
            { ...question, type: "noul" },
          ]),
        );
        wire.push(
          await classifierOptions?.onPayload?.(
            {
              model: classified.id,
              state: context.state,
              questions,
            },
            classified,
          ),
        );
        return answer(
          typeof context.state.prompt === "string" ? context.state.prompt : "invalid state",
        );
      },
    };
    createRegistry = vi.fn<() => Promise<ProductionRegistry>>(async () => registry);
    options = {
      manifest: join(root, "manifest.json"),
      output: join(root, "out"),
      agentDir: join(root, "agent"),
      catalogue: value,
      policy,
      createRegistry,
    };
    await datasets([fixture("public-1")]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  test("dry-run validates committed files and all 360 reservations without auth or writes", async () => {
    const filesBefore = await readdir(root, { recursive: true });
    const report = await runProductionVerification({ ...options, dryRun: true, writePolicy: true });
    expect(report).toMatchObject({
      outcome: "dry-run",
      plannedCalls: 1,
      maxCalls: 360,
      repeats: 1,
      retries: 0,
      policyWritten: false,
      budget: { plannedAttempts: 360, plannedReserveNanos: 360 * ATTEMPT_RESERVATION_NANOS },
    });
    expect(createRegistry).not.toHaveBeenCalled();
    expect(calls).toBe(0);
    await expect(readdir(root, { recursive: true })).resolves.toStrictEqual(filesBefore);
  });

  test("reserves durably, dispatches actual native questions and retains full cost after settlement", async () => {
    const report = await runProductionVerification(options);
    expect(report).toMatchObject({
      outcome: "passed",
      policyWritten: false,
      metrics: { overall: { overall: { tp: 2, fp: 0, precision: 1 } } },
      ledger: {
        attempts: 1,
        inputTokens: 100,
        outputTokens: 1,
        jevObservedNanos: 4200,
        jevReservedNanos: ATTEMPT_RESERVATION_NANOS,
        nativeCostUsd: 0,
      },
    });
    expect(contexts).toStrictEqual([
      {
        state: {
          prompt: "Perform current work public-1",
          user_prompt_to_coding_agent: "Perform current work public-1",
        },
        questions: Object.fromEntries(
          required(options.catalogue).recognition.map((item) => [item.conceptId, item.question]),
        ),
      },
    ]);
    expect(wire).toStrictEqual([
      {
        model: "jev-1.13.0",
        state: {
          prompt: "Perform current work public-1",
          user_prompt_to_coding_agent: "Perform current work public-1",
        },
        questions: classifierWireQuestions(required(options.catalogue)),
      },
    ]);
    const settled = await readLedger(ledgerPath());
    expect(settled.attempts[0]).toMatchObject({
      status: "succeeded",
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
    });
    const outputStat = await stat(options.output);
    expect(outputStat.mode & 0o777).toBe(0o700);
    for (const file of [join(options.output, "observations.jsonl"), receiptPath()]) {
      const fileStat = await stat(file);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
    const reportText = await readFile(join(options.output, "report.json"), "utf8");
    expect(reportText).not.toContain("Perform current work");
    expect(reportText).not.toContain("public-1");
    expect(reportText).not.toContain("Wilson");
  });

  test("uses mixed thresholds and extracted runtime name suppression, never gold named as an oracle", async () => {
    const named = {
      ...fixture("named", "positive", "Use Alpha technique and Beta technique."),
      named: [A, B],
    };
    const annotation = fixture(
      "annotation",
      "positive",
      "## Annotation\nAlpha technique and Beta technique\n> Implement the current work.",
    );
    const disagreement = {
      ...fixture("gold-named", "positive", "Implement other current work."),
      named: [A, B],
    };
    const low = fixture("low");
    await datasets([fixture("public-1"), named, annotation, disagreement, low]);
    answer = thresholdAnswer;
    const matcher = vi.fn<typeof matchWithNativeClassifier>(matchWithNativeClassifier);
    const report = await runProductionVerification({ ...options, matcher });
    expect(matcher).toHaveBeenCalledTimes(5);
    expect(matcher.mock.calls[0]?.slice(3)).toStrictEqual([
      0.99,
      expect.any(AbortSignal),
      { [A]: 0.85, [B]: 0.91 },
    ]);
    expect(report.metrics?.overall.overall).toMatchObject({
      tp: 4,
      fp: 2,
      fn: 2,
      redundantReminderFp: 2,
    });
    const rawText = await readFile(join(options.output, "observations.jsonl"), "utf8");
    const raw = rawText
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(raw[1]).toMatchObject({ observation: { alreadyNamed: [A, B] }, selected: [] });
    expect(raw[2]).toMatchObject({ observation: { alreadyNamed: [] }, selected: [A, B] });
    expect(contexts[2]).toMatchObject({ state: { prompt: "Implement the current work." } });
  });

  test("accepts 90% scored precision rather than the historical 95%, with ambiguity report-only", async () => {
    await datasets([
      ...Array.from({ length: 9 }, (_, i) => fixture(`positive-${i}`)),
      fixture("false", "negative"),
      fixture("ambiguous", "ambiguous"),
    ]);
    const report = await runProductionVerification(options);
    expect(report.outcome).toBe("passed");
    expect(report.precisionTarget).toBe(0.9);
    expect(report.metrics?.overall.overall).toMatchObject({
      precision: 0.9,
      ambiguousHits: 2,
      conservativePrecision: 18 / 22,
    });
  });

  test("private precision must pass independently and failed acceptance cannot activate", async () => {
    await datasets(
      Array.from({ length: 9 }, (_, i) => fixture(`positive-${i}`)),
      [fixture("private-negative", "negative")],
    );
    const report = await runProductionVerification({ ...options, writePolicy: true });
    expect(report.metrics?.overall.overall.precision).toBe(0.9);
    expect(report.metrics?.private?.overall.precision).toBe(0);
    expect(report).toMatchObject({ outcome: "failed", policyWritten: false });
  });

  test("synthetic recall must reach half for each concept", async () => {
    await datasets([fixture("public-1"), fixture("public-2"), fixture("public-3")]);
    answer = recallAnswer;
    const report = await runProductionVerification({ ...options, writePolicy: true });
    expect(report).toMatchObject({ outcome: "failed", policyWritten: false });
    expect(report.metrics?.synthetic.perConcept[B]?.recall).toBe(1 / 3);
  });

  test.each(["missing-answer", "missing-usage", "invalid-usage", "nan", "native-error", "throws"])(
    "%s burns the receipt, stops immediately and never activates",
    async (problem) => {
      await datasets([fixture("public-1"), fixture("public-2")]);
      answer = () => failedAnswer(problem);
      const report = await runProductionVerification({ ...options, writePolicy: true });
      expect(report).toMatchObject({ outcome: "error", policyWritten: false });
      expect(calls).toBe(1);
      const settled = await readLedger(ledgerPath());
      expect(settled.attempts).toMatchObject([
        { status: "failed", reservedNanos: ATTEMPT_RESERVATION_NANOS },
      ]);
      expect(JSON.stringify(report)).not.toContain("PRIVATE-TEXT");
      await expect(
        runProductionVerification({ ...options, output: join(root, "escape") }),
      ).rejects.toThrow(/receipt/u);
      expect(calls).toBe(1);
    },
  );

  test("a successful run is also single-use even with another output directory", async () => {
    await runProductionVerification(options);
    await expect(
      runProductionVerification({ ...options, output: join(root, "out-2") }),
    ).rejects.toThrow(/receipt/u);
    expect(createRegistry).toHaveBeenCalledTimes(1);
  });

  test("registry/auth failure consumes the frozen receipt before any dispatch", async () => {
    const report = await runProductionVerification({
      ...options,
      createRegistry: async () => {
        expect(JSON.parse(await readFile(receiptPath(), "utf8"))).toMatchObject({
          plannedCalls: 1,
        });
        throw new Error("private credential error");
      },
    });
    expect(report).toMatchObject({
      outcome: "error",
      policyWritten: false,
      ledger: { attempts: 0 },
    });
    expect(calls).toBe(0);
    await expect(
      runProductionVerification({ ...options, output: join(root, "out-2") }),
    ).rejects.toThrow(/receipt/u);
  });

  test("all 360 reservations must fit, even for a tiny manifest, without resetting ledgers", async () => {
    await mkdir(join(root, "agent", "pi-terminology", "production-verification"), {
      recursive: true,
    });
    const ledger = await openLedger(ledgerPath());
    for (let i = 0; i < 4; i += 1) {
      await ledger.reserve(`old-${i}`);
      await ledger.settleFailure(`old-${i}`);
    }
    await ledger.close();
    const before = await readFile(ledgerPath(), "utf8");
    await expect(runProductionVerification({ ...options, dryRun: true })).rejects.toThrow(/360/u);
    await expect(runProductionVerification(options)).rejects.toThrow(/360/u);
    await expect(readFile(ledgerPath(), "utf8")).resolves.toBe(before);
    expect(createRegistry).not.toHaveBeenCalled();
  });

  test("honours the existing exclusive ledger lock", async () => {
    const ledger = await openLedger(ledgerPath());
    try {
      await expect(runProductionVerification(options)).rejects.toThrow(/locked/u);
      expect(createRegistry).not.toHaveBeenCalled();
    } finally {
      await ledger.close();
    }
  });

  test("hash mismatch fails closed before auth, directories or receipt", async () => {
    await writeFile(join(root, "public.json"), "[]");
    const before = await readdir(root, { recursive: true });
    await expect(runProductionVerification(options)).rejects.toThrow(/SHA-256/u);
    expect(createRegistry).not.toHaveBeenCalled();
    await expect(readdir(root, { recursive: true })).resolves.toStrictEqual(before);
  });

  test.each([
    "duplicate-id",
    "incomplete-labels",
    "unknown-label",
    "named-negative",
    "no-positive",
    "empty",
    "too-many",
  ])("rejects %s before dispatch", async (problem) => {
    const records = invalidFixtures(problem);
    await datasets(records);
    await expect(runProductionVerification(options)).rejects.toThrow(/./u);
    expect(createRegistry).not.toHaveBeenCalled();
  });

  test("validates record counts and globally unique IDs across datasets", async () => {
    await datasets([fixture("same")], [fixture("same")]);
    await expect(runProductionVerification(options)).rejects.toThrow(/unique/u);
    await datasets([fixture("different")]);
    const path = join(root, "manifest.json");
    const manifest = {
      schemaVersion: 1,
      precisionTarget: 0.9,
      datasets: [
        {
          name: "public",
          kind: "synthetic",
          file: "public.json",
          records: 2,
          sha256: sha(JSON.stringify([fixture("different")])),
        },
      ],
    };
    await writeFile(path, JSON.stringify(manifest));
    await expect(runProductionVerification(options)).rejects.toThrow(/count/u);
  });

  test.each(["measured", "missing-map", "old-target", "wrong-hash"])(
    "refuses %s policies before auth",
    async (problem) => {
      const policy = invalidPolicy(required(options.policy), problem);
      await expect(runProductionVerification({ ...options, policy })).rejects.toThrow(
        /unmeasured policy/u,
      );
      expect(createRegistry).not.toHaveBeenCalled();
    },
  );

  test("activation rechecks the current policy snapshot and refuses threshold mutation", async () => {
    const factory = required(options.createRegistry);
    const report = await runProductionVerification({
      ...options,
      writePolicy: true,
      createRegistry: async () => {
        const registry = await factory();
        Object.assign(required(required(options.policy).conceptThresholds), { [A]: 0.86 });
        return registry;
      },
    });
    expect(report).toMatchObject({ outcome: "error", policyWritten: false });
    expect(calls).toBe(1);
  });

  test("existing output is refused without consuming receipt or constructing auth", async () => {
    await mkdir(options.output);
    await expect(runProductionVerification(options)).rejects.toThrow(/already exists/u);
    expect(createRegistry).not.toHaveBeenCalled();
    await expect(stat(receiptPath())).rejects.toThrow(/./u);
  });

  test("CLI rejects ledger/auth/profile overrides and positional arguments", async () => {
    for (const args of [["--ledger", "x"], ["--auth", "x"], ["--profile", "x"], ["position"]]) {
      await expect(main(args)).rejects.toThrow(/./u);
    }
    expect(createRegistry).not.toHaveBeenCalled();
  });

  test("malformed budget ledger is never reset", async () => {
    await mkdir(join(root, "agent", "pi-terminology", "production-verification"), {
      recursive: true,
    });
    const malformed = JSON.stringify({ ...emptyLedger(), otherCostNanos: -1 });
    await writeFile(ledgerPath(), malformed);
    await expect(runProductionVerification({ ...options, dryRun: true })).rejects.toThrow(/./u);
    await expect(readFile(ledgerPath(), "utf8")).resolves.toBe(malformed);
    expect(createRegistry).not.toHaveBeenCalled();
  });
});
