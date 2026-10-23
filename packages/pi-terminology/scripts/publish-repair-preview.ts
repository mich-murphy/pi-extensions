import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadCatalogue } from "../catalogue";
import type { Ledger } from "../eval-budget";
import { previewBinding, validatePreviewPolicy } from "../preview-policy";
import { fitAggregateRecall } from "../recall-aggregate-calibration";
import { writeRecallNew } from "../recall-budget";
import { stableHash } from "../validation";
import { verifyCommandRenameSource } from "./command-rename-compatibility";
import { check } from "./recall-contract";
import type { RecallFixture } from "./recall-contract";
import { dataset } from "./recall-scoring";
import type { RecallObservation } from "./recall-scoring";

const PACKAGE = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const BASE = "evals/repair/continuation/";
const RESULT_SHA256 = "f2a3eb6719faa203d312d3a434c60325d8eaefb7038b6f8979152bac62ae9911";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
type Reader = (path: string) => string;
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Typed deserialization of pinned native evidence, checked before publication.
const parse = <T>(text: string) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixed result pins native JSON bytes; shape/provenance are also checked below.
  JSON.parse(text) as T;
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Preserve the deserialization boundary type through the injectable reader.
const json = <T>(read: Reader, path: string) => parse<T>(read(path));
function readPublic(path: string) {
  check(
    !/(?:private|heldout|acceptance)/iu.test(path),
    "Only public consumed development evidence permitted.",
  );
  const absolute = realpathSync(resolve(PACKAGE, path));
  check(absolute.startsWith(`${PACKAGE}${sep}`), "Evidence path escapes the package.");
  return readFileSync(absolute, "utf8");
}
function same(a: unknown, b: unknown, message: string) {
  check(stableHash(a) === stableHash(b), message);
}
type Binding = {
  originalSources: Record<string, string>;
  continuationSources: Record<string, string>;
  originalReceiptHash: string;
  originalObservationsHash: string;
  originalSourceManifestHash: string;
  datasetHash: string;
  continuationAuthorizationHash: string;
};
type Completion = {
  native: unknown;
  kind: string;
  count: number;
  originalCount: number;
  continuationCount: number;
  binding: Binding;
  receiptHash: string;
  sourceManifestHash: string;
  continuationObservationsHash: string;
  combinedObservationsHash: string;
  ledgerHash: string;
  orderedIdsHash: string;
};
type Receipt = { native: unknown; binding: Binding; beforeLedgerHash: string };
function verifyArtifacts(read: Reader) {
  const resultBytes = read(`${BASE}result.json`);
  check(digest(resultBytes) === RESULT_SHA256, "Native result trust-root mutation.");
  const result = parse<{ artifacts: Record<string, string> }>(resultBytes);
  for (const [name, hash] of Object.entries(result.artifacts)) {
    check(digest(read(`${BASE}${name}`)) === hash, `Native artifact mutation: ${name}`);
  }
  const complete = json<Completion>(read, `${BASE}combined-completion.json.txt`);
  const receipt = json<Receipt>(read, `${BASE}receipt.json.txt`);
  check(
    complete.native === true &&
      receipt.native === true &&
      complete.kind === "combined-development-after-interrupted-original" &&
      complete.count === 612 &&
      complete.originalCount === 416 &&
      complete.continuationCount === 196,
    "Complete native combined development required; injected evidence cannot publish.",
  );
  same(receipt.binding, complete.binding, "Receipt/completion binding mismatch.");
  check(
    complete.receiptHash === digest(read(`${BASE}receipt.json.txt`)) &&
      complete.sourceManifestHash === digest(read(`${BASE}source-manifest.json.txt`)),
    "Native seal mismatch.",
  );
  const fitSeal = json<{ reportHash: string; completionHash: string }>(
    read,
    `${BASE}fit-seal.json.txt`,
  );
  check(
    fitSeal.reportHash === digest(read(`${BASE}report.json.txt`)) &&
      fitSeal.completionHash === digest(read(`${BASE}combined-completion.json.txt`)),
    "Fit seal mismatch.",
  );
  return { complete, receipt };
}
type SourceArchive = { path: string; archive: string; sha256: string };
function verifySourceArchives(
  read: Reader,
  base: string,
  sources: SourceArchive[],
  binding: Record<string, string>,
  label: string,
) {
  same(
    sources.map((s) => s.path).toSorted(),
    Object.keys(binding).toSorted(),
    `${label} archive source set mismatch.`,
  );
  for (const source of sources) {
    check(
      digest(read(`${base}${source.archive}`)) === source.sha256 &&
        source.sha256 === binding[source.path],
      `${label} source archive mutation.`,
    );
  }
}
function verifySources(read: Reader, complete: Completion) {
  const binding = complete.binding;
  const old = json<{ binding: { sources: Record<string, string> } }>(
    read,
    "evals/repair/development-receipt.json.txt",
  );
  same(binding.originalSources, old.binding.sources, "Original source binding mismatch.");
  check(
    Object.keys(binding.originalSources).length === 26 &&
      Object.keys(binding.continuationSources).length === 4,
    "Expected both source generations.",
  );
  for (const sources of [binding.originalSources, binding.continuationSources]) {
    for (const [path, hash] of Object.entries(sources)) {
      verifyCommandRenameSource(read, path, hash);
    }
  }
  const manifest = json<{
    originalSources: Record<string, string>;
    sources: SourceArchive[];
  }>(read, `${BASE}source-manifest.json.txt`);
  same(manifest.originalSources, binding.originalSources, "Archive original binding mismatch.");
  verifySourceArchives(read, BASE, manifest.sources, binding.continuationSources, "Continuation");
  for (const [path, hash] of [
    ["evals/repair/development-receipt.json.txt", binding.originalReceiptHash],
    ["evals/repair/development-observations.jsonl", binding.originalObservationsHash],
    ["evals/repair/source-manifest.json.txt", binding.originalSourceManifestHash],
    ["evals/recall/calibration-consensus.json.txt", binding.datasetHash],
    [`${BASE}authorization.json`, binding.continuationAuthorizationHash],
  ] as const) {
    check(digest(read(path)) === hash, "Historical evidence mutation.");
  }
  const originalManifest = json<{ sources: SourceArchive[] }>(
    read,
    "evals/repair/source-manifest.json.txt",
  );
  verifySourceArchives(
    read,
    "evals/repair/",
    originalManifest.sources,
    binding.originalSources,
    "Original",
  );
  check(
    digest(read("glossary/core.json")) === digest(read("evals/repair/recognition-core.json")),
    "Runtime glossary differs from the native candidate.",
  );
}
function observations(read: Reader, path: string) {
  return read(path)
    .trim()
    .split("\n")
    .map((line) => parse<RecallObservation>(line));
}
function verifyMatrix(read: Reader, complete: Completion, receipt: Receipt) {
  const rows = json<RecallFixture[]>(read, "evals/recall/calibration-consensus.json.txt");
  const before = observations(read, "evals/repair/development-observations.jsonl");
  const added = observations(read, `${BASE}observations.jsonl`);
  const all = [...before, ...added];
  check(
    before.length === 416 && added.length === 196 && rows.length === 612,
    "Incomplete development matrix.",
  );
  same(
    all.map((r) => r.observation.id),
    rows.map((r) => r.id),
    "Combined observation order mismatch.",
  );
  check(
    complete.continuationObservationsHash === digest(read(`${BASE}observations.jsonl`)) &&
      complete.combinedObservationsHash === stableHash(all) &&
      complete.orderedIdsHash === stableHash(rows.map((r) => r.id)),
    "Combined matrix seal mismatch.",
  );
  const ledger = json<Ledger>(read, `${BASE}development-ledger.json.txt`);
  const oldLedger = json<Ledger>(read, "evals/repair/development-ledger.json.txt");
  check(
    ledger.attempts.length === 1624 &&
      oldLedger.attempts.length === 1428 &&
      complete.ledgerHash === digest(read(`${BASE}development-ledger.json.txt`)) &&
      receipt.beforeLedgerHash === digest(read("evals/repair/development-ledger.json.txt")),
    "Ledger seal mismatch.",
  );
  same(ledger.attempts.slice(0, 1428), oldLedger.attempts, "Prior ledger prefix mutation.");
  check(
    ledger.attempts.every((a) => a.status === "succeeded") &&
      new Set(ledger.attempts.map((a) => a.recordId)).size === 1624,
    "Failed, unsettled or duplicate native attempts.",
  );
  same(
    ledger.attempts.slice(1428).map((a) => a.recordId),
    added.map((r) => `repair/develop-continue/${r.observation.id}/0`),
    "Continuation ledger mismatch.",
  );
  return { rows, all };
}

