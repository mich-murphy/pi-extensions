import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { cacheDebugSink, debugPath, fingerprint, runRecord, usageRecord } from "../cache-debug";
import { modelView, planPrompt, promptSnapshot } from "../prompt-epoch";
import { escapeXml, isInPrompt, promptResources, skillReader } from "../prompt-view";
import type { PromptResource, SkillReader } from "../prompt-view";
import { resourcePathId } from "../resource-path";
import { noteView, renderToggleNote, TOGGLE_NOTE_TYPE } from "../toggle-note";

const cwd = "/work";
const REVERT_NOTE = [
  "The user changed /skill-toggle. This note supersedes earlier /skill-toggle notes.",
  "The system prompt's skills and project instructions apply as listed.",
].join("\n");
const skillA: PromptResource = {
  id: resourcePathId("/s/a & <b>/SKILL.md", cwd),
  kind: "skill",
  path: "/s/a & <b>/SKILL.md",
  name: "alpha",
  body: 'Alpha\'s "skill"',
};
const skillB: PromptResource = {
  id: resourcePathId("/s/b/SKILL.md", cwd),
  kind: "skill",
  path: "/s/b/SKILL.md",
  name: "beta",
  body: "Beta",
};
const rules: PromptResource = {
  id: resourcePathId("/work/AGENTS.md", cwd),
  kind: "instruction",
  path: "/work/AGENTS.md",
  name: "/work/AGENTS.md",
  body: "Be careful",
};
const resources = [skillA, skillB, rules];

function skill(resource: PromptResource): Skill {
  return {
    name: resource.name,
    description: resource.body,
    filePath: resource.path,
    baseDir: "/s",
    sourceInfo: { path: resource.path, source: "local", scope: "user", origin: "top-level" },
    disableModelInvocation: false,
  };
}

function head(skills: readonly PromptResource[], withRules = true) {
  return {
    role: "system",
    content: "",
    sections: {
      skills: formatSkillsForPrompt(skills.map((resource) => skill(resource))).trim(),
      ...(withRules
        ? {
            project_context: `<project_instructions path="${rules.path}">\nx\n</project_instructions>`,
          }
        : {}),
    },
    timestamp: 1,
  };
}

const assistant = { role: "assistant", provider: "p", model: "m" };
const model = { provider: "p", id: "m" };
const badNoteValue = { role: "custom", customType: TOGGLE_NOTE_TYPE, details: 1 };
const badNote: { readonly role: string } = badNoteValue;
const otherNoteValue = { role: "custom", customType: "other", details: {} };
const otherNote: { readonly role: string } = otherNoteValue;
function usageOf(input: number, cacheRead: number): { readonly role: string } {
  const message = {
    ...assistant,
    usage: { input, output: 5, cacheRead, cacheWrite: 0 },
  };
  return message;
}
type Item = { readonly role: string };
/** A `model_change` entry, written as an item so tests can place it among messages. */
const switchTo = (provider: string, modelId: string) => ({
  role: "model_change",
  provider,
  modelId,
});
const entryOf = (item: Item) => ({
  sourceEntry:
    item.role === "model_change"
      ? { ...item, type: "model_change" }
      : { type: "message", message: item },
});
const snap = (items: readonly Item[]) =>
  promptSnapshot(
    {
      messages: items.filter(({ role }) => role !== "model_change"),
      entries: items.map((item) => entryOf(item)),
    },
    resources,
  );
const view = (messages: readonly { role: string }[]) => [
  ...modelView(messages, snap(messages).sections, resources),
];
const frozen = (messages: readonly { role: string }[], hidden?: readonly string[]) =>
  planPrompt({
    ...snap(messages),
    resources,
    reader: "read",
    desiredHidden:
      hidden === undefined ? undefined : new Set(hidden.map((id) => resourcePathId(id, cwd))),
  });
const note = (visible: readonly string[]) => ({
  role: "custom",
  customType: TOGGLE_NOTE_TYPE,
  details: { version: 1, visible },
});

