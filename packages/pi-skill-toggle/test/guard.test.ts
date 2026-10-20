import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, Skill } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { testKeybindings, testTheme, testTui } from "../../../test-support/pi-tui";
import { disabledResourceMatcher, toolPath } from "../guard";
import { isSubagentSession, registerSkillToggle } from "../index";
import type { GuardContext, ToggleHandlers } from "../index";
import { RepositoryLocator } from "../repository";
import { resourcePathId } from "../resource-path";
import { emptyOverrides, ResourcePolicy } from "../resources";
import type { ToggleOverrides, ToggleResource, ToggleValue } from "../resources";
import { err, ok } from "../result";
import { ToggleStateFile, ToggleStateUnavailable } from "../state";
import type { ToggleStateStore } from "../state";

const temporaryDirectories: string[] = [];

/** Probe the temporary directory's file system, where these tests create their checkouts. */
function temporaryFileSystemIgnoresCase(): boolean {
  const directory = mkdtempSync(join(tmpdir(), "pi-skill-toggle-case-"));
  try {
    writeFileSync(join(directory, "probe"), "");
    return existsSync(join(directory, "PROBE"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const ignoresCase = temporaryFileSystemIgnoresCase();

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
  const directory = mkdtempSync(join(tmpdir(), "pi-skill-policy-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "state.json");
  writeFileSync(path, JSON.stringify({ version: 6, overrides: entries }));
  const loaded = new ToggleStateFile(path).load();
  if (loaded._tag === "err") {
    throw loaded.error;
  }
  return loaded.value;
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
  return { start, call, type, notifications, handlers };
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

function loadedState(store: ToggleStateStore) {
  const result = store.load();
  if (result._tag === "err") {
    throw result.error;
  }
  return result.value;
}

const subagent = "01a137ea-c2a1-7378-87e6-ab5374db4a3b";

/** Checkouts with disabled root and nested instructions plus a default-disabled project skill. */
function caseFixture() {
  const checkouts = repository();
  const { main } = checkouts;
  const rootAgents = instruction(join(main, "AGENTS.md"));
  const deploy = skillResource(join(main, ".agents/skills/deploy/SKILL.md"), "deploy");
  const matcher = disabledResourceMatcher(
    [rootAgents, deploy],
    overrides({ [rootAgents.id]: "disabled", [join(main, "web/AGENTS.md")]: "disabled" }),
    new Set(),
  );
  return { ...checkouts, matcher };
}

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

  describe("ResourcePolicy", () => {
    test("resolves the same resource policy in main and linked checkouts", () => {
      const { main, worktree } = repository();
      const policy = new ResourcePolicy(overrides({ [join(main, "AGENTS.md")]: "disabled" }));
      expect(policy.value(instruction(join(main, "AGENTS.md")))).toBe("disabled");
      expect(policy.value(instruction(join(worktree, "AGENTS.md")))).toBe("disabled");
    });

    test("main legacy policy wins even for a resource with an old worktree override", () => {
      const { main, worktree } = repository();
      const policy = new ResourcePolicy(
        overrides({
          [join(worktree, "AGENTS.md")]: "enabled",
          [join(main, "AGENTS.md")]: "disabled",
        }),
      );
      expect(policy.value(instruction(join(main, "AGENTS.md")))).toBe("disabled");
      expect(policy.value(instruction(join(worktree, "AGENTS.md")))).toBe("disabled");
    });
  });

  describe("disabledResourceMatcher", () => {
    test("blocks the actual disabled skill directory and its repository-equivalent copies", () => {
      const { main, worktree } = repository();
      const deploy = skillResource(join(main, ".agents/skills/deploy/SKILL.md"), "deploy");
      const matcher = disabledResourceMatcher([deploy], emptyOverrides(), new Set());

      for (const path of [
        join(main, ".agents/skills/deploy/SKILL.md"),
        join(main, ".agents/skills/deploy/references/steps.md"),
        join(worktree, ".agents/skills/deploy/SKILL.md"),
      ]) {
        expect(matcher.match(path)).toBe('skill "deploy"');
      }
      expect(matcher.match(join(main, ".agents/skills/deployment/SKILL.md"))).toBeUndefined();
      expect(matcher.match(join(main, "docs/deploy/SKILL.md"))).toBeUndefined();
      expect(matcher.match(join(worktree, ".claude/skills/deploy/SKILL.md"))).toBeUndefined();
      expect(matcher.match(join(main, ".agents/skills/README.md"))).toBeUndefined();
    });

    test("matches configured and nested loaded skill directories without same-name leakage", () => {
      const { main, worktree, other } = repository();
      for (const relative of [
        "custom-skills/deploy/SKILL.md",
        ".agents/skills/team/deploy/SKILL.md",
      ]) {
        const deploy = skillResource(join(main, relative), "release");
        const matcher = disabledResourceMatcher([deploy], emptyOverrides(), new Set());
        expect(matcher.match(deploy.id)).toBe('skill "release"');
        expect(matcher.match(join(dirname(deploy.id), "references/steps.md"))).toBe(
          'skill "release"',
        );
        expect(matcher.match(join(worktree, relative))).toBe('skill "release"');
        expect(matcher.match(join(other, relative))).toBeUndefined();
        expect(matcher.match(join(main, "unrelated/deploy/SKILL.md"))).toBeUndefined();
      }
    });

    test("explicitly loaded nested and standalone skills own their files independently of a disabled parent", () => {
      const { main, worktree } = repository();
      // Native recursion stops at the outer SKILL.md, but configured paths can load all three.
      const outer = skillResource(write(join(main, "custom/outer/SKILL.md")), "outer");
      const inner = skillResource(write(join(main, "custom/outer/inner/SKILL.md")), "inner");
      const helper = skillResource(write(join(main, "custom/outer/helper.md")), "helper");
      const state = overrides({
        [outer.id]: "disabled",
        [inner.id]: "enabled",
        [helper.id]: "enabled",
      });
      const manualInner = { ...inner, editability: "manual-only" } as const;
      const enabled = disabledResourceMatcher([outer, inner, helper], state, new Set());
      const manual = disabledResourceMatcher(
        [outer, manualInner, helper],
        state,
        new Set(["inner"]),
      );
      for (const matcher of [enabled, manual]) {
        for (const checkout of [main, worktree]) {
          expect(matcher.match(join(checkout, "custom/outer/SKILL.md"))).toBe('skill "outer"');
          expect(matcher.match(join(checkout, "custom/outer/references/notes.md"))).toBe(
            'skill "outer"',
          );
          expect(matcher.match(join(checkout, "custom/outer/inner/SKILL.md"))).toBeUndefined();
          expect(
            matcher.match(join(checkout, "custom/outer/inner/references/notes.md")),
          ).toBeUndefined();
          expect(matcher.match(join(checkout, "custom/outer/helper.md"))).toBeUndefined();
        }
      }
    });

    test("persisted disabled skills protect only their own directory when not loaded", () => {
      const { main, worktree, other } = repository();
      const path = join(main, "custom-skills/deploy/SKILL.md");
      const matcher = disabledResourceMatcher([], overrides({ [path]: "disabled" }), new Set());
      expect(matcher.match(join(dirname(path), "references/steps.md"))).toBe('skill "deploy"');
      expect(matcher.match(join(worktree, "custom-skills/deploy/SKILL.md"))).toBe('skill "deploy"');
      expect(matcher.match(join(other, "custom-skills/deploy/SKILL.md"))).toBeUndefined();
      expect(matcher.match(join(main, ".agents/skills/deploy/SKILL.md"))).toBeUndefined();
    });

    test("manual-only source policy wins over enabled state, except explicit local invocation", () => {
      const { main } = repository();
      const deploy = {
        ...skillResource(join(main, "custom/deploy/SKILL.md"), "release"),
        editability: "manual-only",
      } as const;
      const state = overrides({ [deploy.id]: "enabled" });
      expect(new ResourcePolicy(state).value(deploy)).toBe("disabled");
      expect(disabledResourceMatcher([deploy], state, new Set()).match(deploy.id)).toBe(
        'skill "release"',
      );
      expect(
        disabledResourceMatcher([deploy], state, new Set(["release"])).match(deploy.id),
      ).toBeUndefined();
    });

    test("keeps a skill readable when enabled or invoked manually", () => {
      const { main } = repository();
      const path = join(main, ".agents/skills/deploy/SKILL.md");
      const deploy = skillResource(path, "deploy");

      expect(
        disabledResourceMatcher([deploy], overrides({ [path]: "enabled" }), new Set()).match(path),
      ).toBeUndefined();
      expect(
        disabledResourceMatcher([deploy], emptyOverrides(), new Set(["deploy"])).match(path),
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

    test("honours nested instructions and resolves conflicting legacy worktree entries consistently", () => {
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
      expect(matcher.match(join(worktree, "AGENTS.md"))).toBe("AGENTS.md");
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

  describe("on-disk path identity", () => {
    test.runIf(ignoresCase)(
      "case-insensitive file systems: case variants of protected files are blocked",
      () => {
        const { main, worktree, other, matcher } = caseFixture();
        for (const checkout of [main, worktree]) {
          expect(matcher.match(join(checkout, "agents.md"))).toBe("AGENTS.md");
          expect(matcher.match(join(checkout, "Agents.Md"))).toBe("AGENTS.md");
          expect(matcher.match(join(checkout, "WEB/agents.md"))).toBe("web/AGENTS.md");
          expect(matcher.match(join(checkout, ".AGENTS/skills/DEPLOY/SKILL.md"))).toBe(
            'skill "deploy"',
          );
          expect(matcher.match(join(checkout, ".agents/skills/deploy/skill.md"))).toBe(
            'skill "deploy"',
          );
          expect(matcher.match(join(checkout, ".Agents/Skills/Deploy/References/STEPS.md"))).toBe(
            'skill "deploy"',
          );
        }
        // A missing leaf takes the on-disk casing of its nearest existing ancestor.
        expect(matcher.match(join(main, ".AGENTS/skills/DEPLOY/missing/notes.md"))).toBe(
          'skill "deploy"',
        );
        expect(matcher.match(join(main, "readme.md"))).toBeUndefined();
        expect(matcher.match(join(other, "agents.md"))).toBeUndefined();
        expect(matcher.match(join(other, ".AGENTS/skills/DEPLOY/SKILL.md"))).toBeUndefined();
      },
    );

    test.runIf(!ignoresCase)(
      "case-sensitive file systems: distinct differently-cased files stay readable",
      () => {
        const { main, worktree, matcher } = caseFixture();
        for (const checkout of [main, worktree]) {
          write(join(checkout, "agents.md"), "different file\n");
          write(join(checkout, "web/agents.md"), "different file\n");
          write(join(checkout, ".AGENTS/skills/DEPLOY/SKILL.md"), "different skill\n");
          expect(matcher.match(join(checkout, "agents.md"))).toBeUndefined();
          expect(matcher.match(join(checkout, "web/agents.md"))).toBeUndefined();
          expect(matcher.match(join(checkout, ".AGENTS/skills/DEPLOY/SKILL.md"))).toBeUndefined();
          expect(matcher.match(join(checkout, "AGENTS.md"))).toBe("AGENTS.md");
        }
        // Missing differently-cased paths cannot name a protected file either.
        expect(matcher.match(join(main, "Agents.Md"))).toBeUndefined();
      },
    );

    test("symlinks to protected files and skill directories are blocked", () => {
      const { main, other, matcher } = caseFixture();
      const fileLink = join(other, "linked-agents.md");
      const skillLink = join(other, "linked-skill");
      symlinkSync(join(main, "AGENTS.md"), fileLink);
      symlinkSync(join(main, ".agents/skills/deploy"), skillLink);
      expect(matcher.match(fileLink)).toBe("AGENTS.md");
      expect(matcher.match(join(skillLink, "SKILL.md"))).toBe('skill "deploy"');
      expect(matcher.match(join(skillLink, "references/steps.md"))).toBe('skill "deploy"');
      symlinkSync(join(main, "README.md"), join(other, "linked-readme.md"));
      expect(matcher.match(join(other, "linked-readme.md"))).toBeUndefined();
    });

    test.runIf(ignoresCase)("read and subagent bash refuse case variants", () => {
      const { main } = repository();
      const guard = guarded(storeWith({ [join(main, "AGENTS.md")]: "disabled" }), main);
      guard.start([deploySkill(main)], [join(main, "AGENTS.md")]);
      expect(guard.call("read", { path: "agents.md" })).toMatchObject({
        block: true,
        reason: "AGENTS.md is disabled in /skill-toggle, so it cannot be read.",
      });
      expect(
        guard.call("bash", { command: "cat .AGENTS/skills/x/../deploy/SKILL.md" }, subagent),
      ).toMatchObject({ block: true });
      expect(
        guard.call("bash", { command: "cat .AGENTS/skills/DEPLOY/SKILL.md" }, subagent),
      ).toMatchObject({ block: true });
      expect(guard.call("read", { path: "readme.md" })).toBeUndefined();
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

    test.each(["AGENTS.MD", "CLAUDE.MD", "custom-context.txt"])(
      "hides and blocks a disabled loaded instruction by identity: %s",
      (filename) => {
        const { main, worktree } = repository();
        const path = resourcePathId(write(join(main, filename)), "/");
        const statePath = join(dirname(main), "instruction-state.json");
        const store = new ToggleStateFile(statePath);
        const saved = store.set(path, "disabled");
        expect(saved._tag).toBe("ok");
        const guard = guarded(store, main);
        const systemPromptOptions = {
          cwd: main,
          sections: {},
          skills: [],
          contextFiles: [{ path, content: "rules" }],
        };
        guard.handlers.before_agent_start?.(
          { systemPrompt: "base", systemPromptOptions },
          { ui: { notify: () => undefined } },
        );
        expect(systemPromptOptions.contextFiles).toStrictEqual([]);
        expect(guard.call("read", { path })).toMatchObject({ block: true });
        expect(guard.call("read", { path: join(worktree, filename) })).toMatchObject({
          block: true,
        });
      },
    );

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
        set: () => ok(emptyOverrides()),
      };
      const guard = guarded(failing, main);
      guard.start([deploySkill(main)], [join(main, "AGENTS.md")]);

      expect(guard.call("read", { path: "AGENTS.md" })).toMatchObject({ block: true });
      expect(guard.call("read", { path: "README.md" })).toBeUndefined();
      expect(guard.notifications).toHaveLength(1);
    });
  });

  describe("menu", () => {
    test("real saves refresh shared menu policy across repeated toggles, prompt and reads", async () => {
      const { main, worktree } = repository();
      const statePath = join(dirname(main), "roundtrip.json");
      const mainSkill = deploySkill(main);
      const childSkill = deploySkill(worktree);
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 6,
          overrides: {
            [mainSkill.filePath]: "enabled",
            [childSkill.filePath]: "enabled",
          },
        }),
      );
      const store = new ToggleStateFile(statePath);
      let command: Parameters<ToggleRegistrationForTest["registerCommand"]>[1] | undefined;
      registerSkillToggle(
        {
          on: () => undefined,
          registerCommand: (_name, options) => {
            command = options;
          },
          getCommands: () => [],
          exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
        },
        store,
      );
      await command?.handler("", {
        cwd: worktree,
        mode: "tui",
        getSystemPromptOptions: () => ({ cwd: worktree, skills: [childSkill] }),
        ui: {
          notify: () => undefined,
          custom: async (factory) => {
            initTheme();
            let closed = false;
            const component = await factory(testTui(), testTheme(), testKeybindings(), () => {
              closed = true;
            });
            for (const { expected, other, expectedPrompt, read } of [
              {
                expected: "disabled",
                other: "enabled",
                expectedPrompt: { systemPrompt: "base" },
                read: true,
              },
              { expected: "enabled", other: "disabled", expectedPrompt: undefined, read: false },
              {
                expected: "disabled",
                other: "enabled",
                expectedPrompt: { systemPrompt: "base" },
                read: true,
              },
              { expected: "enabled", other: "disabled", expectedPrompt: undefined, read: false },
            ]) {
              component.handleInput?.(" ");
              const saved = loadedState(store);
              expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ version: 7 });
              expect(saved.files.size).toBe(0);
              for (const [checkout, skill] of [
                [main, mainSkill],
                [worktree, childSkill],
              ] as const) {
                const policy = new ResourcePolicy(saved);
                expect(policy.value(skillResource(skill.filePath, "deploy"))).toBe(expected);
                const guard = guarded(store, checkout);
                const prompt = guard.start([skill], []);
                expect(prompt).toStrictEqual(expectedPrompt);
                expect(Boolean(guard.call("read", { path: skill.filePath }))).toBe(read);
              }
              component.invalidate();
              const rendered = component.render(120).join("\n");
              expect(rendered).toContain(expected);
              expect(rendered).not.toContain(other);
              for (const width of [1, 8, 20, 40, 60, 120]) {
                expect(() => component.render(width)).not.toThrow();
              }
            }
            component.handleInput?.("d");
            component.handleInput?.("\u001b");
            expect(closed).toBe(false);
            component.handleInput?.("\u001b");
            expect(closed).toBe(true);
          },
        },
      });
    });

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
          load: () => ok(emptyOverrides()),
          set: (id, value) => {
            writes.push([id, value]);
            return ok(emptyOverrides());
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
      expect(rendered.join("\n")).toContain("[project instruction] web/AGENTS.md");
      expect(rendered.join("\n")).not.toContain("README.md");
      expect(writes).toStrictEqual([[join(main, "web", "AGENTS.md"), "disabled"]]);
    });
  });
});

type ToggleRegistrationForTest = Parameters<typeof registerSkillToggle>[0];