/** Zero-call publication candidate from one pinned, complete native development result. */
export function buildRepairPreview(read: (path: string) => string = readPublic) {
  const { complete, receipt } = verifyArtifacts(read);
  verifySources(read, complete);
  const { rows, all } = verifyMatrix(read, complete, receipt);
  const loaded = loadCatalogue();
  check(
    loaded.ok && !loaded.policy.measured && loaded.catalogue.concepts.length === 51,
    "Expected the unmeasured 51-concept runtime catalogue.",
  );
  const fit = fitAggregateRecall(
    dataset(
      rows,
      all,
      loaded.catalogue.concepts.map((c) => c.id),
    ),
  );
  const report = json<
    ReturnType<typeof fitAggregateRecall> & {
      native: unknown;
      measured: unknown;
      accepted: unknown;
    }
  >(read, `${BASE}report.json.txt`);
  check(
    report.native === true &&
      report.measured === false &&
      report.accepted === false &&
      fit.feasible,
    "Feasible native development fit required; never production acceptance.",
  );
  same(
    Object.fromEntries(Object.keys(fit).map((key) => [key, Reflect.get(report, key)])),
    fit,
    "Native fit does not reproduce from the sealed observations.",
  );
  const policy = {
    ...previewBinding(loaded.catalogue),
    schemaVersion: 1,
    developmentOnly: true,
    measured: false,
    promotable: false,
    acceptanceStatus: "not-validated",
    conceptThresholds: fit.thresholds,
    gaps: [
      "Refactoring P46%",
      "Low coupling P63%",
      "No fresh acceptance: thresholds fitted to consumed agent-reviewed public development.",
      "Conservative precision 88.06%; 18 ambiguous displayed hits.",
      "Natural/private-request performance, stability and usefulness remain unmeasured.",
    ],
    metricStatus: "UNVALIDATED-development-fit-only",
    evidence: {
      resultSha256: RESULT_SHA256,
      completionSha256: digest(read(`${BASE}combined-completion.json.txt`)),
      reportSha256: digest(read(`${BASE}report.json.txt`)),
      source: "evals/repair/continuation/result.json",
      compatibility:
        "Original native sources unchanged except exact terms-to-terminology UI command rename in index.ts and ui.ts; not fresh inference.",
    },
  };
  check(
    validatePreviewPolicy(policy, loaded.catalogue, previewBinding(loaded.catalogue)).ok,
    "Published candidate would fail runtime validation.",
  );
  return policy;
}

