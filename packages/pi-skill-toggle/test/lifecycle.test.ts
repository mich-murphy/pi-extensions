import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  formatSkillsForPrompt,
  getAgentDir,
  initTheme,
  type KeybindingsManager,
  type RegisteredCommand,
  type Skill,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import skillToggle, { registerSkillToggle } from "../index";
import { resourcePathId } from "../resource-path";
import type { ToggleOverrides, ToggleValue } from "../resources";
import { ToggleStateError, type ToggleStateStore } from "../state";

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
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type TestHandler = (event: unknown, context: unknown) => unknown | Promise<unknown>;
type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;
type DialogFactory = Parameters<ExtensionUIContext["custom"]>[0];

async function selectFirstDialogItem(factory: DialogFactory): Promise<string[]> {
  initTheme();
  const fakeTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  // SAFETY: The dialog uses only requestRender() on TUI and fg()/bold() on Theme; keybindings are not read.
  const component = await factory(
    { requestRender: () => undefined } as unknown as TUI,
    fakeTheme as unknown as Theme,
    {} as KeybindingsManager,
    () => undefined,
  );
  component.handleInput?.(" ");
  component.invalidate();
  return component.render(120);
}

function overrides(entries: Record<string, ToggleValue> = {}): ToggleOverrides {
  return new Map(
    Object.entries(entries).map(([path, value]) => [resourcePathId(path, cwd), value]),
  );
}

function storeWith(entries: Record<string, ToggleValue> = {}): ToggleStateStore & {
  readonly writes: Array<readonly [string, ToggleValue | "default"]>;
} {
  const writes: Array<readonly [string, ToggleValue | "default"]> = [];
  return {
    writes,
    load: () => ({ _tag: "ok", value: overrides(entries) }),
    set: (id, value) => {
      writes.push([id, value]);
      return { _tag: "ok", value: overrides(entries) };
    },
  };
}

function failure(operation: "load" | "update"): { _tag: "err"; error: ToggleStateError } {
  return { _tag: "err", error: new ToggleStateError(operation, "/state.json", new Error("boom")) };
}

