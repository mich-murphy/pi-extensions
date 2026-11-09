import assert from "node:assert/strict";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { hideResources } from "../prompt-filter";
import { assertProperty } from "./hegel-property";

type ContextFile = { readonly path: string; readonly content: string };

/** Text with newlines and markup characters, which the rendered sections must carry verbatim. */
const text = gs.text({ alphabet: "ab \n<>&\"'", maxSize: 10 });
/** Text around the sections never contains `<`, so a section can only match where it was put. */
const outside = gs.text({ alphabet: "xy \n", maxSize: 6 });

function skillAt(index: number, description: string): Skill {
  const filePath = `/s/${index}/SKILL.md`;
  return {
    name: `skill${index}`,
    description,
    filePath,
    baseDir: `/s/${index}`,
    sourceInfo: { path: filePath, source: "local", scope: "user", origin: "top-level" },
    disableModelInvocation: false,
  };
}

/** Pi 0.85's project context block, written out from its documented markup. */
function renderContext(files: readonly ContextFile[]): string {
  if (files.length === 0) {
    return "";
  }
  const blocks = files.map(
    ({ path, content }) =>
      `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`,
  );
  return `\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n${blocks.join("")}</project_context>\n`;
}

function renderSkills(skills: readonly Skill[]): string {
  return formatSkillsForPrompt([...skills], "read");
}

type Scenario = {
  readonly files: readonly ContextFile[];
  readonly skills: readonly Skill[];
  readonly head: string;
  readonly middle: string;
  readonly tail: string;
  /** Paths hidden by the first and the second filter. */
  readonly hiddenA: ReadonlySet<string>;
  readonly hiddenB: ReadonlySet<string>;
};

function drawScenario(tc: TestCase): Scenario {
  const contents = tc.draw(gs.arrays(text, { maxSize: 4 }));
  const descriptions = tc.draw(gs.arrays(text, { maxSize: 4 }));
  const files = contents.map((content, index) => ({ path: `/work/${index}/AGENTS.md`, content }));
  const skills = descriptions.map((description, index) => skillAt(index, description));
  const paths = [...files.map(({ path }) => path), ...skills.map(({ filePath }) => filePath)];
  const subset = (): Set<string> => new Set(paths.filter(() => tc.draw(gs.booleans())));
  return {
    files,
    skills,
    head: tc.draw(outside),
    middle: tc.draw(outside),
    tail: tc.draw(outside),
    hiddenA: subset(),
    hiddenB: subset(),
  };
}

function promptOf(scenario: Scenario, files: readonly ContextFile[], skills: readonly Skill[]) {
  return `${scenario.head}${renderContext(files)}${scenario.middle}${renderSkills(skills)}${scenario.tail}`;
}

function legacyOptions(files: readonly ContextFile[], skills: readonly Skill[]) {
  const options: BuildSystemPromptOptions = {
    cwd: "/work",
    contextFiles: [...files],
    skills: [...skills],
    selectedTools: ["read"],
  };
  return options;
}

function shown(scenario: Scenario, hidden: ReadonlySet<string>) {
  return {
    files: scenario.files.filter(({ path }) => !hidden.has(path)),
    skills: scenario.skills.filter(({ filePath }) => !hidden.has(filePath)),
  };
}

function legacyPrompt(
  scenario: Scenario,
  systemPrompt: string,
  files: readonly ContextFile[],
  skills: readonly Skill[],
  hidden: ReadonlySet<string>,
): string {
  const options = legacyOptions(files, skills);
  const before = structuredClone(options);
  const result = hideResources({ systemPrompt, systemPromptOptions: options }, (path) =>
    hidden.has(path),
  );
  assert.deepEqual(options, before, "legacy options are not mutated");
  assert.equal(result._tag, "prompt-filtered");
  assert.deepEqual(result._tag === "prompt-filtered" ? result.unmatched : [], []);
  return result._tag === "prompt-filtered" ? result.systemPrompt : "";
}

function assertLegacy(scenario: Scenario): void {
  const original = promptOf(scenario, scenario.files, scenario.skills);
  const none = new Set<string>();
  assert.equal(legacyPrompt(scenario, original, scenario.files, scenario.skills, none), original);

  const keptA = shown(scenario, scenario.hiddenA);
  assert.equal(
    legacyPrompt(scenario, original, scenario.files, scenario.skills, scenario.hiddenA),
    promptOf(scenario, keptA.files, keptA.skills),
    "hidden vanish, shown keep order, outside text is byte-identical",
  );
}

function assertComposition(scenario: Scenario): void {
  const original = promptOf(scenario, scenario.files, scenario.skills);
  const union = new Set([...scenario.hiddenA, ...scenario.hiddenB]);
  const afterA = shown(scenario, scenario.hiddenA);
  const promptA = legacyPrompt(
    scenario,
    original,
    scenario.files,
    scenario.skills,
    scenario.hiddenA,
  );
  const stepwise = legacyPrompt(scenario, promptA, afterA.files, afterA.skills, scenario.hiddenB);
  const direct = legacyPrompt(scenario, original, scenario.files, scenario.skills, union);
  assert.equal(stepwise, direct, "hiding A then B equals hiding A∪B");
}

function assertModern(scenario: Scenario): void {
  const options: BuildSystemPromptOptions = {
    ...legacyOptions(scenario.files, scenario.skills),
    sections: {},
  };
  const result = hideResources({ systemPrompt: "kept", systemPromptOptions: options }, (path) =>
    scenario.hiddenA.has(path),
  );
  const expected = shown(scenario, scenario.hiddenA);
  assert.deepEqual(result, { _tag: "options-filtered" });
  assert.deepEqual(options.contextFiles, expected.files);
  assert.deepEqual(options.skills, expected.skills);
}

describe("prompt-filter properties", () => {
  test("legacy path removes hidden resources and keeps the rest byte for byte", () => {
    assertProperty(
      "prompt-filter",
      "legacy path removes hidden resources and keeps the rest byte for byte",
      (tc) => {
        assertLegacy(drawScenario(tc));
      },
    );
  });

  test("hiding A then B equals hiding the union", () => {
    assertProperty("prompt-filter", "hiding A then B equals hiding the union", (tc) => {
      assertComposition(drawScenario(tc));
    });
  });

  test("the modern path filters options in order", () => {
    assertProperty("prompt-filter", "the modern path filters options in order", (tc) => {
      assertModern(drawScenario(tc));
    });
  });
});
