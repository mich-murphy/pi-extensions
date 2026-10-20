import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatSkillsForPrompt, getAgentDir, initTheme } from "@earendil-works/pi-coding-agent";
import type {
  BuildSystemPromptOptions,
  ExtensionCommandContext,
  ExtensionUIContext,
  Skill,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import { testTui, testTheme, testKeybindings } from "../../../test-support/pi-tui";
import skillToggle, { registerSkillToggle } from "../index";
import type { ToggleRegistration, ToggleHandlers } from "../index";
import type { PromptFilterEvent } from "../prompt-filter";
import { resourcePathId } from "../resource-path";
import type { ToggleOverrides, ToggleValue } from "../resources";
import { err, ok } from "../result";
import { ToggleStateUnavailable } from "../state";
import type { ToggleStateResult, ToggleStateStore } from "../state";

const cwd = "/work/project";
const skillPath = join(getAgentDir(), "skills/research/SKILL.md");
const research: Skill = {
  name: "research",
  description: "Research primary sources",
  filePath: skillPath,
  baseDir: dirname(skillPath),
  sourceInfo: { path: skillPath, source: "local", scope: "user", origin: "top-level" },
  disableModelInvocation: false,
};
const projectPath = "/work/project/.agents/skills/deploy/SKILL.md";
const deploy: Skill = {
  ...research,
  name: "deploy",
  filePath: projectPath,
  baseDir: dirname(projectPath),
  sourceInfo: { path: projectPath, source: "local", scope: "project", origin: "top-level" },
};
const options: BuildSystemPromptOptions = { cwd, skills: [research] };

const temporaryDirectories: string[] = [];

type CommandOptions = Parameters<ToggleRegistration["registerCommand"]>[1];
type DialogFactory = Parameters<ExtensionUIContext["custom"]>[0];

async function selectFirstDialogItem(factory: DialogFactory, width = 120): Promise<string[]> {
  initTheme();
  const component = await factory(testTui(), testTheme(), testKeybindings(), () => undefined);
  component.handleInput?.(" ");
  component.invalidate();
  return component.render(width);
}

async function driveDialog(
  factory: DialogFactory,
  keys: readonly string[],
  width = 120,
): Promise<{ readonly closed: boolean; readonly rendered: string[] }> {
  initTheme();
  let closed = false;
  const component = await factory(testTui(), testTheme(), testKeybindings(), () => {
    closed = true;
  });
  for (const key of keys) {
    component.handleInput?.(key);
  }
  return { closed, rendered: component.render(width) };
}

const ESCAPE = "\u001b";
const DOWN = "\u001b[B";
const SGR = new RegExp(String.raw`${ESCAPE}\[[0-9;]*m`, "gu");

/** Rendered lines without color codes, as the user reads them. */
function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replaceAll(SGR, ""));
}

/** Lines describing menu keys: every key hint mentions Esc. */
function hintLines(lines: readonly string[]): string[] {
  return plain(lines).filter((line) => /\bEsc\b/u.test(line));
}

function overrides(entries: Readonly<Record<string, ToggleValue>> = {}): ToggleOverrides {
  return {
    files: new Map(
      Object.entries(entries).map(([path, value]) => [resourcePathId(path, cwd), value]),
    ),
    repositories: new Map(),
  };
}

function storeWith(entries: Readonly<Record<string, ToggleValue>> = {}): ToggleStateStore & {
  readonly writes: (readonly [string, ToggleValue | "default"])[];
} {
  const writes: (readonly [string, ToggleValue | "default"])[] = [];
  return {
    writes,
    load: () => ok(overrides(entries)),
    set: (id, value) => {
      writes.push([id, value]);
      return ok(overrides(entries));
    },
  };
}

function failure(operation: "load" | "update"): ToggleStateResult {
  return err(
    new ToggleStateUnavailable(
      operation,
      "/state.json",
      "EACCES",
      new Error("EACCES: permission denied"),
    ),
  );
}