describe("prompt view", () => {
  test("escapes like Pi and detects skills with special characters", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
    const sections = head([skillA]).sections;
    expect(isInPrompt(sections, skillA)).toBe(true);
    expect(isInPrompt(sections, skillB)).toBe(false);
    expect(isInPrompt(sections, rules)).toBe(true);
    expect(isInPrompt({}, rules)).toBe(false);
  });

  test("pairs only editable resources, once each", () => {
    const listed = promptResources(
      {
        cwd,
        skills: [skill(skillA), skill(skillA), skill(skillB)],
        contextFiles: [{ path: rules.path, content: "c" }],
      },
      [
        { id: skillA.id, editability: "editable" },
        { id: skillB.id, editability: "manual-only" },
        { id: rules.id, editability: "editable" },
      ],
    );
    expect(listed.map(({ id }) => id)).toStrictEqual([rules.id, skillA.id]);
  });
});

describe("epoch and model view", () => {
  test("initial without a system message, frozen after, model-change after a switch", () => {
    expect(snap([]).epoch).toBe("initial");
    expect(snap([head([skillA]), assistant]).epoch).toBe("frozen");
    expect(snap([head([skillA])]).epoch).toBe("frozen");
    expect(snap([head([skillA]), assistant, switchTo("p", "other")]).epoch).toBe("model-change");
    // Switching away and back keeps the cache of the model that answered.
    expect(
      snap([head([skillA]), assistant, switchTo("p", "other"), switchTo("p", "m")]).epoch,
    ).toBe("frozen");
  });

  test("virtual model routing stays frozen", () => {
    const routed = { role: "assistant", provider: "openai", model: "gpt-x" };
    const virtual = switchTo("router", "auto");
    expect(snap([virtual, head([skillA]), routed]).epoch).toBe("frozen");
    // Re-selecting, or `_recordSelection` after tree navigation, records the same selection.
    expect(snap([virtual, head([skillA]), routed, virtual]).epoch).toBe("frozen");
    expect(snap([virtual, head([skillA]), routed, switchTo("p", "m")]).epoch).toBe("model-change");
  });

  test("resume restoring the same model stays frozen", () => {
    expect(snap([switchTo("p", "m"), head([skillA]), assistant]).epoch).toBe("frozen");
    expect(snap([head([skillA]), assistant, switchTo("p", "m")]).epoch).toBe("frozen");
    expect(snap([head([skillA]), { role: "assistant" }, switchTo("q", "m")]).epoch).toBe("frozen");
  });

  test("reads the compaction checkpoint at index 0 and kept entries", () => {
    const checkpoint = { sourceEntry: { type: "compaction" } };
    const messages = [head([skillA]), { role: "compactionSummary" }, assistant];
    const epoch = (entries: readonly { sourceEntry: { type: string } }[]) =>
      promptSnapshot({ messages, entries }, resources).epoch;
    expect(epoch([checkpoint, entryOf(assistant)])).toBe("frozen");
    expect(epoch([checkpoint, entryOf(assistant), entryOf(switchTo("q", "m"))])).toBe(
      "model-change",
    );
    expect(
      epoch([
        entryOf(switchTo("q", "m")),
        checkpoint,
        entryOf(assistant),
        entryOf(switchTo("q", "m")),
      ]),
    ).toBe("frozen");
    expect(epoch([checkpoint, entryOf(switchTo("q", "m"))])).toBe("frozen");
  });

  test("a note before a single-section patch still decides the other section", () => {
    const patch = {
      role: "system",
      content: "",
      sections: { skills: head([skillA, skillB]).sections.skills },
    };
    expect(view([head([skillA]), note([skillA.id]), patch])).toStrictEqual([skillA.id, skillB.id]);
  });

  test("frozen hides manual-only skills but never a skill the prompt lists", () => {
    const manual = resourcePathId("/s/manual/SKILL.md", cwd);
    const plan = frozen([head([skillA]), assistant], [manual, skillA.id]);
    expect([...plan.hidden].toSorted()).toStrictEqual([manual, skillB.id].toSorted());
  });

  test("folds head, patches, notes, and a later patch over a note", () => {
    const patch = {
      role: "system",
      content: "",
      sections: { skills: head([skillB]).sections.skills },
    };
    expect(view([head([skillA])])).toStrictEqual([skillA.id, rules.id]);
    expect(view([head([skillA]), patch])).toStrictEqual([skillB.id, rules.id]);
    expect(view([head([skillA]), note([skillB.id])])).toStrictEqual([skillB.id]);
    expect(view([head([skillA]), note([skillB.id]), patch])).toStrictEqual([skillB.id]);
    expect(view([head([skillA]), badNote])).toStrictEqual([skillA.id, rules.id]);
    expect(noteView(otherNote)).toBeUndefined();
  });
});

