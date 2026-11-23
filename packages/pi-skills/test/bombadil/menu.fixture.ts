import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BombadilFixture } from "../../../../test-support/bombadil.ts";

const LONG =
  "Use this when a task needs careful, step-by-step research across several primary sources, " +
  "with citations, cross-checks and a short summary of what remains uncertain at the end.";

const GLOBAL_SKILLS: readonly (readonly [string, string])[] = [
  ["alpha-review", "Review a change for correctness."],
  ["bravo-deploy", "Deploy the service to staging."],
  ["charlie-docs", LONG],
  ["delta-lint", "Run linters and fix what they report."],
  ["echo-bench", "Benchmark a hot path."],
  ["foxtrot-sql", "Write and explain SQL queries."],
  ["golf-shell", "Write portable shell scripts."],
  ["hotel-api", "Design an HTTP API."],
  ["india-css", "Fix layout and styling bugs."],
  ["juliet-test", "Write focused unit tests."],
  ["kilo-trace", "Read a stack trace and find the cause."],
  ["lima-git", "Untangle Git history."],
  ["mike-perf", LONG],
  ["november-i18n", "Translate interface strings: 日本語, Español, Ελληνικά."],
  ["oscar-a11y", "Audit accessibility."],
  ["papa-release", "Prepare release notes."],
  ["quebec-sec", "Look for security problems."],
  ["romeo-data", "Clean a CSV file."],
  ["研究-ツール-調査", "幅の広い文字の名前と説明。日本語の長い説明文がここに続きます。"],
  ["a-very-long-skill-name-that-goes-on-and-on-past-sixty-columns", LONG],
];

const PROJECT_SKILLS: readonly (readonly [string, string, string])[] = [
  [".pi/skills", "proj-build", "Build the project with its own scripts."],
  [".pi/skills", "proj-migrate", LONG],
  [".agents/skills", "proj-schema", "Update the database schema."],
  [".claude/skills", "proj-review-漢字", "Project review rules with 漢字 in the name."],
  [".codex/skills", "proj-release", "Cut a project release."],
];

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function skill(root: string, name: string, description: string, manual = false): void {
  write(
    join(root, name.replaceAll(/[^a-z0-9-]/gu, "x"), "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      ...(manual ? ["disable-model-invocation: true"] : []),
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
  );
}

const fixture: BombadilFixture = (root) => {
  write(join(root.agent, "AGENTS.md"), "# Personal rules for every project\n");
  for (const [name, description] of GLOBAL_SKILLS) {
    skill(join(root.agent, "skills"), name, description);
  }
  skill(join(root.home, ".agents", "skills"), "home-notes", "Keep notes in the home folder.");
  skill(join(root.agent, "skills"), "zulu-manual", "Run only when asked by name.", true);

  write(join(root.root, "CLAUDE.md"), "# Parent folder conventions\n");
  write(join(root.cwd, "AGENTS.md"), "# Working agreement for this repository\n");
  write(join(root.cwd, "docs", "AGENTS.md"), "# Documentation style guide\n");
  for (const [directory, name, description] of PROJECT_SKILLS) {
    skill(join(root.cwd, directory), name, description);
  }
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", root.cwd, ...args], {
      stdio: "ignore",
      env: { HOME: root.home, PATH: process.env.PATH ?? "" },
    });
  };
  git("init", "--quiet");
  git("add", "AGENTS.md", "docs/AGENTS.md");

  return {
    omitDefaults: ["--no-skills", "--no-context-files"],
    settings: { defaultProjectTrust: "always" },
  };
};

export default fixture;