function harness(store: ToggleStateStore, projectDirectory = cwd) {
  const handlers: Partial<ToggleHandlers> = {};
  const commands = new Map<string, CommandOptions>();
  const notifications: string[] = [];
  const piMock = {
    on<K extends keyof ToggleHandlers>(name: K, handler: ToggleHandlers[K]) {
      handlers[name] = handler;
    },
    registerCommand(name: string, command: CommandOptions) {
      commands.set(name, command);
    },
    getCommands: () => [],
    exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
  };
  let projectTrusted = true;
  const ctx = {
    cwd: projectDirectory,
    model: undefined,
    sessionManager: {
      buildSessionProjection: () => ({ messages: [], entries: [] }),
      getSessionId: () => "session",
    },
    isProjectTrusted: () => projectTrusted,
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  };
  registerSkillToggle(piMock, store);
  const emit = async (
    ...args: ["resources_discover", unknown] | ["before_agent_start", PromptFilterEvent]
  ): Promise<unknown> => {
    if (args[0] === "resources_discover") {
      return handlers.resources_discover?.(args[1], ctx);
    }
    return handlers.before_agent_start?.(args[1], ctx);
  };
  const runCommand = async (
    args: string,
    commandOptions: {
      readonly mode?: ExtensionCommandContext["mode"];
      readonly promptOptions?: BuildSystemPromptOptions;
      readonly custom?: (factory: DialogFactory) => Promise<unknown>;
    } = {},
  ): Promise<void> => {
    const command = commands.get("skill-toggle");
    if (!command) {
      throw new Error("skill-toggle command was not registered");
    }
    const commandContext = {
      cwd: projectDirectory,
      mode: commandOptions.mode ?? "tui",
      getSystemPromptOptions: () => commandOptions.promptOptions ?? options,
      ui: {
        notify: (message: string) => notifications.push(message),
        custom: commandOptions.custom ?? (async () => undefined),
      },
    };
    await command.handler(args, commandContext);
  };
  return {
    commands,
    emit,
    notifications,
    runCommand,
    distrustProject: () => {
      projectTrusted = false;
    },
  };
}

