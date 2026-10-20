import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { isInPrompt, RESOURCE_SECTIONS } from "./prompt-view";
import type { PromptResource, SkillReader } from "./prompt-view";
import type { ResourcePath } from "./resource-path";
import { noteView, toggleChanges, toggleNote } from "./toggle-note";
import type { ToggleChanges, ToggleNote } from "./toggle-note";

/**
 * Which prompt a run may change.
 *
 * - `initial`: no system message yet, so Pi writes the prompt as the session head.
 * - `model-change`: the cache is cold for the new model, so a section patch costs nothing.
 * - `frozen`: the prompt stays as the model has it; toggles arrive as appended notes.
 */
export type Epoch = "initial" | "model-change" | "frozen";

/** Any transcript entry. Only system, assistant, and toggle-note entries are read. */
export type TranscriptMessage = { readonly role: string };

/** The model selected for the run. */
export type ModelRef = { readonly provider: string; readonly id: string };

/** Prompt sections after replaying every system message. */
export type PromptSections = Readonly<Record<string, string | null>>;

/** What the transcript says about the prompt the model has. */
export type PromptSnapshot = {
  readonly epoch: Epoch;
  readonly sections: PromptSections;
  /** Toggle resources the model currently treats as visible. */
  readonly view: ReadonlySet<ResourcePath>;
};

/** A projected session entry. Only assistant messages and model changes are read. */
export type ProjectedEntry = { readonly sourceEntry: { readonly type: string } };

/** The current branch as `sessionManager.buildSessionProjection()` returns it. */
export type SessionProjection = {
  readonly messages: readonly TranscriptMessage[];
  readonly entries: readonly ProjectedEntry[];
};

type Selection = { readonly provider: string; readonly modelId: string };

/** Read the epoch, prompt sections, and model view from the current branch's projection. */
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

/**
 * `model-change` only when the user selected another model since the latest response.
 *
 * Responses name the physical model a virtual model routed to, and providers may report another
 * id than the selection, so they are never compared with `ctx.model`. Pi also re-records an
 * unchanged selection (re-selecting it, or `_recordSelection` after tree navigation), so the latest
 * `model_change` after the response must differ from the selection that response ran under: the
 * previous `model_change`, or the response's own model when compaction dropped it.
 */
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

function modelChange(entry: { readonly type: string }): Selection | undefined {
  if (entry.type !== "model_change" || !("provider" in entry) || !("modelId" in entry)) {
    return undefined;
  }
  const { provider, modelId } = entry;
  return typeof provider === "string" && typeof modelId === "string"
    ? { provider, modelId }
    : undefined;
}

/**
 * The model an assistant message entry names.
 *
 * @returns `null` for other entries, undefined for a response without a readable model.
 */
function responseModel(entry: { readonly type: string }): Selection | null | undefined {
  const message = "message" in entry ? entry.message : undefined;
  if (
    entry.type !== "message" ||
    typeof message !== "object" ||
    message === null ||
    !("role" in message) ||
    message.role !== "assistant"
  ) {
    return null;
  }
  const provider = "provider" in message ? message.provider : undefined;
  const modelId = "model" in message ? message.model : undefined;
  return typeof provider === "string" && typeof modelId === "string"
    ? { provider, modelId }
    : undefined;
}

/**
 * Fold the model's view of toggle resources.
 *
 * Per section, the latest system message that set it decides, unless a later toggle note
 * recorded a newer view.
 */
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
    return typeof sections === "object" && sections !== null && Object.hasOwn(sections, section);
  });
}

/** Inputs to a run's prompt decision. */
export type PromptPlanInput = PromptSnapshot & {
  /** Editable toggle resources Pi loaded for the run. */
  readonly resources: readonly PromptResource[];
  /** Toggle resources the user disabled, or undefined when state could not be loaded. */
  readonly desiredHidden: ReadonlySet<ResourcePath> | undefined;
  /** The tool Pi's skill guidance names for this run. */
  readonly reader: SkillReader;
};

/** Resources to drop from the run's prompt options, and the note to append, if any. */
export type PromptPlan = {
  readonly hidden: ReadonlySet<ResourcePath>;
  /** Differences between the system prompt's lists and the user's choice that the note states. */
  readonly changes: ToggleChanges;
  readonly note: ToggleNote | undefined;
};

const NO_CHANGES: ToggleChanges = { enabled: [], disabled: [] };

/** Decide how a run delivers the user's toggles without changing a cached prompt. */
export function planPrompt(input: PromptPlanInput): PromptPlan {
  const { epoch, desiredHidden, resources } = input;
  if (epoch === "initial") {
    return { hidden: desiredHidden ?? new Set(), changes: NO_CHANGES, note: undefined };
  }
  if (desiredHidden === undefined) {
    // Keep the prompt and the model's view as they are until state can be read again.
    return { hidden: notInPrompt(input), changes: NO_CHANGES, note: undefined };
  }
  const desiredVisible = new Set(
    resources.filter(({ id }) => !desiredHidden.has(id)).map(({ id }) => id),
  );
  const frozen = epoch === "frozen";
  // A model change writes the user's choice into the prompt; a frozen prompt keeps its lists.
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

/** Keep every editable resource as the prompt has it; manual-only skills follow the state. */
function frozenHidden(
  input: PromptPlanInput,
  desiredHidden: ReadonlySet<ResourcePath>,
): ReadonlySet<ResourcePath> {
  const editable = new Set(input.resources.map(({ id }) => id));
  return new Set([...notInPrompt(input), ...[...desiredHidden].filter((id) => !editable.has(id))]);
}

/** A section Pi patches for the new model shows the user's choice; the others keep their view. */
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
