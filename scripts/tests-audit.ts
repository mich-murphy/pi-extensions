/**
 * Renders the weekly tests audit from `fallow mutation --kill-matrix-for` JSON reports.
 *
 *   node --experimental-strip-types scripts/tests-audit.ts <report.json>...
 *
 * A target test with kills and no unique kill adds no detection: every code change that it
 * catches, another test catches too. A target test that runs the code and kills nothing catches no
 * change in scope. Neither is removed automatically; see "Remove a test that adds no detection" in
 * CONTRIBUTING.md. The Markdown goes to stdout, for the job summary.
 */
import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;

type Finding = {
  readonly test: string;
  readonly kills: number;
  readonly sharedWithTargets: number;
  readonly complete: boolean;
};

type Report = {
  readonly path: string;
  readonly completion: string;
  readonly noDetection: readonly Finding[];
  readonly noKills: readonly string[];
  readonly incomplete: readonly string[];
};

function object(value: unknown, where: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function list(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${where} is not an array`);
  }
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${where} is not a string`);
  }
  return value;
}

function readReport(path: string): Report {
  const root = object(JSON.parse(readFileSync(path, "utf8")), path);
  const matrix = object(root.kill_matrix, `${path}: kill_matrix`);
  const completion = text(object(root.completion, `${path}: completion`).status, "status");
  const targets = list(matrix.targets, `${path}: kill_matrix.targets`).map((entry) =>
    object(entry, "target"),
  );
  const completeTests = new Set(
    targets
      .filter((target) => target.status === "complete")
      .flatMap((target) => list(target.test_ids, "test_ids").map((id) => text(id, "test id"))),
  );
  const incomplete = targets
    .filter((target) => target.status !== "complete")
    .map((target) => {
      const reasons = list(target.reasons, "reasons").map((reason) => text(reason, "reason"));
      return `${text(target.target, "target")} (${reasons.join(", ")})`;
    });
  const rows = list(matrix.tests, `${path}: kill_matrix.tests`).map((entry) =>
    object(entry, "row"),
  );
  const noDetection = rows
    .filter((row) => list(row.kills, "kills").length > 0)
    .filter((row) => list(row.unique_kills, "unique_kills").length === 0)
    .map((row) => {
      const test = text(row.test_id, "test_id");
      return {
        test,
        kills: list(row.kills, "kills").length,
        sharedWithTargets: list(row.target_only_kills ?? [], "target_only_kills").length,
        complete: completeTests.has(test),
      };
    });
  const noKills = list(matrix.coverage_without_kills, "coverage_without_kills").map((id) =>
    text(id, "test id"),
  );
  return { path, completion, noDetection, noKills, incomplete };
}

function cell(value: string): string {
  return value.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
}

function findingRow(finding: Finding): string {
  const evidence = finding.complete ? "complete" : "incomplete";
  return `| ${cell(finding.test)} | ${finding.kills} | ${finding.sharedWithTargets} | ${evidence} |`;
}

function findingTable(findings: readonly Finding[]): readonly string[] {
  if (findings.length === 0) {
    return [];
  }
  return [
    "| Test with no unique kill | Kills | Kills shared only with other audited tests | Evidence |",
    "| --- | --- | --- | --- |",
    ...findings.map((finding) => findingRow(finding)),
    "",
  ];
}

function bulletList(heading: string, items: readonly string[]): readonly string[] {
  if (items.length === 0) {
    return [];
  }
  return [heading, "", ...items.map((item) => `- ${cell(item)}`), ""];
}

function reportSection(report: Report): readonly string[] {
  const clean = report.noDetection.length + report.noKills.length === 0;
  return [
    `#### \`${report.path}\``,
    "",
    `Run: ${report.completion}.`,
    "",
    ...findingTable(report.noDetection),
    ...bulletList("Tests that run the code and kill no mutant:", report.noKills),
    ...bulletList("Targets with incomplete evidence:", report.incomplete),
    ...(clean ? ["Every audited test has a unique kill.", ""] : []),
  ];
}

function render(reports: readonly Report[]): string {
  const intro =
    reports.length === 0
      ? ["No test file changed this week."]
      : [
          "Tests in the test files that changed this week. A test with no unique kill adds no detection.",
          "Read it before removing it: CONTRIBUTING.md, “Remove a test that adds no detection”.",
          "",
        ];
  const lines = [
    "### Tests audit",
    "",
    ...intro,
    ...reports.flatMap((report) => reportSection(report)),
  ];
  return `${lines.join("\n")}\n`;
}

process.stdout.write(render(process.argv.slice(2).map((path) => readReport(path))));