describe("planPrompt", () => {
  test("initial applies the desired state without a note", () => {
    const plan = frozen([], [skillB.id]);
    expect([...plan.hidden]).toStrictEqual([skillB.id]);
    expect(plan.note).toBeUndefined();
  });

  test("frozen keeps the prompt and announces toggles in a note", () => {
    const plan = frozen([head([skillA]), assistant], [skillA.id, rules.id]);
    expect([...plan.hidden]).toStrictEqual([skillB.id]);
    expect(plan.note?.details.visible).toStrictEqual([skillB.id]);
    expect(plan.note?.content).toContain(
      "Disabled skills (do not load unless the user invokes /skill:<name>): alpha",
    );
    expect(plan.note?.content).toContain("<name>beta</name>");
    expect(plan.note?.content).toContain(`Disabled instructions (disregard): ${rules.path}`);
  });

  test("toggling back to the model's view produces no note", () => {
    expect(frozen([head([skillA]), assistant], [skillB.id]).note).toBeUndefined();
    expect(
      frozen([head([skillA]), note([skillB.id]), assistant], [skillA.id, rules.id]).note,
    ).toBeUndefined();
  });

  test("a state failure in a frozen epoch changes nothing", () => {
    const plan = frozen([head([skillA]), assistant]);
    expect([...plan.hidden]).toStrictEqual([skillB.id]);
    expect(plan.note).toBeUndefined();
    expect([...frozen([]).hidden]).toStrictEqual([]);
  });

  test("a model change applies the state and needs no note for patched sections", () => {
    const plan = planPrompt({
      ...snap([head([skillA]), note([skillA.id]), assistant, switchTo("q", "m")]),
      resources,
      reader: "read",
      desiredHidden: new Set([skillA.id]),
    });
    expect([...plan.hidden]).toStrictEqual([skillA.id]);
    expect(plan.note?.details.visible).toStrictEqual([skillB.id, rules.id].toSorted());
    // The patch lists the user's choice, so the note only revokes the earlier note.
    expect(plan.note?.content).toBe(REVERT_NOTE);
  });

  test("renders enabled instructions with their content", () => {
    expect(renderToggleNote({ enabled: [rules], disabled: [] }, "read")).toContain(
      `<project_instructions path="${rules.path}">\nBe careful\n</project_instructions>`,
    );
  });
});

const ids = (paths: readonly string[]) => new Set(paths.map((id) => resourcePathId(id, cwd)));

const planFor = (
  messages: readonly Item[],
  hidden: readonly string[],
  reader: SkillReader = "read",
) => planPrompt({ ...snap(messages), resources, reader, desiredHidden: ids(hidden) });

