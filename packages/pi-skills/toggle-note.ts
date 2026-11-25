import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import type { PromptResource, SkillReader } from "./prompt-view";
import type { ResourcePath } from "./resource-path";

export const TOGGLE_NOTE_TYPE = "skills";

const LEGACY_TOGGLE_NOTE_TYPE = "pi-skill-toggle";

export type ToggleNoteDetails = {
  readonly version: 1;
  readonly visible: readonly ResourcePath[];
};

export type ToggleNote = {
  readonly customType: typeof TOGGLE_NOTE_TYPE;
  readonly content: string;
  readonly display: false;
  readonly details: ToggleNoteDetails;
};

export type ToggleChanges = {
  readonly enabled: readonly PromptResource[];
  readonly disabled: readonly PromptResource[];
};

export type ToggleNoteInput = {
  readonly resources: readonly PromptResource[];
  readonly view: ReadonlySet<ResourcePath>;
  readonly desired: ReadonlySet<ResourcePath>;
  readonly changes: ToggleChanges;
  readonly reader: SkillReader;
};

const SUPERSEDES = "The user changed /skills. This note supersedes earlier /skills notes";
const HEADER = `${SUPERSEDES} and overrides the skills and project instructions listed in the system prompt.`;
const REVERT = [
  `${SUPERSEDES}.`,
  "The system prompt's skills and project instructions apply as listed.",
].join("\n");
const DISABLED_SKILLS = "Disabled skills (do not load unless the user invokes /skill:<name>): ";
const DISABLED_INSTRUCTIONS = "Disabled instructions (disregard): ";

const isVisibleDetails = Schema.is(Schema.Struct({ visible: Schema.Array(Schema.String) }));

export function noteView(message: { readonly role: string }): ReadonlySet<string> | undefined {
  if (
    message.role !== "custom" ||
    !("customType" in message) ||
    (message.customType !== TOGGLE_NOTE_TYPE && message.customType !== LEGACY_TOGGLE_NOTE_TYPE) ||
    !("details" in message)
  ) {
    return undefined;
  }
  return isVisibleDetails(message.details) ? new Set(message.details.visible) : undefined;
}

export function toggleChanges(
  resources: readonly PromptResource[],
  baseline: ReadonlySet<ResourcePath>,
  desired: ReadonlySet<ResourcePath>,
): ToggleChanges {
  return {
    enabled: sortResources(resources.filter(({ id }) => desired.has(id) && !baseline.has(id))),
    disabled: sortResources(resources.filter(({ id }) => baseline.has(id) && !desired.has(id))),
  };
}

export function toggleNote(input: ToggleNoteInput): ToggleNote | undefined {
  const { resources, view, desired } = input;
  if (resources.every(({ id }) => view.has(id) === desired.has(id))) {
    return undefined;
  }
  return {
    customType: TOGGLE_NOTE_TYPE,
    content: renderToggleNote(input.changes, input.reader),
    display: false,
    details: {
      version: 1,
      visible: resources
        .filter(({ id }) => desired.has(id))
        .map(({ id }) => id)
        .toSorted(compareText),
    },
  };
}

export function renderToggleNote(changes: ToggleChanges, reader: SkillReader): string {
  if (changes.enabled.length === 0 && changes.disabled.length === 0) {
    return REVERT;
  }
  const [disabledSkills, disabledInstructions] = byKind(changes.disabled);
  const [enabledSkills, enabledInstructions] = byKind(changes.enabled);
  return [
    HEADER,
    ...block(disabledSkills, (skills) => [
      `${DISABLED_SKILLS}${skills.map(({ name }) => name).join(", ")}`,
    ]),
    ...block(disabledInstructions, (files) => [
      `${DISABLED_INSTRUCTIONS}${files.map(({ path }) => path).join(", ")}`,
    ]),
    ...block(enabledSkills, (skills) => ["Enabled skills:", renderSkills(skills, reader)]),
    ...block(enabledInstructions, (files) => [
      "Enabled instructions:",
      ...files.map(
        ({ path, body }) =>
          `<project_instructions path="${path}">\n${body}\n</project_instructions>`,
      ),
    ]),
  ].join("\n");
}

function renderSkills(skills: readonly PromptResource[], reader: SkillReader): string {
  return formatSkillsForPrompt(
    skills.map((skill) => promptSkill(skill)),
    reader,
  ).trim();
}

function promptSkill(skill: PromptResource): Skill {
  return {
    name: skill.name,
    description: skill.body,
    filePath: skill.path,
    baseDir: skill.path,
    sourceInfo: {
      path: skill.path,
      source: TOGGLE_NOTE_TYPE,
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
  };
}

function block(
  resources: readonly PromptResource[],
  render: (resources: readonly PromptResource[]) => readonly string[],
): readonly string[] {
  return resources.length === 0 ? [] : render(resources);
}

function byKind(
  resources: readonly PromptResource[],
): readonly [readonly PromptResource[], readonly PromptResource[]] {
  return [
    resources.filter(({ kind }) => kind === "skill"),
    resources.filter(({ kind }) => kind === "instruction"),
  ];
}

function sortResources(resources: readonly PromptResource[]): readonly PromptResource[] {
  return resources.toSorted(
    (left, right) => compareText(left.name, right.name) || compareText(left.id, right.id),
  );
}

export function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
