/* oxlint-disable typescript/strict-boolean-expressions -- JSON input boundaries deliberately revalidate nominally typed objects at runtime. */
/* oxlint-disable no-await-in-loop -- Fail closed in dataset order before any dispatch. */
/* oxlint-disable typescript/no-non-null-assertion -- Validated complete probability matrices and fixed test fixtures make mandatory indexed lookups safe. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Catalogue } from "../types";
import { composeGlossaries, parseGlossary } from "../validation";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const normalizedPromptHash = (text: string) =>
  sha(text.normalize("NFKC").replaceAll(/\s+/gu, " ").trim().toLowerCase());
export function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
export const json = async <T>(path: string): Promise<T> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Callers validate the committed JSON boundary before use.
  JSON.parse(await readFile(path, "utf8")) as T;
export const hashFile = async (path: string) => sha(await readFile(path));
export type RecallEntry = {
  name: string;
  kind: "synthetic" | "private";
  file: string;
  sha256: string;
  records: number;
};
export type RecallManifest = {
  schemaVersion: 1;
  pilot: RecallEntry[];
  calibration: RecallEntry[];
  heldout: RecallEntry[];
  repeats: string[];
  seal: { file: string };
};
export type RecallSeal = {
  schemaVersion: 1;
  manifestHash: string;
  independentAgent: string;
  checks: Record<
    | "normalizedDuplicates"
    | "crossSplit"
    | "sessionDisjoint"
    | "scenarioFamilyDisjoint"
    | "consumedOverlap"
    | "coverage",
    boolean
  >;
  coverage: {
    pilot: Record<string, number>;
    calibration: Record<string, number>;
    synthetic: Record<string, number>;
    privatePositivePrompts: number;
  };
};
export type RecallFixture = {
  id: string;
  prompt: string;
  labels: Record<string, "positive" | "negative" | "ambiguous">;
  named: string[];
  group?: string;
  session?: string;
  scenarioFamily?: string;
  kind: RecallEntry["kind"];
};
const SEAL_CHECKS = [
  "normalizedDuplicates",
  "crossSplit",
  "sessionDisjoint",
  "scenarioFamilyDisjoint",
  "consumedOverlap",
  "coverage",
] as const;
const count = (es: RecallEntry[]) => es.reduce((n, e) => n + e.records, 0);
function validateEntry(e: RecallEntry, names: Set<string>, files: Set<string>) {
  check(
    e &&
      typeof e.name === "string" &&
      !names.has(e.name) &&
      typeof e.file === "string" &&
      !files.has(e.file) &&
      /^[a-f0-9]{64}$/u.test(e.sha256) &&
      Number.isSafeInteger(e.records) &&
      e.records > 0 &&
      ["private", "synthetic"].includes(e.kind),
    "Invalid or duplicate entry.",
  );
  names.add(e.name);
  files.add(e.file);
}
export async function loadRecallManifest(path: string, root: string): Promise<RecallManifest> {
  const m = await json<RecallManifest>(path);
  check(m.schemaVersion === 1, "Invalid recall manifest version.");
  const names = new Set<string>();
  const files = new Set<string>();
  for (const split of [m.pilot, m.calibration, m.heldout]) {
    check(Array.isArray(split) && split.length > 0, "Missing split.");
    for (const e of split) {
      validateEntry(e, names, files);
      if (e.kind === "private" || m.heldout.includes(e)) {
        check(
          resolve(dirname(path), e.file).startsWith(`${resolve(root)}/`),
          "Heldout/private data must stay in private run directory.",
        );
      }
    }
  }

  check(
    count(m.pilot) === 200 && m.pilot.every((e) => e.kind === "synthetic"),
    "Pilot requires 200 consumed public development fixtures.",
  );
  check(count(m.calibration) === 612, "Calibration requires exactly 612 fresh fixtures.");
  check(
    count(m.heldout.filter((e) => e.kind === "synthetic")) === 550 &&
      count(m.heldout.filter((e) => e.kind === "private")) === 200,
    "Heldout requires 550 synthetic and 200 private fixtures.",
  );
  check(
    Array.isArray(m.repeats) &&
      m.repeats.length === 24 &&
      new Set(m.repeats).size === 24 &&
      m.repeats.every((id) => typeof id === "string" && id.length > 0),
    "Precommit 24 distinct heldout repeat IDs.",
  );
  check(
    m.seal &&
      typeof m.seal.file === "string" &&
      resolve(dirname(path), m.seal.file).startsWith(`${resolve(root)}/`),
    "Independent prevalidation seal must stay in private run directory.",
  );
  return m;
}
export async function validateRecallSeal(
  path: string,
  m: RecallManifest,
  ids: string[],
): Promise<RecallSeal> {
  const seal = await json<RecallSeal>(resolve(dirname(path), m.seal.file));
  check(
    seal.schemaVersion === 1 &&
      seal.manifestHash === (await hashFile(path)) &&
      typeof seal.independentAgent === "string" &&
      seal.independentAgent.trim(),
    "Invalid independent seal binding.",
  );
  check(
    // oxlint-disable-next-line typescript/no-unnecessary-boolean-literal-compare -- External JSON must contain literal booleans, not truthy strings.
    SEAL_CHECKS.every((key) => seal.checks?.[key] === true),
    "Independent prevalidation failed.",
  );
  for (const [split, minimum] of [
    ["pilot", 3],
    ["calibration", 10],
    ["synthetic", 10],
  ] as const) {
    check(
      ids.every(
        (id) =>
          Number.isSafeInteger(seal.coverage?.[split]?.[id]) &&
          seal.coverage[split][id]! >= minimum,
      ),
      `Insufficient sealed ${split} coverage.`,
    );
  }
  check(
    Number.isSafeInteger(seal.coverage.privatePositivePrompts) &&
      seal.coverage.privatePositivePrompts >= 20 &&
      seal.coverage.privatePositivePrompts <= 200,
    "Insufficient sealed private positive prompts.",
  );
  return seal;
}
export async function loadRecallCatalogue(path: string): Promise<Catalogue> {
  const parsed = parseGlossary(await json(path), "recall profile", "core");
  check(parsed.ok, "Invalid recall profile glossary.");
  const result = composeGlossaries([parsed.value]);
  check(result.ok, "Invalid recall profile composition.");
  check(
    result.value.recognition.length === 51 && result.value.concepts.length === 51,
    "Recall profile must have exactly 51 concepts/questions.",
  );
  return result.value;
}
export async function readRecallFixtures(
  manifestPath: string,
  entries: RecallEntry[],
  ids: string[],
): Promise<RecallFixture[]> {
  const rows: RecallFixture[] = [];
  const seen = new Set<string>();
  const prompts = new Set<string>();
  for (const e of entries) {
    const path = resolve(dirname(manifestPath), e.file);
    check((await hashFile(path)) === e.sha256, "Dataset hash mutation.");
    const raw = await json<unknown>(path);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Shape and records are checked immediately below.
    const data = Array.isArray(raw) ? raw : (raw as { fixtures?: unknown }).fixtures;
    check(Array.isArray(data) && data.length === e.records, "Dataset record count mismatch.");
    for (const value of data) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Every fixture field is validated immediately below.
      const row = value as RecallFixture;
      check(
        row &&
          typeof row.id === "string" &&
          row.id.length &&
          typeof row.prompt === "string" &&
          row.prompt.trim() &&
          row.prompt.length <= 32_000 &&
          !seen.has(row.id) &&
          !prompts.has(normalizedPromptHash(row.prompt)),
        "Invalid/duplicate fixture.",
      );
      check(
        row.labels &&
          Object.keys(row.labels).length === ids.length &&
          ids.every((id) => ["positive", "negative", "ambiguous"].includes(row.labels[id]!)) &&
          Array.isArray(row.named) &&
          new Set(row.named).size === row.named.length &&
          row.named.every((id) => ids.includes(id) && row.labels[id] === "positive"),
        "Incomplete label matrix.",
      );
      seen.add(row.id);
      prompts.add(normalizedPromptHash(row.prompt));
      rows.push({ ...row, kind: e.kind });
    }
  }
  return rows;
}

export async function readOldTenCutoffs(path: string): Promise<Record<string, number>> {
  const old = await json<{ conceptThresholds: Record<string, number> }>(path);
  check(
    typeof old.conceptThresholds === "object" && old.conceptThresholds !== null,
    "Archived old10 thresholds required.",
  );
  check(
    Object.keys(old.conceptThresholds).length === 10,
    "Archived old10 requires ten thresholds.",
  );
  check(
    Object.values(old.conceptThresholds).every(
      (value) => Number.isFinite(value) && value > 0 && value <= 1,
    ),
    "Invalid archived old10 threshold.",
  );
  return old.conceptThresholds;
}
