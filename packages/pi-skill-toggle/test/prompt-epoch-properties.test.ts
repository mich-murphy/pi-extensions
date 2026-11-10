import assert from "node:assert/strict";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { stateful } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertyTimeout } from "../../../test-support/hegel-settings";
import { planPrompt, promptSnapshot } from "../prompt-epoch";
import type { PromptPlan, PromptSnapshot } from "../prompt-epoch";
import { isInPrompt, RESOURCE_SECTIONS } from "../prompt-view";
import type { PromptResource } from "../prompt-view";
import { resourcePathId } from "../resource-path";
import type { ResourcePath } from "../resource-path";
import { noteView } from "../toggle-note";
import { assertProperty } from "./hegel-property";

const cwd = "/work";
const MODELS = [
  { provider: "p", id: "m" },
  { provider: "p", id: "n" },
  { provider: "q", id: "m" },
] as const;

type Item = { readonly role: string };

/** Mutable session the rules drive: a transcript, the loaded resources, and the user's choice. */
type World = {
  readonly resources: readonly PromptResource[];
  readonly hidden: Set<ResourcePath>;
  readonly items: Item[];
  selected: number;
};

function resourceAt(index: number, isSkill: boolean): PromptResource {
  // Markup characters in paths exercise the escaping the prompt view must match.
  const path = isSkill ? `/s/${index} & <b>/SKILL.md` : `/work/${index}/AGENTS.md`;
  return {
    id: resourcePathId(path, cwd),
    kind: isSkill ? "skill" : "instruction",
    path,
    name: isSkill ? `skill${index}` : path,
    body: `body ${index} <x>`,
  };
}

function skillOf(resource: PromptResource): Skill {
  return {
    name: resource.name,
    description: resource.body,
    filePath: resource.path,
    baseDir: "/s",
    sourceInfo: { path: resource.path, source: "local", scope: "user", origin: "top-level" },
    disableModelInvocation: false,
  };
}

function renderSection(
  kind: PromptResource["kind"],
  resources: readonly PromptResource[],
  visible: ReadonlySet<string>,
): string {
  const shown = resources.filter((resource) => resource.kind === kind && visible.has(resource.id));
  return kind === "skill"
    ? formatSkillsForPrompt(shown.map((resource) => skillOf(resource))).trim()
    : shown
        .map(({ path }) => `<project_instructions path="${path}">\nx\n</project_instructions>`)
        .join("\n");
}

/** A system message writing the given kinds' sections to show exactly `visible`. */
function systemMessage(
  resources: readonly PromptResource[],
  visible: ReadonlySet<string>,
  kinds: ReadonlySet<string>,
): Item {
  const sections: Record<string, string> = {};
  for (const kind of ["skill", "instruction"] as const) {
    if (kinds.has(kind)) {
      sections[RESOURCE_SECTIONS[kind]] = renderSection(kind, resources, visible);
    }
  }
  return { role: "system", content: "", sections, timestamp: 1 } as Item;
}

function snapshotOf(world: World): PromptSnapshot {
  return promptSnapshot(
    {
      messages: world.items.filter(({ role }) => role !== "model_change"),
      entries: world.items.map((item) => ({
        sourceEntry:
          item.role === "model_change"
            ? { ...item, type: "model_change" }
            : { type: "message", message: item },
      })),
    },
    world.resources,
  );
}

function planOf(world: World, snapshot: PromptSnapshot): PromptPlan {
  return planPrompt({
    ...snapshot,
    resources: world.resources,
    reader: "read",
    desiredHidden: new Set(world.hidden),
  });
}

function desiredVisible(world: World): Set<string> {
  return new Set(world.resources.filter(({ id }) => !world.hidden.has(id)).map(({ id }) => id));
}

function ids(resources: readonly { readonly id: string }[]): string[] {
  return resources.map(({ id }) => id).toSorted();
}

/** Invariants of one plan, judged against the user's choice and the transcript's prompt. */
function assertPlan(world: World, snapshot: PromptSnapshot, plan: PromptPlan): void {
  const desired = desiredVisible(world);
  const { enabled, disabled } = plan.changes;
  const overlap = ids(enabled).filter((id) => ids(disabled).includes(id));
  assert.deepEqual(overlap, [], "enabled and disabled changes are disjoint");
  assert.ok(enabled.every(({ id }) => desired.has(id)));
  assert.ok(disabled.every(({ id }) => !desired.has(id)));

  if (plan.note !== undefined) {
    const recorded = noteView({ role: "custom", ...plan.note });
    assert.deepEqual([...(recorded ?? [])].toSorted(), [...plan.note.details.visible]);
    assert.deepEqual([...plan.note.details.visible], [...desired].toSorted());
  }
  if (snapshot.epoch === "initial") {
    assert.equal(plan.note, undefined);
  }
  if (snapshot.epoch === "frozen") {
    assertFrozen(world, snapshot, plan, desired);
  }
  if (snapshot.epoch === "model-change") {
    // Pi patches kinds whose lists differ from the choice; only the other kinds keep their view.
    const patched = patchedKinds(world, snapshot);
    const converged = world.resources.every(
      (resource) =>
        (patched.has(resource.kind) ? true : snapshot.view.has(resource.id)) ===
          desired.has(resource.id) || patched.has(resource.kind),
    );
    assert.equal(plan.note === undefined, converged, "model-change note only for unpatched kinds");
  }
}

