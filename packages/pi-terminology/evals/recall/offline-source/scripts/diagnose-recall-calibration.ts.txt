import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { RealPromptDataset } from "../real-prompt-metrics";
import { fitAggregateRecall } from "../recall-aggregate-calibration";
import { check, readRecallFixtures } from "./recall-contract";
import type { RecallManifest } from "./recall-contract";
import type { RecallObservation } from "./recall-scoring";

const RUN = join(homedir(), ".pi/agent/pi-terminology/recall-2026-10-22");
const MANIFEST_HASH = "fbed4fced475b8c76e6da2a47550bbd02dacf26b00d475e639bd4297b98d19fc";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type Receipt = { phase: string; binding: { manifest: string; sources: Record<string, string> } };
type Report = { profile: string; thresholds: Record<string, number> };

const DEFAULT_IO = {
  readText: async (path: string) => readFile(path, "utf8"),
  canonical: realpath,
  hash: sha,
  fixtures: readRecallFixtures,
  marker: stat,
  write: writeFile,
};

/** Fixed consumed calibration only. Importing this module performs no IO or provider setup. */
export async function diagnoseRecallCalibration(
  manifest: string,
  output: string,
  // In-process IO seam for offline tests only; not exposed as CLI flags, never native proof.
  io: {
    readText: (path: string) => Promise<string>;
    canonical: (path: string) => Promise<string>;
    hash: (text: string) => string;
    fixtures: typeof readRecallFixtures;
    marker: (path: string) => Promise<unknown>;
    write: (path: string, text: string, options: { flag: "wx"; mode: number }) => Promise<void>;
  } = DEFAULT_IO,
) {
  check(
    resolve(manifest) === join(RUN, "manifest.json"),
    "Only the fixed current calibration manifest is allowed.",
  );
  check(
    resolve(output).endsWith(".json") &&
      basename(output).startsWith("offline-") &&
      dirname(resolve(output)) !== join(RUN, "fixtures"),
    "Output must be a new offline-*.json diagnostic file.",
  );
  check((await io.canonical(manifest)) === resolve(manifest), "Manifest symlinks are forbidden.");
  const manifestText = await io.readText(manifest);
  check(io.hash(manifestText) === MANIFEST_HASH, "Fixed calibration manifest hash mismatch.");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exact manifest bytes are hash pinned before interpreting calibration entries.
  const m = JSON.parse(manifestText) as RecallManifest;
  check(
    m.calibration.reduce((count, entry) => count + entry.records, 0) === 612,
    "Expected 612 calibration fixtures.",
  );
  // The pinned manifest authorizes ONLY these calibration entries; never iterate other splits.
  await Promise.all(
    m.calibration.map(async (entry) => {
      const path = resolve(dirname(manifest), entry.file);
      check((await io.canonical(path)) === path, "Calibration symlinks are forbidden.");
    }),
  );
  const reportPath = join(RUN, "calibrate.report.json");
  const receiptPath = join(RUN, "calibrate.receipt.json");
  const observationsPath = join(RUN, "calibrate.observations.jsonl");
  await Promise.all(
    [reportPath, receiptPath, observationsPath].map(async (path) => {
      check((await io.canonical(path)) === path, "Collection artifact symlinks are forbidden.");
    }),
  );
  const reportText = await io.readText(reportPath);
  const receiptText = await io.readText(receiptPath);
  const observationsText = await io.readText(observationsPath);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Collection profile IDs feed complete matrix validation.
  const report = JSON.parse(reportText) as Report;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Collection binding is checked immediately below.
  const receipt = JSON.parse(receiptText) as Receipt;
  check(
    receipt.phase === "calibrate" && receipt.binding.manifest === MANIFEST_HASH,
    "Receipt binding mismatch.",
  );
  const ids = Object.keys(report.thresholds);
  check(ids.length === 51, "All 51 original concepts are required.");
  const rows = await io.fixtures(manifest, m.calibration, ids);
  const observations = observationsText
    .trim()
    .split("\n")
    .map((line) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The full matrix is validated by fitAggregateRecall; profile is checked here.
      const record = JSON.parse(line) as RecallObservation & { profile: string };
      check(record.profile === report.profile, "Collection profile mismatch.");
      return record.observation;
    });
  const data: RealPromptDataset = {
    split: "tuning",
    repeats: 1,
    concepts: ids.map((id) => ({ id, variants: ["native"] })),
    gold: rows.map((row) => ({
      id: row.id,
      split: "tuning",
      labels: Object.fromEntries(
        ids.map((id) => {
          const label = row.labels[id];
          check(label !== undefined, "Missing calibration label.");
          return [id, { label, named: row.named.includes(id) }];
        }),
      ),
    })),
    // No filtering, split rewriting, or dropping unknown concept keys: reject incomplete/extra data.
    observations,
  };
  const result = fitAggregateRecall(data);
  const completePresent = await io.marker(join(RUN, "calibrate.complete.json")).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
  const diagnostic = {
    ...result,
    collectionProvenance: {
      manifestSha256: io.hash(manifestText),
      observationsSha256: io.hash(observationsText),
      originalReceiptSha256: io.hash(receiptText),
      originalReportSha256: io.hash(reportText),
      originalSourceBindings: receipt.binding.sources,
      profile: report.profile,
      calibrationEntries: m.calibration.map(({ file, sha256, records }) => ({
        file,
        sha256,
        records,
      })),
      calibrationCompletePresent: completePresent,
      nativeProofClaim: false,
      note: "Original receipt/source bindings are collection provenance only, not verification of this new tool. No acceptance access, activation, promotion, or native phase advancement is authorized.",
    },
  };
  await io.write(output, `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return diagnostic;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { manifest: { type: "string" }, output: { type: "string" } },
  });
  check(
    typeof values.manifest === "string" && typeof values.output === "string",
    "Usage: --manifest FIXED_MANIFEST --output NEW_OFFLINE_JSON",
  );
  await diagnoseRecallCalibration(values.manifest, values.output);
}