function projectWithSkill(): { readonly directory: string; readonly skill: Skill } {
  const directory = mkdtempSync(join(tmpdir(), "pi-skill-toggle-lifecycle-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".claude", "skills", "design", "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "---\nname: design\ndescription: design description\n---\n");
  const skill: Skill = {
    ...research,
    name: "design",
    filePath: path,
    baseDir: dirname(path),
    sourceInfo: { path, source: "extension:index", scope: "temporary", origin: "top-level" },
  };
  return { directory, skill };
}

describe("extension lifecycle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the package entry point applies overrides persisted in the agent directory", async () => {
    const agentDirectory = mkdtempSync(join(tmpdir(), "pi-skill-toggle-agent-"));
    temporaryDirectories.push(agentDirectory);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
    const path = join(agentDirectory, "skills", "research", "SKILL.md");
    const skill: Skill = {
      ...research,
      filePath: path,
      baseDir: dirname(path),
      sourceInfo: { ...research.sourceInfo, path },
    };
    writeFileSync(
      join(agentDirectory, "pi-skill-toggle.json"),
      JSON.stringify({ version: 6, overrides: { [path]: "disabled" } }),
    );
    const handlers: Partial<ToggleHandlers> = {};
    const piMock = {
      registerCommand: () => undefined,
      on: <K extends keyof ToggleHandlers>(name: K, handler: ToggleHandlers[K]) => {
        handlers[name] = handler;
      },
      getCommands: () => [],
      exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    };
    skillToggle(piMock);

    const result = handlers.before_agent_start?.(
      {
        systemPrompt: `base${formatSkillsForPrompt([skill])}`,
        systemPromptOptions: { cwd, skills: [skill] },
      },
      {
        ui: { notify: () => undefined },
        model: undefined,
        sessionManager: {
          buildSessionProjection: () => ({ messages: [], entries: [] }),
          getSessionId: () => "session",
        },
      },
    );

    expect(result).toStrictEqual({ systemPrompt: "base" });
  });

  test("rejects command arguments and non-TUI sessions", async () => {
    const testHarness = harness(storeWith());

    await testHarness.runCommand("unexpected");
    await testHarness.runCommand("", { mode: "rpc" });

    expect(testHarness.notifications).toStrictEqual([
      "Usage: /skill-toggle",
      "/skill-toggle requires TUI mode",
    ]);
  });

  test("reports when the command has no user-managed resources", async () => {
    const testHarness = harness(storeWith());

    await testHarness.runCommand("", { promptOptions: { cwd, skills: [] } });

    expect(testHarness.notifications).toStrictEqual([
      "No user-managed instructions or skills are loaded",
    ]);
  });

  test("does not open the dialog when command state loading fails", async () => {
    let opened = false;
    const testHarness = harness({ load: () => failure("load"), set: () => failure("update") });

    await testHarness.runCommand("", {
      custom: async () => {
        opened = true;
      },
    });

    expect(opened).toBe(false);
    expect(testHarness.notifications).toStrictEqual([
      "Could not load Pi skill-toggle state at /state.json: permission was denied. Check the permissions of the file and its folder.\nThe prompt was left unchanged. Recognized reads of loaded instructions and skills are blocked until it is fixed.",
    ]);
  });

  test("persists a toggle away from the default as an override", async () => {
    const global = storeWith();
    const project = storeWith();

    await harness(global).runCommand("", { custom: selectFirstDialogItem });
    await harness(project).runCommand("", {
      promptOptions: { cwd, skills: [deploy] },
      custom: selectFirstDialogItem,
    });

    expect(global.writes).toStrictEqual([[skillPath, "disabled"]]);
    expect(project.writes).toStrictEqual([[projectPath, "enabled"]]);
  });

  test("clears the override when a toggle returns to the default", async () => {
    const store = storeWith({ [skillPath]: "disabled" });

    await harness(store).runCommand("", { custom: selectFirstDialogItem });

    expect(store.writes).toStrictEqual([[skillPath, "default"]]);
  });

  test("restores the row and reports once when persistence fails", async () => {
    let rendered: string[] = [];
    const testHarness = harness({
      load: () => ok(overrides({ [skillPath]: "disabled" })),
      set: () => failure("update"),
    });

    await testHarness.runCommand("", {
      custom: async (factory) => {
        rendered = await selectFirstDialogItem(factory);
      },
    });

    expect(rendered.join("\n")).toContain("disabled");
    expect(rendered.join("\n")).not.toContain("enabled");
    expect(testHarness.notifications).toStrictEqual([
      "Could not update Pi skill-toggle state at /state.json: permission was denied. Check the permissions of the file and its folder.\nThe toggle was not saved.",
    ]);
  });

  test("shows manual-only skills as read-only rows even with a stale enabled override", async () => {
    const store = storeWith({ [skillPath]: "enabled" });
    let rendered: string[] = [];

    await harness(store).runCommand("", {
      promptOptions: { cwd, skills: [{ ...research, disableModelInvocation: true }] },
      custom: async (factory) => {
        rendered = await selectFirstDialogItem(factory, 60);
      },
    });

    expect(store.writes).toStrictEqual([]);
    expect(rendered.find((line) => line.includes("[global skill] research"))).toContain(
      "manual only",
    );
    expect(rendered.join("\n")).toContain("Manual only (read-only)");
  });

  test("source-authored manual-only policy wins over persisted enables in the prompt", async () => {
    const manual = { ...research, disableModelInvocation: true };
    const testHarness = harness(storeWith({ [skillPath]: "enabled" }));
    const systemPromptOptions = { cwd, sections: {}, skills: [manual] };
    await testHarness.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions });
    expect(systemPromptOptions.skills).toStrictEqual([]);
  });

  test("contributes trusted project skills and hides them until enabled", async () => {
    const project = projectWithSkill();
    const event = {
      systemPrompt: `base${formatSkillsForPrompt([project.skill])}`,
      systemPromptOptions: { cwd: project.directory, skills: [project.skill] },
    };
    const hidden = harness(storeWith(), project.directory);
    const enabled = harness(storeWith({ [project.skill.filePath]: "enabled" }), project.directory);

    await expect(hidden.emit("resources_discover", {})).resolves.toStrictEqual({
      skillPaths: [project.skill.filePath],
    });
    await expect(hidden.emit("before_agent_start", event)).resolves.toStrictEqual({
      systemPrompt: "base",
    });
    await enabled.emit("resources_discover", {});
    await expect(enabled.emit("before_agent_start", event)).resolves.toBeUndefined();
  });

  test("contributes nothing from an untrusted project and leaves its temporary skills alone", async () => {
    const project = projectWithSkill();
    const testHarness = harness(storeWith(), project.directory);
    testHarness.distrustProject();

    await expect(testHarness.emit("resources_discover", {})).resolves.toBeUndefined();
    await expect(
      testHarness.emit("before_agent_start", {
        systemPrompt: `base${formatSkillsForPrompt([project.skill])}`,
        systemPromptOptions: { cwd: project.directory, skills: [project.skill] },
      }),
    ).resolves.toBeUndefined();
  });

  test("applies persisted overrides before the model starts", async () => {
    const testHarness = harness(storeWith({ [skillPath]: "disabled" }));

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: `base${formatSkillsForPrompt([research])}`,
      systemPromptOptions: options,
    });

    expect(result).toStrictEqual({ systemPrompt: "base" });
  });

  test("filters the mutable options of Pi 0.86 without forcing a replacement prompt", async () => {
    const testHarness = harness(storeWith({ [skillPath]: "disabled" }));
    const systemPromptOptions = { cwd, sections: {}, contextFiles: [], skills: [research, deploy] };

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: "rendered by Pi",
      systemPromptOptions,
    });

    expect(result).toBeUndefined();
    expect(systemPromptOptions.skills).toStrictEqual([]);
  });

  test("leaves the prompt alone when nothing is hidden", async () => {
    const testHarness = harness(storeWith({ [projectPath]: "enabled" }));

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: "a prompt another extension rewrote",
      systemPromptOptions: { cwd, skills: [research, deploy] },
    });

    expect(result).toBeUndefined();
    expect(testHarness.notifications).toStrictEqual([]);
  });

  test("does not apply stale state to package or other excluded resources", async () => {
    const packagePath = "/packages/research/SKILL.md";
    const packageSkill: Skill = {
      ...research,
      filePath: packagePath,
      baseDir: "/packages/research",
      sourceInfo: { path: packagePath, source: "npm:example", scope: "user", origin: "package" },
    };
    const testHarness = harness(storeWith({ [packagePath]: "disabled" }));

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: `base${formatSkillsForPrompt([packageSkill])}`,
      systemPromptOptions: { cwd, skills: [packageSkill] },
    });

    expect(result).toBeUndefined();
  });

  test("reports prompt sections that cannot be updated and deduplicates the warning", async () => {
    const testHarness = harness(storeWith({ [skillPath]: "disabled" }));
    const event = { systemPrompt: "base", systemPromptOptions: options };

    await expect(testHarness.emit("before_agent_start", event)).resolves.toBeUndefined();
    await expect(testHarness.emit("before_agent_start", event)).resolves.toBeUndefined();
    expect(testHarness.notifications).toStrictEqual([
      "Skill toggle could not update the skills prompt section. Another extension may have rewritten it.",
    ]);
  });

  test("propagates a store defect instead of reporting it as a state failure", async () => {
    const testHarness = harness({
      load: () => {
        throw new TypeError("store bug");
      },
      set: () => failure("update"),
    });
    const event = {
      systemPrompt: `base${formatSkillsForPrompt([research])}`,
      systemPromptOptions: options,
    };

    await expect(testHarness.emit("before_agent_start", event)).rejects.toThrow(TypeError);
    expect(testHarness.notifications).toStrictEqual([]);
  });

  test("leaves the prompt unchanged, reports a state failure once, and again after it recovers", async () => {
    let result: ReturnType<ToggleStateStore["load"]> = failure("load");
    const testHarness = harness({ load: () => result, set: () => failure("update") });
    const event = {
      systemPrompt: `base${formatSkillsForPrompt([research])}`,
      systemPromptOptions: options,
    };

    await expect(testHarness.emit("before_agent_start", event)).resolves.toBeUndefined();
    await expect(testHarness.emit("before_agent_start", event)).resolves.toBeUndefined();
    expect(testHarness.notifications).toHaveLength(1);

    result = ok(overrides());
    await testHarness.emit("before_agent_start", event);
    result = failure("load");
    await testHarness.emit("before_agent_start", event);
    expect(testHarness.notifications).toHaveLength(2);
    expect(testHarness.notifications[1]).toContain("prompt was left unchanged");
  });

  test("Esc with search text clears the search and keeps the menu open", async () => {
    const store = storeWith();
    let result = { closed: true, rendered: [] as string[] };

    await harness(store).runCommand("", {
      custom: async (factory) => {
        result = await driveDialog(factory, ["z", "z", "z", ESCAPE]);
      },
    });

    expect(result.closed).toBe(false);
    expect(result.rendered.join("\n")).not.toContain("No matching");
    expect(result.rendered.join("\n")).not.toContain("zzz");
    expect(result.rendered.find((line) => line.includes("[global skill] research"))).toContain(
      "enabled",
    );
    expect(store.writes).toStrictEqual([]);
  });

  test("the menu shows one accurate key hint and keeps other list hints", async () => {
    const many = Array.from({ length: 25 }, (_, index): Skill => {
      const path = join(getAgentDir(), `skills/hint-${String(index).padStart(2, "0")}/SKILL.md`);
      return {
        ...research,
        name: `hint-${index}`,
        filePath: path,
        baseDir: dirname(path),
        sourceInfo: { ...research.sourceInfo, path },
      };
    });
    const screens: (readonly [string, string[]])[] = [];

    for (const [name, keys] of [
      ["open", []],
      ["search", ["h"]],
      ["empty", ["z", "z", "z"]],
      ["cleared", ["z", "z", "z", ESCAPE]],
    ] as const) {
      await harness(storeWith()).runCommand("", {
        promptOptions: { cwd, skills: many },
        custom: async (factory) => {
          initTheme();
          const component = await factory(testTui(), testTheme(), testKeybindings(), () => {
            throw new Error("menu closed unexpectedly");
          });
          for (const key of keys) {
            component.handleInput?.(key);
          }
          screens.push([name, component.render(120)]);
          for (const width of [1, 8, 20, 40, 60, 120]) {
            const lines = component.render(width);
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
          }
        },
      });
    }

    for (const [name, rendered] of screens) {
      const text = plain(rendered).join("\n");
      expect({ name, hints: hintLines(rendered) }).toStrictEqual({
        name,
        hints: [
          "  Enter toggle · Esc clear search, then close · type to search · Space toggle (empty search)",
        ],
      });
      expect({ name, stale: text.includes("Esc to cancel") }).toStrictEqual({ name, stale: false });
      expect({ name, stale: text.includes("Enter/Space to change") }).toStrictEqual({
        name,
        stale: false,
      });
    }
    const byName = new Map(screens.map(([name, rendered]) => [name, plain(rendered).join("\n")]));
    // SettingsList's own scroll and empty-result hints pass through unchanged.
    expect(byName.get("open")).toContain("  (1/25)");
    expect(byName.get("cleared")).toContain("  (1/25)");
    expect(byName.get("empty")).toContain("  No matching settings");
    expect(byName.get("open")).not.toContain("No matching settings");
  });

  test("Esc with an empty search closes the menu without writing", async () => {
    const store = storeWith();
    const closed: boolean[] = [];

    await harness(store).runCommand("", {
      custom: async (factory) => {
        const dialog = await driveDialog(factory, [ESCAPE]);
        closed.push(dialog.closed);
      },
    });
    await harness(store).runCommand("", {
      custom: async (factory) => {
        const dialog = await driveDialog(factory, ["z", "z", "z", ESCAPE, ESCAPE]);
        closed.push(dialog.closed);
      },
    });

    expect(closed).toStrictEqual([true, true]);
    expect(store.writes).toStrictEqual([]);
  });

  test("a failed save restores every row to the persisted policy", async () => {
    let rendered: string[] = [];
    const testHarness = harness({
      load: () => ok(overrides({ [skillPath]: "disabled", [projectPath]: "enabled" })),
      set: () => failure("update"),
    });

    await testHarness.runCommand("", {
      promptOptions: { cwd, skills: [research, deploy] },
      custom: async (factory) => {
        ({ rendered } = await driveDialog(factory, [" ", DOWN, " "]));
      },
    });

    expect(rendered.find((line) => line.includes("[global skill] research"))).toContain("disabled");
    expect(rendered.find((line) => line.includes("[project skill] deploy"))).toContain("enabled");
    expect(testHarness.notifications).toHaveLength(1);
  });

  test("menu scope follows the persistence rule, shown once per row", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-skill-toggle-home-"));
    temporaryDirectories.push(home);
    mkdirSync(join(home, ".git"));
    vi.stubEnv("HOME", home);
    const homePath = join(home, ".agents", "skills", "notes", "SKILL.md");
    const homeSkill: Skill = {
      ...research,
      name: "notes",
      filePath: homePath,
      baseDir: dirname(homePath),
      sourceInfo: { path: homePath, source: "local", scope: "project", origin: "top-level" },
    };
    const repo = projectWithSkill();
    mkdirSync(join(repo.directory, ".git"));
    const repoSkill: Skill = {
      ...repo.skill,
      sourceInfo: { ...repo.skill.sourceInfo, scope: "project" },
    };
    const descriptions: string[] = [];

    for (const skill of [homeSkill, repoSkill]) {
      await harness(storeWith()).runCommand("", {
        promptOptions: { cwd, skills: [skill] },
        custom: async (factory) => {
          const dialog = await driveDialog(factory, []);
          descriptions.push(dialog.rendered.join("\n"));
        },
      });
    }

    const [homeText = "", repoText = ""] = descriptions;
    expect(homeText).toContain("Project skill · this path only");
    expect(homeText).not.toContain("repository-wide");
    expect(repoText).toContain("Project skill · repository-wide (all worktrees)");
    expect(repoText.split("repository-wide")).toHaveLength(2);
  });
});
