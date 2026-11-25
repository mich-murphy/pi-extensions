import { readFileSync } from "node:fs";
import { Schema } from "effect";

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

const Kills = Schema.Array(Schema.Unknown);
const Target = Schema.Struct({
  status: Schema.String,
  target: Schema.String,
  test_ids: Schema.Array(Schema.String),
  reasons: Schema.Array(Schema.String),
});
const TestRow = Schema.Struct({
  kills: Kills,
  unique_kills: Kills,
  target_only_kills: Schema.optional(Kills.pipe(Schema.NullOr)),
  test_id: Schema.String,
});
const decodeReport = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      completion: Schema.Struct({ status: Schema.String }),
      kill_matrix: Schema.Struct({
        targets: Schema.Array(Target),
        tests: Schema.Array(TestRow),
        coverage_without_kills: Schema.Array(Schema.String),
      }),
    }),
  ),
);

function readReport(path: string): Report {
  const { completion, kill_matrix: matrix } = decodeReport(readFileSync(path, "utf8"));
  const completeTests = new Set(
    matrix.targets
      .filter((target) => target.status === "complete")
      .flatMap((target) => target.test_ids),
  );
  const incomplete = matrix.targets
    .filter((target) => target.status !== "complete")
    .map((target) => `${target.target} (${target.reasons.join(", ")})`);
  const noDetection = matrix.tests
    .filter((row) => row.kills.length > 0 && row.unique_kills.length === 0)
    .map((row) => ({
      test: row.test_id,
      kills: row.kills.length,
      sharedWithTargets: row.target_only_kills?.length ?? 0,
      complete: completeTests.has(row.test_id),
    }));
  return {
    path,
    completion: completion.status,
    noDetection,
    noKills: matrix.coverage_without_kills,
    incomplete,
  };
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
