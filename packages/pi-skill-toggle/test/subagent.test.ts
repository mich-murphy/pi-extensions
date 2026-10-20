import { dirname, join } from "node:path";
import { formatSkillsForPrompt, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { registerSkillToggle } from "../index";
import type { ToggleHandlers } from "../index";
import type { SessionProjection, TranscriptMessage } from "../prompt-epoch";
import { resourcePathId } from "../resource-path";
import type { ToggleValue } from "../resources";
import { err, ok } from "../result";
import { registerSession, sessionPolicy, unregisterSession } from "../session-registry";
import type { SessionPolicy } from "../session-registry";
import { ToggleStateUnavailable } from "../state";
import type { ToggleStateStore } from "../state";

const REGISTRY = Symbol.for("pi-skill-toggle.sessions");
const PARENT = "0199aaaa-0000-7000-8000-000000000001";
const CHILD = "0199aaaa-0000-7000-8000-000000000002";
const GRANDCHILD = "0199aaaa-0000-7000-8000-000000000003";

function skill(path: string, name: string, scope: "user" | "project"): Skill {
  return {
    name,
    description: `${name} description`,
    filePath: path,
    baseDir: dirname(path),
    sourceInfo: { path, source: "local", scope, origin: "top-level" },
    disableModelInvocation: false,
  };
}

const research = skill(join(getAgentDir(), "skills/research/SKILL.md"), "research", "user");
const parentDeploy = skill("/work/parent/.agents/skills/deploy/SKILL.md", "deploy", "project");
const childDeploy = skill("/work/child/.agents/skills/deploy/SKILL.md", "deploy", "project");
const childOnly = skill("/work/child/.agents/skills/lint/SKILL.md", "lint", "project");

/** A mutable state file shared or not between sessions. */
function mutableStore(entries: Readonly<Record<string, ToggleValue>> = {}) {
  let current = new Map(
    Object.entries(entries).map(([path, value]) => [resourcePathId(path, "/"), value]),
  );
  let failing = false;
  const store: ToggleStateStore = {
    load: () =>
      failing
        ? err(new ToggleStateUnavailable("load", "/state.json", "EACCES", new Error("EACCES")))
        : ok({ files: current, repositories: new Map() }),
    set: () => ok({ files: current, repositories: new Map() }),
  };
  return {
    store,
    set(path: string, value: ToggleValue) {
      current = new Map([...current, [resourcePathId(path, "/"), value]]);
    },
    fail() {
      failing = true;
    },
  };
}

function session(store: ToggleStateStore, options: { id: string; cwd: string; parent?: string }) {
  const handlers: Partial<ToggleHandlers> = {};
  registerSkillToggle(
    {
      on: <K extends keyof ToggleHandlers>(name: K, handler: ToggleHandlers[K]) => {
        handlers[name] = handler;
      },
      registerCommand: () => undefined,
      getCommands: () => [],
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    },
    store,
    undefined,
  );
  let id = options.id;
  let projection: SessionProjection = { messages: [], entries: [] };
  const sessionManager = {
    getSessionId: () => id,
    getHeader: () => (options.parent === undefined ? {} : { parentSession: options.parent }),
    buildSessionProjection: () => projection,
  };
  const ctx = {
    cwd: options.cwd,
    ui: { notify: () => undefined },
    model: undefined,
    sessionManager,
  };
  return {
    start() {
      handlers.session_start?.({ type: "session_start" }, ctx);
    },
    shutdown() {
      handlers.session_shutdown?.({ type: "session_shutdown" }, ctx);
    },
    switchTo(next: string) {
      id = next;
      handlers.session_start?.({ type: "session_start" }, ctx);
    },
    /** Freeze the prompt as the model has it: these skills in the head, one answer since. */
    freeze(skills: readonly Skill[]) {
      const head: TranscriptMessage = {
        role: "system",
        content: "",
        sections: { skills: formatSkillsForPrompt([...skills]).trim() },
        timestamp: 1,
      } as TranscriptMessage;
      projection = { messages: [head, { role: "assistant" }], entries: [] };
    },
    run(skills: readonly Skill[]) {
      const systemPromptOptions = {
        cwd: options.cwd,
        sections: {},
        contextFiles: [],
        skills: [...skills],
      };
      const result = handlers.before_agent_start?.(
        { systemPrompt: "rendered by Pi", systemPromptOptions },
        ctx,
      );
      return { result, visible: systemPromptOptions.skills.map(({ name }) => name) };
    },
    read(path: string) {
      return handlers.tool_call?.({ toolName: "read", input: { path } }, ctx);
    },
    bash(command: string) {
      return handlers.tool_call?.({ toolName: "bash", input: { command } }, ctx);
    },
    type(text: string) {
      handlers.input?.({ text, source: "interactive" }, ctx);
    },
  };
}

function fail(): never {
  throw new Error("boom");
}

const deployReference = (root: string) => join(root, ".agents/skills/deploy/references/steps.md");

describe("session registry", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, REGISTRY);
  });

  const policy: SessionPolicy = {
    version: 1,
    match: (path) => (path === "/blocked" ? "blocked" : undefined),
    desiredVisible: () => true,
  };

  test("registers, looks up, and unregisters only its own entry", () => {
    registerSession(PARENT, policy);
    expect(sessionPolicy(PARENT)?.match("/blocked")).toBe("blocked");
    expect(sessionPolicy(PARENT)?.desiredVisible({ id: "/x", kind: "skill", name: "x" })).toBe(
      true,
    );
    unregisterSession(PARENT, { ...policy });
    expect(sessionPolicy(PARENT)).toBeDefined();
    unregisterSession(PARENT, policy);
    expect(sessionPolicy(PARENT)).toBeUndefined();
  });

  test("ignores a registry another value occupies", () => {
    Reflect.set(globalThis, REGISTRY, "not a map");
    expect(() => {
      registerSession(PARENT, policy);
      unregisterSession(PARENT, policy);
    }).not.toThrow();
    expect(sessionPolicy(PARENT)).toBeUndefined();
  });

  test("never throws when the registry map itself throws", () => {
    class Broken extends Map<unknown, unknown> {
      override get(): never {
        throw new Error("broken");
      }
      override set(): never {
        throw new Error("broken");
      }
    }
    Reflect.set(globalThis, REGISTRY, new Broken());
    expect(() => {
      registerSession(PARENT, policy);
      unregisterSession(PARENT, policy);
    }).not.toThrow();
    expect(sessionPolicy(PARENT)).toBeUndefined();
  });

  test("rejects malformed entries and other versions", () => {
    const map = new Map<unknown, unknown>([
      ["null", null],
      ["string", "policy"],
      ["v2", { ...policy, version: 2 }],
      ["no-match", { version: 1, desiredVisible: () => true }],
    ]);
    Reflect.set(globalThis, REGISTRY, map);
    for (const id of map.keys()) {
      expect(sessionPolicy(String(id))).toBeUndefined();
    }
  });

  test("contains entries that throw or answer with the wrong type", () => {
    Reflect.set(
      globalThis,
      REGISTRY,
      new Map<unknown, unknown>([
        ["throws", { version: 1, match: fail, desiredVisible: fail }],
        ["wrong", { version: 1, match: () => 1, desiredVisible: () => "yes" }],
      ]),
    );
    const resource = { id: "/x", kind: "skill", name: "x" } as const;
    expect(sessionPolicy("throws")?.match("/a")).toBe("/a");
    expect(sessionPolicy("throws")?.desiredVisible(resource)).toBeUndefined();
    expect(sessionPolicy("wrong")?.match("/a")).toBeUndefined();
    expect(sessionPolicy("wrong")?.desiredVisible(resource)).toBeUndefined();
  });
});