function harness(store: ToggleStateStore, projectDirectory = cwd) {
  const handlers = new Map<string, TestHandler[]>();
  const commands = new Map<string, CommandOptions>();
  const notifications: string[] = [];
  const piMock = {
    on(name: string, handler: TestHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: CommandOptions) {
      commands.set(name, command);
    },
  };
  let projectTrusted = true;
  const ctx = {
    cwd: projectDirectory,
    isProjectTrusted: () => projectTrusted,
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  };
  // SAFETY: Registration uses only on() and registerCommand(). The test double captures both and supplies separate event and command contexts.
  registerSkillToggle(piMock as unknown as ExtensionAPI, store);
  const emit = (name: string, event: unknown): Promise<unknown> =>
    (handlers.get(name) ?? []).reduce<Promise<unknown>>(
      (previous, handler) => previous.then(() => handler(event, ctx)),
      Promise.resolve(undefined),
    );
  const runCommand = async (
    args: string,
    commandOptions: {
      readonly mode?: ExtensionCommandContext["mode"];
      readonly promptOptions?: BuildSystemPromptOptions;
      readonly custom?: (factory: DialogFactory) => Promise<unknown>;
    } = {},
  ): Promise<void> => {
    const command = commands.get("skill-toggle");
    if (!command) throw new Error("skill-toggle command was not registered");
    const commandContext = {
      cwd: projectDirectory,
      mode: commandOptions.mode ?? "tui",
      getSystemPromptOptions: () => commandOptions.promptOptions ?? options,
      ui: {
        notify: (message: string) => notifications.push(message),
        custom: commandOptions.custom ?? (async () => undefined),
      },
    };
    // SAFETY: The command paths under test use only mode, getSystemPromptOptions(), ui.notify(), and ui.custom().
    await command.handler(args, commandContext as unknown as ExtensionCommandContext);
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
  test("the package entry point registers its command and event handlers", () => {
    const registrations: string[] = [];
    const piMock = {
      registerCommand: (name: string) => registrations.push(`command:${name}`),
      on: (name: string) => registrations.push(`event:${name}`),
    };
    // SAFETY: The entry point registers only commands and event handlers, which this test double captures.
    skillToggle(piMock as unknown as ExtensionAPI);
    expect(registrations).toEqual([
      "command:skill-toggle",
      "event:resources_discover",
      "event:before_agent_start",
    ]);
  });

  test("rejects command arguments and non-TUI sessions", async () => {
    const testHarness = harness(storeWith());

    await testHarness.runCommand("unexpected");
    await testHarness.runCommand("", { mode: "rpc" });

    expect(testHarness.notifications).toEqual([
      "Usage: /skill-toggle",
      "/skill-toggle requires TUI mode",
    ]);
  });

  test("reports when the command has no user-managed resources", async () => {
    const testHarness = harness(storeWith());

    await testHarness.runCommand("", { promptOptions: { cwd, skills: [] } });

    expect(testHarness.notifications).toEqual([
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
    expect(testHarness.notifications).toEqual([
      "Could not load Pi skill-toggle state at /state.json: boom\nThe prompt was left unchanged.",
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

    expect(global.writes).toEqual([[skillPath, "disabled"]]);
    expect(project.writes).toEqual([[projectPath, "enabled"]]);
  });

  test("clears the override when a toggle returns to the default", async () => {
    const store = storeWith({ [skillPath]: "disabled" });

    await harness(store).runCommand("", { custom: selectFirstDialogItem });

    expect(store.writes).toEqual([[skillPath, "default"]]);
  });

  test("restores the row and reports once when persistence fails", async () => {
    let rendered: string[] = [];
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: overrides({ [skillPath]: "disabled" }) }),
      set: () => failure("update"),
    });

    await testHarness.runCommand("", {
      custom: async (factory) => {
        rendered = await selectFirstDialogItem(factory);
      },
    });

    expect(rendered.join("\n")).toContain("disabled");
    expect(rendered.join("\n")).not.toContain("enabled");
    expect(testHarness.notifications).toEqual([
      "Could not update Pi skill-toggle state at /state.json: boom\nThe toggle was not saved.",
    ]);
  });

  test("shows manual-only skills as read-only rows", async () => {
    const store = storeWith();
    let rendered: string[] = [];

    await harness(store).runCommand("", {
      promptOptions: { cwd, skills: [{ ...research, disableModelInvocation: true }] },
      custom: async (factory) => {
        rendered = await selectFirstDialogItem(factory);
      },
    });

    expect(store.writes).toEqual([]);
    expect(rendered.join("\n")).toContain("manual only");
  });

  test("contributes trusted project skills and hides them until enabled", async () => {
    const project = projectWithSkill();
    const event = {
      systemPrompt: `base${formatSkillsForPrompt([project.skill])}`,
      systemPromptOptions: { cwd: project.directory, skills: [project.skill] },
    };
    const hidden = harness(storeWith(), project.directory);
    const enabled = harness(storeWith({ [project.skill.filePath]: "enabled" }), project.directory);

    expect(await hidden.emit("resources_discover", {})).toEqual({
      skillPaths: [project.skill.filePath],
    });
    expect(await hidden.emit("before_agent_start", event)).toEqual({ systemPrompt: "base" });
    await enabled.emit("resources_discover", {});
    expect(await enabled.emit("before_agent_start", event)).toBeUndefined();
  });

  test("contributes nothing from an untrusted project and leaves its temporary skills alone", async () => {
    const project = projectWithSkill();
    const testHarness = harness(storeWith(), project.directory);
    testHarness.distrustProject();

    expect(await testHarness.emit("resources_discover", {})).toBeUndefined();
    expect(
      await testHarness.emit("before_agent_start", {
        systemPrompt: `base${formatSkillsForPrompt([project.skill])}`,
        systemPromptOptions: { cwd: project.directory, skills: [project.skill] },
      }),
    ).toBeUndefined();
  });

  test("applies persisted overrides before the model starts", async () => {
    const testHarness = harness(storeWith({ [skillPath]: "disabled" }));

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: `base${formatSkillsForPrompt([research])}`,
      systemPromptOptions: options,
    });

    expect(result).toEqual({ systemPrompt: "base" });
  });

  test("filters the mutable options of Pi 0.86 without forcing a replacement prompt", async () => {
    const testHarness = harness(storeWith({ [skillPath]: "disabled" }));
    const systemPromptOptions = { cwd, sections: {}, contextFiles: [], skills: [research, deploy] };

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: "rendered by Pi",
      systemPromptOptions,
    });

    expect(result).toBeUndefined();
    expect(systemPromptOptions.skills).toEqual([]);
  });

  test("leaves the prompt alone when nothing is hidden", async () => {
    const testHarness = harness(storeWith({ [projectPath]: "enabled" }));

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: "a prompt another extension rewrote",
      systemPromptOptions: { cwd, skills: [research, deploy] },
    });

    expect(result).toBeUndefined();
    expect(testHarness.notifications).toEqual([]);
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

    expect(await testHarness.emit("before_agent_start", event)).toBeUndefined();
    expect(await testHarness.emit("before_agent_start", event)).toBeUndefined();
    expect(testHarness.notifications).toEqual([
      "Skill toggle could not update the skills prompt section. Another extension may have rewritten it.",
    ]);
  });

  test("leaves the prompt unchanged, reports a state failure once, and again after it recovers", async () => {
    let result: ReturnType<ToggleStateStore["load"]> = failure("load");
    const testHarness = harness({ load: () => result, set: () => failure("update") });
    const event = {
      systemPrompt: `base${formatSkillsForPrompt([research])}`,
      systemPromptOptions: options,
    };

    expect(await testHarness.emit("before_agent_start", event)).toBeUndefined();
    expect(await testHarness.emit("before_agent_start", event)).toBeUndefined();
    expect(testHarness.notifications).toHaveLength(1);

    result = { _tag: "ok", value: overrides() };
    await testHarness.emit("before_agent_start", event);
    result = failure("load");
    await testHarness.emit("before_agent_start", event);
    expect(testHarness.notifications).toHaveLength(2);
    expect(testHarness.notifications[1]).toContain("prompt was left unchanged");
  });
});
