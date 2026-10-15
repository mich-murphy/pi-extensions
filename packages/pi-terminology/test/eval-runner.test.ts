import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { criteriaHash } from "../catalogue";
import { ATTEMPT_RESERVATION_NANOS, readLedger } from "../eval-budget";
import {
  EvalCliError,
  createNativeRegistry,
  parseCli,
  refreshTypesafeAuthSnapshot,
  runCli,
  runEvaluation,
} from "../scripts/evaluate";
import type { EvalCliDependencies, EvalOptions, EvalRegistry, Matcher } from "../scripts/evaluate";
import { historicalCatalogue } from "./historical-fixture";

const archivedCatalogue = historicalCatalogue();

const TDD = "core:test-driven-development";
const REFACTORING = "core:refactoring";
const MUTATION = "core:mutation-testing";

const fixtureRecords = [
  { id: "t-1", prompt: "Alpha prompt", applicable: [TDD], displayed: [TDD] },
  { id: "t-2", prompt: "Beta prompt", applicable: [REFACTORING], displayed: [REFACTORING] },
  { id: "t-3", prompt: "Gamma prompt", applicable: [], displayed: [] },
];

const scripted: Record<string, Record<string, number>> = {
  "Alpha prompt": { [TDD]: 0.9 },
  "Beta prompt": { [REFACTORING]: 0.8 },
  "Gamma prompt": { [MUTATION]: 0.6 },
};

