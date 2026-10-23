import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadCatalogue } from "../catalogue";
import { loadPreviewPolicy, previewBinding, validatePreviewPolicy } from "../preview-policy";
import { buildRepairPreview, writeRepairPreview } from "../scripts/publish-repair-preview";

const base = new URL("../", import.meta.url);
const publicationDirectory = "evals/repair/preview/command-rename/";
const read = (path: string) => readFileSync(new URL(path, base), "utf8");
function reader(overrides: Record<string, string> = {}) {
  return vi.fn<(path: string) => string>((path) => overrides[path] ?? read(path));
}
const publicPath = ([path]: [string]) =>
  !path.startsWith("/") && !/(?:private|heldout|acceptance)/iu.test(path);
const directories: string[] = [];
async function outputFile() {
  const directory = await mkdtemp(join(tmpdir(), "repair-preview-publication-"));
  directories.push(directory);
  return join(directory, "preview-policy.json");
}

describe("zero-call native-repair preview publication", () => {
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  test("reproduces all51 cutoffs, binds current runtime, and prominently retains weak-concept warnings", () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("Network forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    const files = reader();
    const policy = buildRepairPreview(files);
    const loaded = loadCatalogue();
    const report: unknown = JSON.parse(read("evals/repair/continuation/report.json.txt"));
    expect(policy).toMatchObject({
      schemaVersion: 1,
      developmentOnly: true,
      measured: false,
      promotable: false,
      acceptanceStatus: "not-validated",
      metricStatus: "UNVALIDATED-development-fit-only",
    });
    expect(Object.keys(policy.conceptThresholds)).toHaveLength(51);
    expect(policy.conceptThresholds).toMatchObject({
      "core:refactoring": 0.8,
      "core:low-coupling": 0.84,
      "core:separation-of-concerns": 0.86,
    });
    expect(report).toMatchObject({ thresholds: policy.conceptThresholds });
    expect(policy.gaps.slice(0, 2)).toStrictEqual(["Refactoring P46%", "Low coupling P63%"]);
    expect(policy.gaps.join(" ")).toContain("88.06%");
    expect(policy.gaps.join(" ")).toContain("No fresh acceptance");
    expect(
      validatePreviewPolicy(policy, loaded.catalogue, previewBinding(loaded.catalogue)).ok,
    ).toBe(true);
    expect(loaded.policy.measured).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(files.mock.calls.every((call) => publicPath(call))).toBe(true);
  });
  test("the actual bundled candidate loads through the default runtime loader without measuring production", () => {
    const loaded = loadCatalogue();
    const policy = buildRepairPreview();
    expect(read("glossary/preview-policy.json")).toBe(`${JSON.stringify(policy, null, 2)}\n`);
    expect(loadPreviewPolicy(loaded.catalogue)).toMatchObject({
      ok: true,
      policy: {
        measured: false,
        promotable: false,
        acceptanceStatus: "not-validated",
        conceptThresholds: policy.conceptThresholds,
        gaps: policy.gaps,
      },
    });
    expect(loaded.policy.measured).toBe(false);
    const hash = (path: string) => createHash("sha256").update(read(path)).digest("hex");
    const publication: unknown = JSON.parse(read(`${publicationDirectory}publication.json`));
    expect(
      JSON.parse(read(`${publicationDirectory}previous-preview-policy.json.txt`)),
    ).toMatchObject({
      conceptThresholds: policy.conceptThresholds,
      catalogueHash: policy.catalogueHash,
      wireCriteriaHash: policy.wireCriteriaHash,
      measured: false,
    });
    expect(publication).toMatchObject({
      status: "manual-experimental-preview-published-not-activated",
      artifactSha256: hash("glossary/preview-policy.json"),
      publicationProviderCalls: 0,
      activationPerformed: false,
      globalSettingsChanged: false,
      uiEvidenceKind: "actual-bundled-artifact-offline-intercepted-classifier-only",
      uiRealProviderRequests: 0,
      uiFetchCalls: 0,
      artifacts: Object.fromEntries(
        [
          "ui-result.json",
          "ui-counters.json",
          "ui-safety.json",
          "ui-artifact.json",
          "ui-confirm-180x50.txt",
          "ui-confirm-60x28.txt",
        ].map((name) => [name, hash(`${publicationDirectory}${name}`)]),
      ),
    });
  });
  test("a fabricated result cannot supply its own trust root", () => {
    expect(() =>
      buildRepairPreview(reader({ "evals/repair/continuation/result.json": "{}" })),
    ).toThrow("Native result trust-root mutation");
  });
  test.each([
    "receipt.json.txt",
    "combined-completion.json.txt",
    "report.json.txt",
    "observations.jsonl",
    "development-ledger.json.txt",
    "fit-seal.json.txt",
  ])("rejects mutated %s without writing a candidate", (name) => {
    expect(() =>
      buildRepairPreview(reader({ [`evals/repair/continuation/${name}`]: "{}" })),
    ).toThrow("Native artifact mutation");
  });
  test("rejects an altered source archive and current frozen runtime", () => {
    expect(() =>
      buildRepairPreview(
        reader({
          "evals/repair/continuation/source/scripts/evaluate-repair-continuation.ts.txt": "changed",
        }),
      ),
    ).toThrow("Continuation source archive mutation");
    expect(() =>
      buildRepairPreview(reader({ "evals/repair/source/catalogue.ts.txt": "changed" })),
    ).toThrow("Original source archive mutation");
    expect(() =>
      buildRepairPreview(reader({ "index.ts": `${read("index.ts")}\n// changed` })),
    ).toThrow("Frozen source drift");
  });
  test("rejects a different runtime glossary, even if it has not affected the native archives", () => {
    expect(() => buildRepairPreview(reader({ "glossary/core.json": "{}" }))).toThrow(
      "Runtime glossary differs",
    );
  });
  test("publication is durable and idempotent but never overwrites a different candidate", async () => {
    const path = await outputFile();
    const policy = buildRepairPreview();
    await expect(writeRepairPreview(path, policy)).resolves.toMatchObject({ written: true });
    const bytes = await readFile(path, "utf8");
    expect(JSON.parse(bytes)).toStrictEqual(policy);
    await expect(writeRepairPreview(path, policy)).resolves.toMatchObject({ written: false });
    await expect(readFile(path, "utf8")).resolves.toBe(bytes);
    await writeFile(path, "existing different candidate\n");
    await expect(writeRepairPreview(path, policy)).rejects.toThrow(
      "Different existing preview preserved",
    );
    await expect(readFile(path, "utf8")).resolves.toBe("existing different candidate\n");
  });
  test("the writer refuses production policy filenames", async () => {
    const path = await outputFile();
    await expect(
      writeRepairPreview(path.replace("preview-policy.json", "policy.json"), buildRepairPreview()),
    ).rejects.toThrow("Only a preview-policy.json artifact");
  });
  test("CLI defaults to a zero-call dry-run and rejects conflicting publication modes", () => {
    const script = fileURLToPath(new URL("scripts/publish-repair-preview.ts", base));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "jiti/register", script, ...args], {
        encoding: "utf8",
      });
    const dry = run();
    expect(dry.status).toBe(0);
    const output: unknown = JSON.parse(dry.stdout);
    expect(output).toMatchObject({
      dryRun: true,
      calls: 0,
      activated: false,
      written: false,
      measured: false,
      accepted: false,
    });
    const conflict = run("--publish", "--dry-run");
    expect(conflict.status).toBe(1);
    expect(conflict.stdout).toBe("");
    expect(conflict.stderr).toContain("Choose --publish or --dry-run");
  });
});