/** Never overwrites a different candidate and cannot write a production policy filename. */
export async function writeRepairPreview(
  path: string,
  policy: ReturnType<typeof buildRepairPreview>,
) {
  check(
    path.endsWith("/preview-policy.json"),
    "Only a preview-policy.json artifact may be written.",
  );
  const bytes = `${JSON.stringify(policy, null, 2)}\n`;
  try {
    await writeRecallNew(path, policy);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      check(
        (await readFile(path, "utf8")) === bytes,
        "Different existing preview preserved; refusing overwrite.",
      );
      return { written: false, artifactSha256: digest(bytes) };
    }
    throw error;
  }
  return { written: true, artifactSha256: digest(bytes) };
}
const main = process.argv[1];
if (main !== undefined && resolve(main) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      publish: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });
  check(!(values.publish && values["dry-run"]), "Choose --publish or --dry-run, not both.");
  const policy = buildRepairPreview();
  const output = resolve(PACKAGE, "glossary/preview-policy.json");
  const publication = values.publish
    ? await writeRepairPreview(output, policy)
    : { written: false };
  process.stdout.write(
    `${JSON.stringify(
      {
        dryRun: !values.publish,
        calls: 0,
        activated: false,
        measured: false,
        accepted: false,
        output,
        ...publication,
        policy,
      },
      null,
      2,
    )}\n`,
  );
}
