import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { testKeybindings, testTheme, testTui } from "../../../test-support/pi-tui";
import { disabledResourceMatcher, effectiveOverrides, toolPath } from "../guard";
import { isSubagentSession, registerSkillToggle } from "../index";
import type { GuardContext, ToggleHandlers } from "../index";
import { RepositoryLocator } from "../repository";
import { resourcePathId } from "../resource-path";
import type { ToggleOverrides, ToggleResource, ToggleValue } from "../resources";
import { err, ok } from "../result";
import { ToggleStateUnavailable } from "../state";
import type { ToggleStateStore } from "../state";

const temporaryDirectories: string[] = [];

function write(path: string, content = "content\n"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** A main checkout with a linked worktree, laid out the way `git worktree add` leaves it. */
function repository(): {
  readonly main: string;
  readonly worktree: string;
  readonly other: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-skill-toggle-guard-")));
  temporaryDirectories.push(root);
  const main = join(root, "main");
  const worktree = join(main, ".worktrees", "worker3");
  const other = join(root, "other");
  mkdirSync(join(main, ".git", "worktrees", "worker3"), { recursive: true });
  write(join(main, ".git", "worktrees", "worker3", "commondir"), "../..\n");
  write(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "worker3")}\n`);
  mkdirSync(join(other, ".git"), { recursive: true });
  for (const checkout of [main, worktree, other]) {
    write(join(checkout, "AGENTS.md"));
    write(join(checkout, "web", "AGENTS.md"));
    write(join(checkout, ".agents", "skills", "deploy", "SKILL.md"));
    write(join(checkout, ".agents", "skills", "deploy", "references", "steps.md"));
  }
  return { main, worktree, other };
}

function instruction(path: string): ToggleResource {
  const id = resourcePathId(path, "/");
  return {
    id,
    kind: "instruction",
    origin: "project",
    label: "AGENTS.md",
    description: id,
    editability: "editable",
  };
}

function skillResource(path: string, name: string): ToggleResource {
  const id = resourcePathId(path, "/");
  return {
    id,
    kind: "skill",
    origin: "project",
    label: name,
    description: id,
    editability: "editable",
  };
}

function overrides(entries: Readonly<Record<string, ToggleValue>>): ToggleOverrides {
  return new Map(
    Object.entries(entries).map(([path, value]) => [resourcePathId(path, "/"), value]),
  );
}

const header = (parentSession?: string): Pick<GuardContext, "sessionManager"> => ({
  sessionManager: {
    getHeader: () => (parentSession === undefined ? {} : { parentSession }),
  },
});

function guarded(stateStore: ToggleStateStore, cwd: string) {
  const handlers: Partial<ToggleHandlers> = {};
  const notifications: string[] = [];
  registerSkillToggle(
    {
      on: <K extends keyof ToggleHandlers>(name: K, handler: ToggleHandlers[K]) => {
        handlers[name] = handler;
      },
      registerCommand: () => undefined,
      getCommands: () => [],
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    },
    stateStore,
  );
  const context = (parentSession?: string): GuardContext => ({
    cwd,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getHeader: () => (parentSession === undefined ? {} : { parentSession }) },
  });
  const start = (skills: readonly Skill[], contextPaths: readonly string[]) =>
    handlers.before_agent_start?.(
      {
        systemPrompt: `base${formatSkillsForPrompt([...skills])}`,
        systemPromptOptions: {
          cwd,
          skills: [...skills],
          contextFiles: contextPaths.map((path) => ({ path, content: "rules" })),
        },
      },
      context(),
    );
  const call = (toolName: string, input: Record<string, unknown>, parentSession?: string) =>
    handlers.tool_call?.({ toolName, input }, context(parentSession));
  const type = (text: string, parentSession?: string) => {
    handlers.input?.({ text, source: "interactive" }, context(parentSession));
  };
  return { start, call, type, notifications };
}

function deploySkill(main: string): Skill {
  const path = join(main, ".agents/skills/deploy/SKILL.md");
  return {
    name: "deploy",
    description: "Deploy things",
    filePath: path,
    baseDir: dirname(path),
    sourceInfo: { path, source: "local", scope: "project", origin: "top-level" },
    disableModelInvocation: false,
  };
}

function storeWith(entries: Readonly<Record<string, ToggleValue>>): ToggleStateStore {
  return { load: () => ok(overrides(entries)), set: () => ok(overrides(entries)) };
}

const subagent = "01a137ea-c2a1-7378-87e6-ab5374db4a3b";

describe("skill-toggle guard", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("RepositoryLocator", () => {
    test("maps a main checkout and its linked worktree to one repository", () => {
      const { main, worktree, other } = repository();
      const locator = new RepositoryLocator();

      const inMain = locator.locate(join(main, "web", "AGENTS.md"));
      const inWorktree = locator.locate(join(worktree, "web", "AGENTS.md"));
      const inOther = locator.locate(join(other, "web", "AGENTS.md"));

      expect(inMain).toStrictEqual({
        repository: join(main, ".git"),
        path: "web/AGENTS.md",
        main: true,
      });
      expect(inWorktree).toStrictEqual({ ...inMain, main: false });
      expect(inOther?.repository).toBe(join(other, ".git"));
      expect(locator.locate("/AGENTS.md")).toBeUndefined();
      expect(locator.worktreeRoot(join(worktree, "web"))).toBe(worktree);
    });
  });

  describe("effectiveOverrides", () => {
    test("a worktree inherits the main checkout's override", () => {
      const { main, worktree } = repository();
      const worktreeAgents = instruction(join(worktree, "AGENTS.md"));

      const result = effectiveOverrides(overrides({ [join(main, "AGENTS.md")]: "disabled" }), [
        worktreeAgents,
      ]);

      expect(result.overrides.get(worktreeAgents.id)).toBe("disabled");
      expect(result.inherited).toStrictEqual(new Set([worktreeAgents.id]));
    });

    test("a resource's own override wins, and the main checkout wins over other worktrees", () => {
      const { main, worktree } = repository();
      const second = join(dirname(worktree), "worker4");
      mkdirSync(join(main, ".git", "worktrees", "worker4"), { recursive: true });
      write(join(main, ".git", "worktrees", "worker4", "commondir"), "../..\n");
      write(join(second, ".git"), `gitdir: ${join(main, ".git", "worktrees", "worker4")}\n`);
      const own = instruction(join(worktree, "AGENTS.md"));
      const inheriting = instruction(join(second, "AGENTS.md"));

      const result = effectiveOverrides(
        overrides({
          [join(worktree, "AGENTS.md")]: "enabled",
          [join(main, "AGENTS.md")]: "disabled",
        }),
        [own, inheriting],
      );

      expect(result.overrides.get(own.id)).toBe("enabled");
      expect(result.overrides.get(inheriting.id)).toBe("disabled");
    });
  });

  describe("disabledResourceMatcher", () => {
    test("blocks a disabled skill folder under any skills root, in any worktree", () => {
      const { main, worktree } = repository();
      const deploy = skillResource(join(main, ".agents/skills/deploy/SKILL.md"), "deploy");
      const matcher = disabledResourceMatcher([deploy], new Map(), new Set());

      for (const path of [
        join(main, ".agents/skills/deploy/SKILL.md"),
        join(main, ".agents/skills/deploy/references/steps.md"),
        join(worktree, ".agents/skills/deploy/SKILL.md"),
        join(worktree, ".claude/skills/deploy/SKILL.md"),
      ]) {
        expect(matcher.match(path)).toBe('skill "deploy"');
      }
      expect(matcher.match(join(main, ".agents/skills/deployment/SKILL.md"))).toBeUndefined();
      expect(matcher.match(join(main, "docs/deploy/SKILL.md"))).toBeUndefined();
      expect(matcher.match(join(main, ".agents/skills/README.md"))).toBeUndefined();
    });

    test("keeps a skill readable when enabled or invoked manually", () => {
      const { main } = repository();
      const path = join(main, ".agents/skills/deploy/SKILL.md");
      const deploy = skillResource(path, "deploy");

      expect(
        disabledResourceMatcher([deploy], overrides({ [path]: "enabled" }), new Set()).match(path),
      ).toBeUndefined();
      expect(
        disabledResourceMatcher([deploy], new Map(), new Set(["deploy"])).match(path),
      ).toBeUndefined();
    });

    test("blocks the same repository-relative instruction in every worktree only", () => {
      const { main, worktree, other } = repository();
      const rootAgents = instruction(join(main, "AGENTS.md"));
      const matcher = disabledResourceMatcher(
        [rootAgents],
        overrides({ [rootAgents.id]: "disabled" }),
        new Set(),
      );

      expect(matcher.match(join(main, "AGENTS.md"))).toBe("AGENTS.md");
      expect(matcher.match(join(worktree, "AGENTS.md"))).toBe("AGENTS.md");
      expect(matcher.match(join(main, "web/AGENTS.md"))).toBeUndefined();
      expect(matcher.match(join(worktree, "web/AGENTS.md"))).toBeUndefined();
      expect(matcher.match(join(other, "AGENTS.md"))).toBeUndefined();
      expect(matcher.match(join(main, "README.md"))).toBeUndefined();
    });

    test("honours nested instructions toggled from the menu and explicit worktree enables", () => {
      const { main, worktree } = repository();
      const nested = join(main, "web/AGENTS.md");
      const matcher = disabledResourceMatcher(
        [],
        overrides({
          [nested]: "disabled",
          [join(main, "AGENTS.md")]: "disabled",
          [join(worktree, "AGENTS.md")]: "enabled",
        }),
        new Set(),
      );

      expect(matcher.match(nested)).toBe("web/AGENTS.md");
      expect(matcher.match(join(worktree, "web/AGENTS.md"))).toBe("web/AGENTS.md");
      expect(matcher.match(join(worktree, "AGENTS.md"))).toBeUndefined();
    });

    test("treats every loaded resource as disabled when state cannot be loaded", () => {
      const { main } = repository();
      const rootAgents = instruction(join(main, "AGENTS.md"));
      const deploy = skillResource(join(main, ".agents/skills/deploy/SKILL.md"), "deploy");
      const matcher = disabledResourceMatcher([rootAgents, deploy], undefined, new Set());

      expect(matcher.match(rootAgents.id)).toBe("AGENTS.md");
      expect(matcher.match(deploy.id)).toBe('skill "deploy"');
      expect(matcher.match(join(main, "README.md"))).toBeUndefined();
    });

    test("resolves tool paths like Pi's file tools", () => {
      expect(toolPath("@web/AGENTS.md", "/repo")).toBe("/repo/web/AGENTS.md");
      expect(toolPath("./x/../AGENTS.md", "/repo")).toBe("/repo/AGENTS.md");
      expect(toolPath("/abs/AGENTS.md", "/repo")).toBe("/abs/AGENTS.md");
    });
  });

  describe("isSubagentSession", () => {
    test("recognises a subagent by its parent session id", () => {
      expect(isSubagentSession(header("01a137ea-c2a1-7378-87e6-ab5374db4a3b"))).toBe(true);
    });

    test("keeps main sessions, forks, and new sessions as main sessions", () => {
      expect(isSubagentSession(header())).toBe(false);
      expect(isSubagentSession(header(""))).toBe(false);
      expect(isSubagentSession(header("/home/dev/.pi/agent/sessions/x/2026_abc.jsonl"))).toBe(
        false,
      );
      expect(isSubagentSession({ sessionManager: { getHeader: () => null } })).toBe(false);
    });
  });

  describe("tool guard", () => {
    test("refuses read of disabled resources in every session", () => {
      const { main, worktree } = repository();
      const guard = guarded(storeWith({ [join(main, "AGENTS.md")]: "disabled" }), main);
      guard.start([deploySkill(main)], [join(main, "AGENTS.md")]);

      expect(guard.call("read", { path: "AGENTS.md" })).toMatchObject({ block: true });
      expect(guard.call("read", { path: ".worktrees/worker3/AGENTS.md" })).toMatchObject({
        block: true,
      });
      expect(
        guard.call("read", { path: join(worktree, ".agents/skills/deploy/SKILL.md") }),
      ).toMatchObject({
        block: true,
        reason: 'skill "deploy" is disabled in /skill-toggle, so it cannot be read.',
      });
      expect(guard.call("read", { path: "web/AGENTS.md" })).toBeUndefined();
      expect(guard.call("read", { path: "README.md" }, subagent)).toBeUndefined();
    });

    test("leaves edit, write, grep, find, and ls alone", () => {
      const { main } = repository();
      const guard = guarded(storeWith({ [join(main, "AGENTS.md")]: "disabled" }), main);
      guard.start([deploySkill(main)], [join(main, "AGENTS.md")]);

      for (const toolName of ["edit", "write", "grep", "find", "ls"]) {
        expect(guard.call(toolName, { path: "AGENTS.md" }, subagent)).toBeUndefined();
      }
    });

    test("refuses subagent bash commands that print a disabled resource, and nothing else", () => {
      const { main } = repository();
      const guard = guarded(storeWith({ [join(main, "AGENTS.md")]: "disabled" }), main);
      guard.start([deploySkill(main)], [join(main, "AGENTS.md")]);

      expect(
        guard.call(
          "bash",
          { command: "cat AGENTS.md web/AGENTS.md .agents/skills/deploy/SKILL.md" },
          subagent,
        ),
      ).toStrictEqual({
        block: true,
        reason:
          'This command reads AGENTS.md, skill "deploy", which the user disabled in /skill-toggle. Run it without those files.',
      });
      for (const command of [
        "cat web/AGENTS.md",
        "find . -name AGENTS.md",
        "git diff -- AGENTS.md",
        "sed -i 's/a/b/' .agents/skills/deploy/SKILL.md",
        "wc -l AGENTS.md",
      ]) {
        expect(guard.call("bash", { command }, subagent)).toBeUndefined();
      }
    });

    test("never checks bash in a main session", () => {
      const { main } = repository();
      const guard = guarded(storeWith({ [join(main, "AGENTS.md")]: "disabled" }), main);
      guard.start([deploySkill(main)], [join(main, "AGENTS.md")]);

      expect(guard.call("bash", { command: "cat AGENTS.md" })).toBeUndefined();
      expect(
        guard.call("bash", { command: "cat AGENTS.md" }, "/home/dev/.pi/agent/sessions/a.jsonl"),
      ).toBeUndefined();
    });

    test("keeps a manually invoked skill readable in its own session only", () => {
      const { main } = repository();
      const guard = guarded(storeWith({}), main);
      guard.start([deploySkill(main)], []);
      const read = { path: ".agents/skills/deploy/references/steps.md" };

      expect(guard.call("read", read)).toMatchObject({ block: true });
      guard.type("/skill:deploy ship it");
      expect(guard.call("read", read)).toBeUndefined();
      expect(guard.call("read", read, subagent)).toMatchObject({ block: true });
    });

    test("fails closed when state cannot be loaded", () => {
      const { main } = repository();
      const failing: ToggleStateStore = {
        load: () =>
          err(new ToggleStateUnavailable("load", "/state.json", "EACCES", new Error("EACCES"))),
        set: () => ok(new Map()),
      };
      const guard = guarded(failing, main);
      guard.start([deploySkill(main)], [join(main, "AGENTS.md")]);

      expect(guard.call("read", { path: "AGENTS.md" })).toMatchObject({ block: true });
      expect(guard.call("read", { path: "README.md" })).toBeUndefined();
      expect(guard.notifications).toHaveLength(1);
    });
  });

  describe("menu", () => {
    test("lists nested instructions Pi did not load and stores their toggles", async () => {
      const { main } = repository();
      const writes: (readonly [string, string])[] = [];
      const execCalls: (readonly string[])[] = [];
      let command: Parameters<ToggleRegistrationForTest["registerCommand"]>[1] | undefined;
      registerSkillToggle(
        {
          on: () => undefined,
          registerCommand: (_name, options) => {
            command = options;
          },
          getCommands: () => [],
          exec: async (_command, args) => {
            execCalls.push(args);
            return { stdout: "web/AGENTS.md\0README.md\0", stderr: "", code: 0, killed: false };
          },
        },
        {
          load: () => ok(new Map()),
          set: (id, value) => {
            writes.push([id, value]);
            return ok(new Map());
          },
        },
      );
      let rendered: string[] = [];
      const custom = async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
        initTheme();
        const component = await factory(testTui(), testTheme(), testKeybindings(), () => undefined);
        component.handleInput?.(" ");
        component.invalidate();
        rendered = component.render(120);
      };

      await command?.handler("", {
        cwd: join(main, "web"),
        mode: "tui",
        getSystemPromptOptions: () => ({ cwd: join(main, "web"), skills: [] }),
        ui: { notify: () => undefined, custom },
      });

      expect(execCalls[0]?.slice(0, 4)).toStrictEqual(["-C", main, "ls-files", "-z"]);
      expect(rendered.join("\n")).toContain("[project] web/AGENTS.md");
      expect(rendered.join("\n")).not.toContain("README.md");
      expect(writes).toStrictEqual([[join(main, "web", "AGENTS.md"), "disabled"]]);
    });
  });
});

type ToggleRegistrationForTest = Parameters<typeof registerSkillToggle>[0];