function assertFrozen(
  world: World,
  snapshot: PromptSnapshot,
  plan: PromptPlan,
  desired: ReadonlySet<string>,
): void {
  const { resources } = world;
  for (const resource of resources) {
    const listed = isInPrompt(snapshot.sections, resource);
    assert.equal(plan.hidden.has(resource.id), !listed, "a frozen prompt keeps its sections");
  }
  const listedNow = (resource: PromptResource): boolean => isInPrompt(snapshot.sections, resource);
  assert.deepEqual(
    ids(plan.changes.enabled),
    ids(resources.filter((resource) => desired.has(resource.id) && !listedNow(resource))),
  );
  assert.deepEqual(
    ids(plan.changes.disabled),
    ids(resources.filter((resource) => !desired.has(resource.id) && listedNow(resource))),
  );
  const converged = resources.every(({ id }) => snapshot.view.has(id) === desired.has(id));
  assert.equal(plan.note === undefined, converged, "a note exists iff the view differs");
}

/** Kinds where the prompt's lists differ from the user's choice, which Pi patches. */
function patchedKinds(world: World, snapshot: PromptSnapshot): Set<string> {
  const desired = desiredVisible(world);
  return new Set(
    world.resources
      .filter((resource) => isInPrompt(snapshot.sections, resource) !== desired.has(resource.id))
      .map(({ kind }) => kind),
  );
}

function respond(world: World): void {
  const snapshot = snapshotOf(world);
  const plan = planOf(world, snapshot);
  assertPlan(world, snapshot, plan);
  const desired = desiredVisible(world);
  if (snapshot.epoch === "initial") {
    world.items.push(systemMessage(world.resources, desired, new Set(["skill", "instruction"])));
  } else if (snapshot.epoch === "model-change") {
    world.items.push(systemMessage(world.resources, desired, patchedKinds(world, snapshot)));
  }
  if (plan.note !== undefined) {
    world.items.push({ role: "custom", ...plan.note });
  }
  const model = MODELS[world.selected] ?? MODELS[0];
  world.items.push({ role: "assistant", provider: model.provider, model: model.id } as Item);

  const after = snapshotOf(world);
  assert.deepEqual([...after.view].toSorted(), [...desired].toSorted(), "the view converges");
  assert.equal(after.epoch, "frozen");
  assert.equal(planOf(world, after).note, undefined, "replanning needs no note");
}

const machine: stateful.StateMachine<World> = {
  rules: {
    toggle: (tc, world) => {
      tc.assume(world.resources.length > 0);
      const id = tc.draw(gs.sampledFrom(world.resources.map((resource) => resource.id)));
      if (!world.hidden.delete(id)) {
        world.hidden.add(id);
      }
    },
    respond: {
      weight: 3,
      apply: (_tc: TestCase, world: World) => {
        respond(world);
      },
    },
    selectModel: (tc, world) => {
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: MODELS.length - 1 }));
      const model = MODELS[index] ?? MODELS[0];
      world.items.push({
        role: "model_change",
        provider: model.provider,
        modelId: model.id,
      } as Item);
      world.selected = index;
    },
    // Compaction drops responses and model switches but keeps system messages and notes.
    compact: (_tc, world) => {
      const kept = world.items.filter(({ role }) => role === "system" || role === "custom");
      world.items.splice(0, world.items.length, ...kept);
    },
  },
};

function newWorld(tc: TestCase): World {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
  const kinds = Array.from({ length: count }, () => tc.draw(gs.booleans()));
  return {
    resources: kinds.map((isSkill, index) => resourceAt(index, isSkill)),
    hidden: new Set(),
    items: [],
    selected: 0,
  };
}

describe("prompt-epoch properties", () => {
  // A stateful machine that renders whole prompts each step: 0.25 s quiet and 0.52 s under 8 busy
  // processes.
  test(
    "prompt plans converge under toggles, responses, model switches, and compaction",
    { timeout: propertyTimeout(30_000) },
    () => {
      assertProperty(
        "prompt-epoch",
        "prompt plans converge under toggles, responses, model switches, and compaction",
        (tc) => {
          stateful.run(tc, machine, newWorld(tc));
        },
      );
    },
  );
});