function family(parentStore: ToggleStateStore, childStore = mutableStore().store) {
  const parent = session(parentStore, { id: PARENT, cwd: "/work/parent" });
  parent.start();
  parent.run([research, parentDeploy]);
  const child = session(childStore, { id: CHILD, cwd: "/work/child", parent: PARENT });
  child.start();
  return { parent, child };
}

describe("subagents follow the parent", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, REGISTRY);
  });

  test("a child can read the skills the parent invoked manually", () => {
    const { parent, child } = family(mutableStore().store);
    child.run([childDeploy]);

    expect(child.read(deployReference("/work/child"))).toMatchObject({ block: true });
    parent.type("/skill:deploy ship it");
    expect(child.read(deployReference("/work/child"))).toBeUndefined();
    expect(child.bash(`cat ${deployReference("/work/child")}`)).toBeUndefined();
    expect(child.run([childDeploy]).visible).toStrictEqual(["deploy"]);
  });

  test("a child shows a project skill the parent enabled, matched by name", () => {
    const parentState = mutableStore({ [parentDeploy.filePath]: "enabled" });
    const { child } = family(parentState.store);

    expect(child.run([childDeploy, childOnly]).visible).toStrictEqual(["deploy"]);
    expect(child.read(childDeploy.filePath)).toBeUndefined();
  });

  test("a parent toggle reaches a running child at its next tool call and run", () => {
    const parentState = mutableStore();
    const { child } = family(parentState.store);
    child.freeze([research]);

    expect(child.run([research]).result).toBeUndefined();
    expect(child.read(research.filePath)).toBeUndefined();

    parentState.set(research.filePath, "disabled");

    expect(child.read(research.filePath)).toMatchObject({ block: true });
    const { result, visible } = child.run([research]);
    expect(visible).toStrictEqual(["research"]);
    expect(result).toMatchObject({
      message: { customType: "pi-skill-toggle", details: { visible: [] } },
    });
  });

  test("a parent whose state cannot load blocks every listed resource in the child", () => {
    const parentState = mutableStore();
    const { child } = family(parentState.store);
    parentState.fail();

    expect(child.read(research.filePath)).toMatchObject({ block: true });
    expect(child.run([research]).visible).toStrictEqual(["research"]);
  });

  test("without a registered parent the child keeps its own state", () => {
    const { parent, child } = family(mutableStore({ [parentDeploy.filePath]: "enabled" }).store);
    parent.type("/skill:deploy");
    parent.shutdown();

    expect(sessionPolicy(PARENT)).toBeUndefined();
    expect(child.run([childDeploy]).visible).toStrictEqual([]);
    expect(child.read(deployReference("/work/child"))).toMatchObject({ block: true });
  });

  test("switching sessions unregisters the previous id", () => {
    const { parent } = family(mutableStore().store);
    parent.switchTo("0199aaaa-0000-7000-8000-000000000009");

    expect(sessionPolicy(PARENT)).toBeUndefined();
    expect(sessionPolicy("0199aaaa-0000-7000-8000-000000000009")).toBeDefined();
  });

  test("a grandchild follows the root session through its parent", () => {
    const { parent, child } = family(mutableStore({ [parentDeploy.filePath]: "enabled" }).store);
    child.run([childDeploy]);
    const grandchild = session(mutableStore().store, {
      id: GRANDCHILD,
      cwd: "/work/grandchild",
      parent: CHILD,
    });
    grandchild.start();
    const deploy = skill("/work/grandchild/.agents/skills/deploy/SKILL.md", "deploy", "project");

    expect(grandchild.run([deploy]).visible).toStrictEqual(["deploy"]);
    expect(grandchild.read(deployReference("/work/grandchild"))).toBeUndefined();
    parent.shutdown();
    expect(grandchild.run([deploy]).visible).toStrictEqual([]);
  });

  test("a parent cycle ends without recursing forever", () => {
    const a = session(mutableStore().store, { id: PARENT, cwd: "/work/a", parent: CHILD });
    const b = session(mutableStore().store, { id: CHILD, cwd: "/work/b", parent: PARENT });
    a.start();
    b.start();
    a.run([research]);
    b.run([research]);

    expect(a.read(research.filePath)).toMatchObject({ block: true });
    expect(b.run([research]).visible).toStrictEqual(["research"]);
  });
});
