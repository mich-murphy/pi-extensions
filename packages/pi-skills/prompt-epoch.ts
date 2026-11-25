import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { Option, Schema } from "effect";
import { isInPrompt, RESOURCE_SECTIONS } from "./prompt-view";
import type { PromptResource, SkillReader } from "./prompt-view";
import type { ResourcePath } from "./resource-path";
import { noteView, toggleChanges, toggleNote } from "./toggle-note";
import type { ToggleChanges, ToggleNote } from "./toggle-note";

export type Epoch = "initial" | "model-change" | "frozen";

export type TranscriptMessage = { readonly role: string };

export type ModelRef = { readonly provider: string; readonly id: string };

export type PromptSections = Readonly<Record<string, string | null>>;

export type PromptSnapshot = {
  readonly epoch: Epoch;
  readonly sections: PromptSections;
  readonly view: ReadonlySet<ResourcePath>;
};

export type ProjectedEntry = { readonly sourceEntry: { readonly type: string } };

export type SessionProjection = {
  readonly messages: readonly TranscriptMessage[];
  readonly entries: readonly ProjectedEntry[];
};

type Selection = { readonly provider: string; readonly modelId: string };

export function promptSnapshot(
  projection: SessionProjection,
  resources: readonly PromptResource[],
): PromptSnapshot {
  const { messages, entries } = projection;
  const system = getCurrentSystemMessage(messages);
  const sections = system?.sections ?? {};
  return {
    epoch: system === undefined ? "initial" : laterEpoch(entries),
    sections,
    view: modelView(messages, sections, resources),
  };
}

function laterEpoch(entries: readonly ProjectedEntry[]): Epoch {
  const answer = entries.findLastIndex(({ sourceEntry }) => responseModel(sourceEntry) !== null);
  const response = entries[answer];
  const selected = latestSelection(entries.slice(answer + 1));
  if (response === undefined || selected === undefined) {
    return "frozen";
  }
  const before = latestSelection(entries.slice(0, answer)) ?? responseModel(response.sourceEntry);
  return before && !sameSelection(selected, before) ? "model-change" : "frozen";
}

function sameSelection(left: Selection, right: Selection): boolean {
  return left.provider === right.provider && left.modelId === right.modelId;
}

function latestSelection(entries: readonly ProjectedEntry[]): Selection | undefined {
  return entries
    .map(({ sourceEntry }) => modelChange(sourceEntry))
    .findLast((selection) => selection !== undefined);
}

const decodeSelection = Schema.decodeUnknownOption(
  Schema.Struct({ provider: Schema.String, modelId: Schema.String }),
);
const isAssistantMessage = Schema.is(Schema.Struct({ role: Schema.Literal("assistant") }));

function modelChange(entry: ProjectedEntry["sourceEntry"]): Selection | undefined {
  return entry.type === "model_change" ? Option.getOrUndefined(decodeSelection(entry)) : undefined;
}

function responseModel(entry: ProjectedEntry["sourceEntry"]): Selection | null | undefined {
  const message = "message" in entry ? entry.message : undefined;
  if (entry.type !== "message" || !isAssistantMessage(message)) {
    return null;
  }
  const provider = "provider" in message ? message.provider : undefined;
  const modelId = "model" in message ? message.model : undefined;
  return Option.getOrUndefined(decodeSelection({ provider, modelId }));
}

export function modelView(
  messages: readonly TranscriptMessage[],
  sections: PromptSections,
  resources: readonly PromptResource[],
): ReadonlySet<ResourcePath> {
  const noteIndex = messages.findLastIndex((message) => noteView(message) !== undefined);
  const latest = messages[noteIndex];
  const note = latest === undefined ? undefined : noteView(latest);
  const visible = resources.filter((resource) =>
    note !== undefined && noteIndex > lastSetting(messages, RESOURCE_SECTIONS[resource.kind])
      ? note.has(resource.id)
      : isInPrompt(sections, resource),
  );
  return new Set(visible.map(({ id }) => id));
}

function lastSetting(messages: readonly TranscriptMessage[], section: string): number {
  return messages.findLastIndex((message) => {
    if (message.role !== "system" || !("sections" in message)) {
      return false;
    }
    const { sections } = message;
    return Schema.is(Schema.ObjectKeyword)(sections) && Object.hasOwn(sections, section);
  });
}

export type PromptPlanInput = PromptSnapshot & {
  readonly resources: readonly PromptResource[];
  readonly desiredHidden: ReadonlySet<ResourcePath> | undefined;
  readonly reader: SkillReader;
};

export type PromptPlan = {
  readonly hidden: ReadonlySet<ResourcePath>;
  readonly changes: ToggleChanges;
  readonly note: ToggleNote | undefined;
};

const NO_CHANGES: ToggleChanges = { enabled: [], disabled: [] };

export function planPrompt(input: PromptPlanInput): PromptPlan {
  const { epoch, desiredHidden, resources } = input;
  if (epoch === "initial") {
    return { hidden: desiredHidden ?? new Set(), changes: NO_CHANGES, note: undefined };
  }
  if (desiredHidden === undefined) {
    return { hidden: notInPrompt(input), changes: NO_CHANGES, note: undefined };
  }
  const desiredVisible = new Set(
    resources.filter(({ id }) => !desiredHidden.has(id)).map(({ id }) => id),
  );
  const frozen = epoch === "frozen";
  const listed = frozen ? inPrompt(input) : desiredVisible;
  const changes = toggleChanges(resources, listed, desiredVisible);
  return {
    hidden: frozen ? frozenHidden(input, desiredHidden) : desiredHidden,
    changes,
    note: toggleNote({
      resources,
      view: frozen ? input.view : viewAfterPatch(input, desiredVisible),
      desired: desiredVisible,
      changes,
      reader: input.reader,
    }),
  };
}

function inPrompt(input: PromptPlanInput): ReadonlySet<ResourcePath> {
  return new Set(
    input.resources.filter((resource) => isInPrompt(input.sections, resource)).map(({ id }) => id),
  );
}

function notInPrompt(input: PromptPlanInput): Set<ResourcePath> {
  return new Set(
    input.resources.filter((resource) => !isInPrompt(input.sections, resource)).map(({ id }) => id),
  );
}

function frozenHidden(
  input: PromptPlanInput,
  desiredHidden: ReadonlySet<ResourcePath>,
): ReadonlySet<ResourcePath> {
  const editable = new Set(input.resources.map(({ id }) => id));
  return new Set([...notInPrompt(input), ...[...desiredHidden].filter((id) => !editable.has(id))]);
}

function viewAfterPatch(
  input: PromptPlanInput,
  desiredVisible: ReadonlySet<ResourcePath>,
): ReadonlySet<ResourcePath> {
  const patched = new Set(
    input.resources
      .filter(
        (resource) => isInPrompt(input.sections, resource) !== desiredVisible.has(resource.id),
      )
      .map(({ kind }) => kind),
  );
  return new Set(
    input.resources
      .filter(({ id, kind }) => (patched.has(kind) ? desiredVisible : input.view).has(id))
      .map(({ id }) => id),
  );
}