describe("standalone toggle notes", () => {
  test("a second note restates the first one's changes", () => {
    const first = planFor([head([skillA, skillB]), assistant], [skillA.id]).note;
    expect(first?.content).toContain(
      "Disabled skills (do not load unless the user invokes /skill:<name>): alpha",
    );
    const firstMessage = { role: "custom", customType: TOGGLE_NOTE_TYPE, details: first?.details };
    const second = planFor([head([skillA, skillB]), firstMessage, assistant], [skillA.id, rules.id])
      .note?.content;
    expect(second).toBe(
      [
        "The user changed /skill-toggle. This note supersedes earlier /skill-toggle notes and overrides the skills and project instructions listed in the system prompt.",
        "Disabled skills (do not load unless the user invokes /skill:<name>): alpha",
        `Disabled instructions (disregard): ${rules.path}`,
      ].join("\n"),
    );
  });

  test("reverting to the system prompt's lists after a note emits the revert note", () => {
    const messages = [head([skillA]), note([skillA.id]), assistant];
    expect(planFor(messages, [skillB.id]).note?.content).toBe(REVERT_NOTE);
    expect(planFor([head([skillA]), assistant], [skillB.id]).note).toBeUndefined();
  });

  test("enabled skills use Pi's guidance for the run's reader", () => {
    const enabled = (reader: SkillReader) =>
      renderToggleNote({ enabled: [skillB], disabled: [] }, reader);
    expect(enabled("read")).toContain(formatSkillsForPrompt([skill(skillB)], "read").trim());
    expect(enabled("read")).toContain("Use the read tool to load a skill's file");
    expect(enabled("bash")).toContain("Use bash to load a skill's file");
    expect(enabled("indirect")).toContain("\nLoad a skill's file when the task matches");
    expect(enabled("read")).toContain("resolve it against the skill directory");
  });

  test("picks the reader like Pi", () => {
    expect(skillReader({})).toBe("read");
    expect(skillReader({ selectedTools: ["bash", "edit"] })).toBe("bash");
    expect(skillReader({ selectedTools: ["read", "bash"], hiddenTools: ["read"] })).toBe("bash");
    expect(skillReader({ selectedTools: ["read"], hiddenTools: ["read"] })).toBe("indirect");
    expect(skillReader({ selectedTools: ["edit"] })).toBe("indirect");
  });

  test("renders identical text for identical choices", () => {
    const messages = [head([skillA]), assistant];
    const once = planFor(messages, [skillA.id]).note;
    expect(once).toStrictEqual(planFor(messages, [skillA.id]).note);
    const content = String(once?.content);
    expect(content.indexOf("Disabled skills (")).toBeGreaterThan(0);
    expect(content.indexOf("Disabled skills (")).toBeLessThan(content.indexOf("Enabled skills:"));
    expect(content).toContain("<name>beta</name>");
    expect(content).not.toContain("Enabled instructions:");
  });
});

describe("cache debug", () => {
  test("resolves the target from the environment value", () => {
    expect(debugPath(undefined)).toBeUndefined();
    expect(debugPath("")).toBeUndefined();
    expect(debugPath("0")).toBeUndefined();
    expect(debugPath("1", () => "/agent")).toBe("/agent/pi-skill-toggle-cache-debug.jsonl");
    expect(debugPath("/tmp/x.jsonl")).toBe("/tmp/x.jsonl");
    expect(cacheDebugSink("0")).toBeUndefined();
  });

  test("appends JSONL and swallows write failures", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-skill-toggle-debug-"));
    try {
      const path = join(directory, "log.jsonl");
      cacheDebugSink(path)?.({ type: "discover", contributed: 1 });
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        type: "discover",
        contributed: 1,
      });
      const failing = cacheDebugSink(path, () => {
        throw new Error("disk full");
      });
      expect(() => failing?.({ type: "discover" })).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("builds run and usage records", () => {
    const messages = [head([skillA]), assistant];
    const snapshot = snap(messages);
    const desiredHidden = new Set([skillA.id]);
    const plan = planPrompt({ ...snapshot, resources, desiredHidden, reader: "read" });
    const record = runRecord({
      sessionId: "s",
      model,
      snapshot,
      plan,
      resources,
      desiredHidden,
      options: { cwd, skills: [skill(skillA)], contextFiles: [] },
      durationMs: 1,
    });
    expect(record).toMatchObject({
      type: "run",
      model: "p/m",
      epoch: "frozen",
      stateLoad: "ok",
      inPromptBefore: 2,
      note: { enabled: [skillB.id], disabled: [skillA.id] },
    });
    expect(
      runRecord({
        sessionId: "s",
        model: undefined,
        snapshot,
        plan: { ...plan, note: undefined },
        resources,
        desiredHidden: undefined,
        options: { cwd },
        durationMs: 0,
      }),
    ).toMatchObject({ model: null, stateLoad: "failed", note: null });
    expect(fingerprint(["a"])).toBe(fingerprint(["a"]));
    expect(usageRecord(usageOf(10, 90), "s")).toMatchObject({
      type: "usage",
      promptTokens: 100,
      cacheReadPercent: 90,
    });
    expect(usageRecord(usageOf(0, 0), "s")).toMatchObject({ cacheReadPercent: 0 });
    expect(usageRecord({ role: "user" }, "s")).toBeUndefined();
  });
});