const usage: Usage = {
  input: 100,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 101,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const scriptedMatcher: Matcher = async (_registry, catalogue, prompt) => {
  const given = scripted[prompt] ?? {};
  const matches = catalogue.recognition.map((recognition) => ({
    concept: recognition.concept,
    recognition,
    probability: given[recognition.conceptId] ?? 0.05,
    tip: recognition.tip,
  }));
  return { ok: true, value: { matches, usage } };
};

const registryFor = (configured: boolean): EvalRegistry => ({
  findOfType: () => undefined,
  classify: async () => {
    throw new Error("offline");
  },
  getProviderAuthStatus: () => ({ configured }),
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const fileExists = async (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const frozenPolicy = (overrides: object = {}) => {
  const catalogue = archivedCatalogue;
  return {
    schemaVersion: 1,
    model: "jev-1.13.0",
    catalogueHash: catalogue.hash,
    criteriaHash: criteriaHash(catalogue),
    fixtureHash: sha(JSON.stringify(fixtureRecords)),
    threshold: 0.8,
    measuredDisplayedPrecision: 1,
    measured: false,
    ...overrides,
  };
};

const noUsage: Matcher = async (registry, catalogue, prompt) => {
  const result = await scriptedMatcher(registry, catalogue, prompt, 0, AbortSignal.timeout(1000));
  return { ok: true, value: { matches: result.ok ? result.value.matches : [] } };
};

const throwing: Matcher = async () => {
  throw new Error("secret-key-123");
};

function invalidMatcher(problem: string): Matcher {
  return async (...args) => {
    const result = await scriptedMatcher(...args);
    if (!result.ok) {
      throw new Error("dummy matcher failed");
    }
    const first = result.value.matches[0];
    if (first === undefined) {
      throw new Error("dummy catalogue missing");
    }
    const matches =
      problem === "duplicate"
        ? result.value.matches.map(() => first)
        : result.value.matches.map((match) => ({ ...match, probability: Number.NaN }));
    return { ok: true, value: { ...result.value, matches } };
  };
}

describe("runEvaluation", () => {
  let root = "";
  let calls = 0;
  let registries = 0;

  const countingMatcher: Matcher = async (...args) => {
    calls += 1;
    return scriptedMatcher(...args);
  };

  const options = (overrides: Partial<EvalOptions> = {}): EvalOptions => ({
    split: "development",
    catalogue: archivedCatalogue,
    repetitions: 1,
    outputDir: join(root, "out"),
    dryRun: false,
    writePolicy: false,
    ledgerPath: join(root, "agent", "ledger.json"),
    evalsDir: join(root, "evals"),
    policyPath: join(root, "policy.json"),
    createRegistry: async () => {
      registries += 1;
      return registryFor(true);
    },
    matcher: countingMatcher,
    runId: "run-1",
    now: () => new Date("2026-10-14T00:00:00Z"),
    ...overrides,
  });

  const heldoutOptions = (overrides: Partial<EvalOptions> = {}) =>
    options({ split: "heldout", repetitions: 2, ...overrides });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eval-runner-"));
    calls = 0;
    registries = 0;
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const text = JSON.stringify(fixtureRecords);
    const entry = (file: string) => ({ file, sha256: sha(text), records: 3 });
    const manifest = { development: entry("development.json"), heldout: entry("heldout.json") };
    await mkdir(join(root, "evals"));
    await writeFile(join(root, "evals", "development.json"), text);
    await writeFile(join(root, "evals", "heldout.json"), text);
    await writeFile(join(root, "evals", "manifest.json"), JSON.stringify(manifest));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  test("a dry run previews the budget and touches nothing", async () => {
    const report = await runEvaluation(options({ dryRun: true, repetitions: 2 }));
    expect(report).toMatchObject({ outcome: "dry-run", plannedAttempts: 6 });
    expect(report.budget.plannedReserveNanos).toBe(6 * ATTEMPT_RESERVATION_NANOS);
    expect(registries).toBe(0);
    expect(calls).toBe(0);
    await expect(readdir(root)).resolves.not.toContain("agent");
    await expect(fileExists(join(root, "out"))).resolves.toBe(false);
  });

  test("warms native TypeSafe environment auth before the cheap status check", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "synthetic-env-key");
    const registry = await createNativeRegistry(join(root, "native-agent"));
    expect(registry.getProviderAuthStatus("typesafe")).toMatchObject({
      configured: true,
      source: "environment",
    });
  });

  test("warms native TypeSafe stored auth before the cheap status check", async () => {
    const agentDir = join(root, "native-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ typesafe: { type: "api_key", key: "synthetic-stored-key" } }),
    );
    const registry = await createNativeRegistry(agentDir);
    expect(registry.getProviderAuthStatus("typesafe")).toMatchObject({
      configured: true,
      source: "stored",
    });
  });

  test("checks only TypeSafe auth locally and sanitizes refresh failures", async () => {
    const refreshCalls: unknown[] = [];
    await expect(
      refreshTypesafeAuthSnapshot({
        refresh: async (refreshOptions) => {
          refreshCalls.push(refreshOptions);
          return { aborted: false, errors: new Map([["typesafe", new Error("secret-key-123")]]) };
        },
      }),
    ).rejects.toThrow("credential check failed");
    expect(JSON.stringify(refreshCalls)).toContain('"providers":["typesafe"]');
    expect(JSON.stringify(refreshCalls)).toContain('"allowNetwork":false');
    await expect(
      refreshTypesafeAuthSnapshot({
        refresh: async () => {
          throw new Error("!printf secret-key-123");
        },
      }),
    ).rejects.not.toThrow("secret-key-123");
  });

  test("a development run sweeps offline, picks the highest passing threshold and writes a policy", async () => {
    const report = await runEvaluation(options({ writePolicy: true }));
    expect(report).toMatchObject({ outcome: "policy-written", threshold: 0.8, plannedAttempts: 3 });
    expect(report.metrics?.displayed).toMatchObject({
      tp: 2,
      fp: 0,
      fn: 0,
      meetsPrecisionTarget: true,
    });
    expect(calls).toBe(3);
    const policy: unknown = JSON.parse(await readFile(join(root, "policy.json"), "utf8"));
    expect(policy).toMatchObject({
      threshold: 0.8,
      measured: false,
      fixtureHash: sha(JSON.stringify(fixtureRecords)),
    });
    const summary: unknown = JSON.parse(await readFile(join(root, "out", "run.json"), "utf8"));
    expect(summary).toMatchObject({
      requestedModel: "jev-1.13.0",
      prompts: 3,
      budget: {
        run: { attempts: 3, reservedNanos: 3 * ATTEMPT_RESERVATION_NANOS, observedNanos: 12_600 },
      },
    });
    const ledger = await readLedger(join(root, "agent", "ledger.json"));
    expect(ledger.attempts.map((item) => item.recordId)).toContain("run-1/development/t-1/0");
    await expect(fileExists(join(root, "agent", "ledger.json.lock"))).resolves.toBe(false);
  });

  test("a development run does not write the policy file unless asked", async () => {
    await runEvaluation(options());
    await expect(fileExists(join(root, "policy.json"))).resolves.toBe(false);
  });

  test("refuses to reuse an output directory and makes no call", async () => {
    await runEvaluation(options());
    calls = 0;
    await expect(runEvaluation(options({ runId: "run-2" }))).rejects.toThrow("already exists");
    expect(calls).toBe(0);
  });

  test("refuses before any reservation when credentials are missing", async () => {
    await expect(
      runEvaluation(options({ createRegistry: async () => registryFor(false) })),
    ).rejects.toThrow("no configured credentials");
    await expect(fileExists(join(root, "agent", "ledger.json"))).resolves.toBe(false);
    await expect(fileExists(join(root, "out"))).resolves.toBe(false);
  });

  test("a failed call stops the run, keeps the reservation and never reports success", async () => {
    const failing: Matcher = async () => {
      calls += 1;
      return { ok: false, reason: "error" };
    };
    const report = await runEvaluation(options({ matcher: failing }));
    expect(report.outcome).toBe("error");
    expect(report.errors).toHaveLength(1);
    expect(calls).toBe(1);
    const ledger = await readLedger(join(root, "agent", "ledger.json"));
    expect(ledger.attempts).toHaveLength(1);
    expect(ledger.attempts[0]).toMatchObject({
      status: "failed",
      reservedNanos: ATTEMPT_RESERVATION_NANOS,
    });
    await expect(fileExists(join(root, "policy.json"))).resolves.toBe(false);
  });

  test("missing usage fails the attempt", async () => {
    const report = await runEvaluation(options({ matcher: noUsage }));
    expect(report.outcome).toBe("error");
    expect(report.errors[0]?.message).toContain("usage");
  });

  test("a thrown matcher is an error without leaking its message", async () => {
    const report = await runEvaluation(options({ matcher: throwing }));
    expect(JSON.stringify(report.errors)).not.toContain("secret");
    expect(report.outcome).toBe("error");
  });

  test.each(["duplicate", "invalid probability"])(
    "rejects %s before an observation can pass",
    async (problem) => {
      const invalid = invalidMatcher(problem);
      const report = await runEvaluation(options({ matcher: invalid }));
      expect(report.outcome).toBe("error");
      expect(report.metrics?.attempts).toBe(0);
      const ledger = await readLedger(join(root, "agent", "ledger.json"));
      expect(ledger.attempts[0]?.status).toBe("failed");
    },
  );

  test("rejects repetitions outside the allowed range", async () => {
    await expect(runEvaluation(options({ repetitions: 6 }))).rejects.toThrow(EvalCliError);
  });

  test("held-out is refused without a frozen policy", async () => {
    await expect(runEvaluation(heldoutOptions())).rejects.toThrow("no policy file");
    await writeFile(
      join(root, "policy.json"),
      JSON.stringify(frozenPolicy({ catalogueHash: "other" })),
    );
    await expect(runEvaluation(heldoutOptions())).rejects.toThrow("does not match");
    await writeFile(
      join(root, "policy.json"),
      JSON.stringify(frozenPolicy({ measuredDisplayedPrecision: 0.5 })),
    );
    await expect(runEvaluation(heldoutOptions())).rejects.toThrow("precision target");
    expect(calls).toBe(0);
  });

  test("held-out needs exactly two repetitions", async () => {
    await writeFile(join(root, "policy.json"), JSON.stringify(frozenPolicy()));
    await expect(runEvaluation(heldoutOptions({ repetitions: 1 }))).rejects.toThrow("exactly 2");
  });

  test("held-out writes a receipt, measures the policy and cannot run twice", async () => {
    await writeFile(join(root, "policy.json"), JSON.stringify(frozenPolicy()));
    const report = await runEvaluation(heldoutOptions({ writePolicy: true }));
    expect(report).toMatchObject({ outcome: "passed", plannedAttempts: 6, threshold: 0.8 });
    await expect(fileExists(join(root, "agent", "heldout-receipt.json"))).resolves.toBe(true);
    await expect(fileExists(join(root, "out", "freeze-receipt.json"))).resolves.toBe(true);
    const policy: unknown = JSON.parse(await readFile(join(root, "policy.json"), "utf8"));
    expect(policy).toMatchObject({ measured: true, measuredDisplayedPrecision: 1 });
    await expect(
      runEvaluation(heldoutOptions({ outputDir: join(root, "out2"), runId: "run-2" })),
    ).rejects.toThrow("already measured");
  });

  test("the receipt refuses a second held-out run even when the policy is unmeasured", async () => {
    await writeFile(join(root, "policy.json"), JSON.stringify(frozenPolicy()));
    await runEvaluation(heldoutOptions());
    await expect(
      runEvaluation(heldoutOptions({ outputDir: join(root, "out2"), runId: "run-2" })),
    ).rejects.toThrow("already started");
  });

  test("a held-out miss fails and leaves the policy unmeasured", async () => {
    await writeFile(join(root, "policy.json"), JSON.stringify(frozenPolicy({ threshold: 0.5 })));
    const report = await runEvaluation(heldoutOptions({ writePolicy: true }));
    expect(report.outcome).toBe("failed");
    const policy: unknown = JSON.parse(await readFile(join(root, "policy.json"), "utf8"));
    expect(policy).toMatchObject({ measured: false });
  });

  test("a tampered fixture file is refused", async () => {
    await writeFile(join(root, "evals", "development.json"), "[]");
    await expect(runEvaluation(options())).rejects.toThrow("manifest hash");
    expect(calls).toBe(0);
  });
});

describe("runCli", () => {
  let root = "";

  const cliDependencies = (
    overrides: Partial<EvalCliDependencies> = {},
  ): EvalCliDependencies & {
    readonly stdoutText: () => string;
    readonly stderrText: () => string;
  } => {
    let stdout = "";
    let stderr = "";
    return {
      catalogue: archivedCatalogue,
      agentDir: () => join(root, "agent"),
      stdout: {
        write: (chunk: string | Uint8Array) => {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        },
      },
      runId: () => "cli-run",
      now: () => new Date("2026-10-14T00:00:00Z"),
      createRegistry: async () => registryFor(true),
      matcher: scriptedMatcher,
      stdoutText: () => stdout,
      stderrText: () => stderr,
      ...overrides,
    };
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eval-cli-"));
    const text = JSON.stringify(fixtureRecords);
    const entry = (file: string) => ({ file, sha256: sha(text), records: 3 });
    await mkdir(join(root, "evals"));
    await writeFile(join(root, "evals", "development.json"), text);
    await writeFile(join(root, "evals", "heldout.json"), text);
    await writeFile(
      join(root, "evals", "manifest.json"),
      JSON.stringify({ development: entry("development.json"), heldout: entry("heldout.json") }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("returns success for dry runs and prints the report", async () => {
    const deps = cliDependencies();
    const code = await runCli(
      ["--split", "development", "--output", join(root, "out"), "--dry-run"],
      deps,
    );
    expect(code).toBe(0);
    expect(deps.stdoutText()).toContain('"outcome": "dry-run"');
    expect(deps.stderrText()).toBe("");
  });

  test("returns failure for invalid arguments and sanitizes unknown failures", async () => {
    const invalid = cliDependencies();
    await expect(runCli(["--split", "bad"], invalid)).resolves.toBe(1);
    expect(invalid.stderrText()).toContain("--split must be development or heldout");

    const refusedLedger = cliDependencies({
      agentDir: () => {
        throw new Error("native credentials must not be touched");
      },
      createRegistry: async () => {
        throw new Error("dispatch must not be touched");
      },
    });
    await expect(
      runCli(["--ledger", join(root, "fresh.json"), "--split", "development"], refusedLedger),
    ).resolves.toBe(1);
    expect(refusedLedger.stderrText()).toContain("Invalid arguments");
    await expect(fileExists(join(root, "fresh.json"))).resolves.toBe(false);

    const unexpected = cliDependencies({
      createRegistry: async () => {
        throw new Error("secret auth failure");
      },
    });
    await expect(
      runCli(["--split", "development", "--output", join(root, "out-unexpected")], unexpected),
    ).resolves.toBe(1);
    expect(unexpected.stderrText()).toContain("unexpectedly");
  });
});

describe("parseCli", () => {
  test("parses the documented flags", () => {
    expect(parseCli(["--split", "development", "--output", "o", "--dry-run"])).toStrictEqual({
      split: "development",
      repetitions: 2,
      output: "o",
      dryRun: true,
      writePolicy: false,
    });
  });

  test.each([
    [["--split", "other"]],
    [["--bogus"]],
    [["--ledger", "fresh.json", "--split", "development"]],
    [[]],
  ])("rejects %j", (argv) => {
    expect(() => parseCli(argv)).toThrow(EvalCliError);
  });
});
