import { join } from "node:path";
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
import { describe, expect, test } from "vitest";
import skillToggle, { registerSkillToggle } from "../index";
import { resourcePathId } from "../resource-path";
import type { SkillToggleState, SkillToggleStateStore } from "../state";

const skillPath = join(getAgentDir(), "skills/research/SKILL.md");
const research: Skill = {
  name: "research",
  description: "Research primary sources",
  filePath: skillPath,
  baseDir: join(skillPath, ".."),
  sourceInfo: {
    path: skillPath,
    source: "local",
    scope: "user",
    origin: "top-level",
  },
  disableModelInvocation: false,
};
const options: BuildSystemPromptOptions = { cwd: "/work/project", skills: [research] };

type TestHandler = (event: unknown, context: unknown) => unknown | Promise<unknown>;
type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;
type DialogFactory = Parameters<ExtensionUIContext["custom"]>[0];

async function selectFirstDialogItem(factory: DialogFactory): Promise<void> {
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
}

function state(resources: SkillToggleState["resources"] = {}): SkillToggleState {
  return { version: 5, resources };
}

function harness(store: SkillToggleStateStore) {
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
  const ctx = {
    cwd: "/work/project",
    isProjectTrusted: () => true,
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
      cwd: "/work/project",
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
  return { commands, emit, notifications, runCommand };
}

describe("extension lifecycle", () => {
  test("the package entry point registers its command and prompt hook", () => {
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

  test("registers only the skill-toggle command", () => {
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state() }),
      setValue: () => ({ _tag: "ok", value: state() }),
    });

    expect([...testHarness.commands.keys()]).toEqual(["skill-toggle"]);
  });

  test("rejects command arguments and non-TUI sessions", async () => {
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state() }),
      setValue: () => ({ _tag: "ok", value: state() }),
    });

    await testHarness.runCommand("unexpected");
    await testHarness.runCommand("", { mode: "rpc" });

    expect(testHarness.notifications).toEqual([
      "Usage: /skill-toggle",
      "/skill-toggle requires TUI mode",
    ]);
  });

  test("reports when the command has no user-managed resources", async () => {
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state() }),
      setValue: () => ({ _tag: "ok", value: state() }),
    });

    await testHarness.runCommand("", {
      promptOptions: { cwd: "/work/project", skills: [] },
    });

    expect(testHarness.notifications).toEqual([
      "No user-managed instructions or skills are loaded",
    ]);
  });

  test("does not open the dialog when command state loading fails", async () => {
    const error = Object.assign(new Error("load failed"), {
      _tag: "SkillToggleStateError" as const,
      operation: "load" as const,
    });
    let opened = false;
    const testHarness = harness({
      load: () => ({ _tag: "err", error }),
      setValue: () => ({ _tag: "ok", value: state() }),
    });

    await testHarness.runCommand("", {
      custom: async () => {
        opened = true;
      },
    });

    expect(opened).toBe(false);
    expect(testHarness.notifications).toEqual(["load failed\nThe prompt was left unchanged."]);
  });

  test("opens the dialog and persists a toggle selected by the user", async () => {
    const writes: Array<{ readonly id: string; readonly value: string }> = [];
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state() }),
      setValue: (resource, value) => {
        writes.push({ id: resource.id, value });
        return { _tag: "ok", value: state() };
      },
    });
    await testHarness.runCommand("", { custom: selectFirstDialogItem });

    expect(writes).toEqual([{ id: skillPath, value: "disabled" }]);
  });

  test("enables a project skill only after the user toggles it", async () => {
    const projectPath = "/work/project/.agents/skills/deploy/SKILL.md";
    const projectSkill: Skill = {
      ...research,
      name: "deploy",
      filePath: projectPath,
      baseDir: join(projectPath, ".."),
      sourceInfo: {
        path: projectPath,
        source: "local",
        scope: "project",
        origin: "top-level",
      },
    };
    const writes: Array<{ readonly id: string; readonly value: string }> = [];
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state() }),
      setValue: (resource, value) => {
        writes.push({ id: resource.id, value });
        return {
          _tag: "ok",
          value: state({
            [resource.id]: {
              kind: resource.kind,
              origin: resource.origin,
              owner: resource.owner,
              enabled: true,
            },
          }),
        };
      },
    });

    await testHarness.runCommand("", {
      promptOptions: { cwd: "/work/project", skills: [projectSkill] },
      custom: selectFirstDialogItem,
    });

    expect(writes).toEqual([{ id: projectPath, value: "enabled" }]);
  });

  test("restores the prior toggle value when persistence fails", async () => {
    const error = Object.assign(new Error("write failed"), {
      _tag: "SkillToggleStateError" as const,
      operation: "update" as const,
    });
    const disabled = {
      [skillPath]: {
        kind: "skill" as const,
        origin: "global" as const,
        owner: resourcePathId(join(getAgentDir(), "skills")),
        enabled: false as const,
      },
    };
    const writes: string[] = [];
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state(disabled) }),
      setValue: (_resource, value) => {
        writes.push(value);
        return { _tag: "err", error };
      },
    });

    await testHarness.runCommand("", { custom: selectFirstDialogItem });

    expect(writes).toEqual(["enabled"]);
    expect(testHarness.notifications).toEqual(["write failed\nThe prompt was left unchanged."]);
  });

  test("does not persist manual-only skills selected in the dialog", async () => {
    const writes: string[] = [];
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state() }),
      setValue: (_resource, value) => {
        writes.push(value);
        return { _tag: "ok", value: state() };
      },
    });

    await testHarness.runCommand("", {
      promptOptions: {
        cwd: "/work/project",
        skills: [{ ...research, disableModelInvocation: true }],
      },
      custom: selectFirstDialogItem,
    });

    expect(writes).toEqual([]);
  });

  test("applies persisted path toggles before the model starts", async () => {
    const disabled = {
      [skillPath]: {
        kind: "skill" as const,
        origin: "global" as const,
        owner: resourcePathId(join(getAgentDir(), "skills")),
        enabled: false as const,
      },
    };
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state(disabled) }),
      setValue: () => ({ _tag: "ok", value: state(disabled) }),
    });

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: `base${formatSkillsForPrompt([research])}`,
      systemPromptOptions: options,
    });

    expect(result).toEqual({ systemPrompt: "base" });
  });

  test("hides project skills from the model by default", async () => {
    const projectPath = "/work/project/.agents/skills/deploy/SKILL.md";
    const projectSkill: Skill = {
      ...research,
      name: "deploy",
      filePath: projectPath,
      baseDir: join(projectPath, ".."),
      sourceInfo: {
        path: projectPath,
        source: "local",
        scope: "project",
        origin: "top-level",
      },
    };
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state() }),
      setValue: () => ({ _tag: "ok", value: state() }),
    });

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: `base${formatSkillsForPrompt([projectSkill])}`,
      systemPromptOptions: { cwd: "/work/project", skills: [projectSkill] },
    });

    expect(result).toEqual({ systemPrompt: "base" });
  });

  test("advertises an activated project skill to the model", async () => {
    const projectPath = "/work/project/.agents/skills/deploy/SKILL.md";
    const projectSkill: Skill = {
      ...research,
      name: "deploy",
      filePath: projectPath,
      baseDir: join(projectPath, ".."),
      sourceInfo: {
        path: projectPath,
        source: "local",
        scope: "project",
        origin: "top-level",
      },
    };
    const enabled = {
      [projectPath]: {
        kind: "skill" as const,
        origin: "project" as const,
        owner: resourcePathId("/work/project"),
        enabled: true,
      },
    };
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state(enabled) }),
      setValue: () => ({ _tag: "ok", value: state(enabled) }),
    });
    const prompt = `base${formatSkillsForPrompt([projectSkill])}`;

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: prompt,
      systemPromptOptions: { cwd: "/work/project", skills: [projectSkill] },
    });

    expect(result).toEqual({ systemPrompt: prompt });
  });

  test("does not apply stale state to package or other excluded resources", async () => {
    const packagePath = "/packages/research/SKILL.md";
    const packageSkill: Skill = {
      ...research,
      filePath: packagePath,
      baseDir: "/packages/research",
      sourceInfo: {
        path: packagePath,
        source: "npm:example",
        scope: "user",
        origin: "package",
      },
    };
    const stale = {
      [packagePath]: {
        kind: "skill" as const,
        origin: "global" as const,
        owner: resourcePathId("/packages"),
        enabled: false as const,
      },
    };
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state(stale) }),
      setValue: () => ({ _tag: "ok", value: state(stale) }),
    });
    const prompt = `base${formatSkillsForPrompt([packageSkill])}`;

    const result = await testHarness.emit("before_agent_start", {
      systemPrompt: prompt,
      systemPromptOptions: { cwd: "/work/project", skills: [packageSkill] },
    });

    expect(result).toEqual({ systemPrompt: prompt });
  });

  test("reports prompt sections that cannot be updated and deduplicates the warning", async () => {
    const disabled = {
      [skillPath]: {
        kind: "skill" as const,
        origin: "global" as const,
        owner: resourcePathId(join(getAgentDir(), "skills")),
        enabled: false as const,
      },
    };
    const testHarness = harness({
      load: () => ({ _tag: "ok", value: state(disabled) }),
      setValue: () => ({ _tag: "ok", value: state(disabled) }),
    });
    const event = { systemPrompt: "base", systemPromptOptions: options };

    expect(await testHarness.emit("before_agent_start", event)).toEqual({ systemPrompt: "base" });
    expect(await testHarness.emit("before_agent_start", event)).toEqual({ systemPrompt: "base" });
    expect(testHarness.notifications).toEqual([
      "Skill toggle could not update the skills prompt section. Pi's prompt format may have changed.",
    ]);
  });

  test("leaves the prompt unchanged and deduplicates state failures", async () => {
    const error = Object.assign(new Error("broken state"), {
      _tag: "SkillToggleStateError" as const,
      operation: "load" as const,
    });
    const testHarness = harness({
      load: () => ({ _tag: "err", error }),
      setValue: () => ({ _tag: "err", error }),
    });
    const event = {
      systemPrompt: `base${formatSkillsForPrompt([research])}`,
      systemPromptOptions: options,
    };

    expect(await testHarness.emit("before_agent_start", event)).toBeUndefined();
    expect(await testHarness.emit("before_agent_start", event)).toBeUndefined();
    expect(testHarness.notifications).toHaveLength(1);
    expect(testHarness.notifications[0]).toContain("prompt was left unchanged");
  });
});
