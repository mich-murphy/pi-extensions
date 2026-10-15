import { basename, isAbsolute, relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  InputSource,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  disabledResourceMatcher,
  effectiveOverrides,
  INSTRUCTION_FILE_NAMES,
  toolPath,
} from "./guard";
import { discoverProjectSkillPaths } from "./project-skill-paths";
import { hideResources } from "./prompt-filter";
import type { PromptFilterEvent } from "./prompt-filter";
import { RepositoryLocator } from "./repository";
import { resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { defaultToggleValue, isToggleValue, toggleResources, toggleValue } from "./resources";
import type { ToggleOverrides, ToggleResource } from "./resources";
import { pathsReadByCommand } from "./shell-reads";
import { ToggleStateFile } from "./state";
import type { ToggleStateResult, ToggleStateStore } from "./state";

/** Context capabilities used by the toggle command. */
export type ToggleCommandContext = Pick<
  ExtensionCommandContext,
  "cwd" | "mode" | "getSystemPromptOptions"
> & {
  readonly ui: Pick<ExtensionUIContext, "notify"> & {
    readonly custom: (factory: Parameters<ExtensionUIContext["custom"]>[0]) => Promise<unknown>;
  };
};

/** UI capabilities used to report failures. */
export type UiContext = { readonly ui: Readonly<Pick<ExtensionUIContext, "notify">> };

/** Session capabilities the guard reads. */
export type GuardContext = UiContext & {
  readonly cwd: string;
  readonly sessionManager: {
    readonly getHeader: () => { readonly parentSession?: string } | null;
  };
};

/** The part of a `tool_call` event the guard reads. */
export type GuardedToolCall = {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
};

/** Event callbacks consumed by skill toggle. */
export type ToggleHandlers = {
  readonly resources_discover: (
    event: unknown,
    ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  ) => Promise<{ skillPaths: string[] } | undefined>;
  readonly before_agent_start: (
    event: PromptFilterEvent,
    ctx: UiContext,
  ) => { systemPrompt: string } | undefined;
  readonly tool_call: (
    event: GuardedToolCall,
    ctx: GuardContext,
  ) => { block: true; reason: string } | undefined;
  readonly input: (
    event: { readonly text: string; readonly source: InputSource },
    ctx: GuardContext,
  ) => void;
};

/** Pi registration capabilities used by skill toggle. */
export type ToggleRegistration = Pick<ExtensionAPI, "getCommands" | "exec"> & {
  readonly on: {
    (name: "resources_discover", handler: ToggleHandlers["resources_discover"]): unknown;
    (name: "before_agent_start", handler: ToggleHandlers["before_agent_start"]): unknown;
    (name: "tool_call", handler: ToggleHandlers["tool_call"]): unknown;
    (name: "input", handler: ToggleHandlers["input"]): unknown;
  };
  readonly registerCommand: (
    name: string,
    command: {
      readonly description: string;
      readonly handler: (args: string, ctx: ToggleCommandContext) => Promise<void>;
    },
  ) => void;
};

/** Register the skill-toggle extension with its default persistent store. */
export default function skillToggle(pi: ToggleRegistration): void {
  registerSkillToggle(pi, new ToggleStateFile());
}

/** Register the skill-toggle command and event handlers with an injected store. */
export function registerSkillToggle(pi: ToggleRegistration, store: ToggleStateStore): void {
  const extension = new SkillToggle(store, pi);
  pi.registerCommand("skill-toggle", {
    description: "Enable or disable user-managed instructions and skills",
    handler: async (args, ctx) => extension.openMenu(args, ctx),
  });
  pi.on("resources_discover", async (_event, ctx) => extension.contributeProjectSkills(ctx));
  pi.on("before_agent_start", (event, ctx) => extension.filterPrompt(event, ctx));
  pi.on("tool_call", (event, ctx) => extension.guardToolCall(event, ctx));
  pi.on("input", (event, ctx) => {
    extension.recordManualSkill(event, ctx);
  });
}

/**
 * Whether a session is a subagent's child session.
 *
 * Subagent extensions record the parent's session id. Pi's own `/new` and `/fork` record the
 * parent's session file path instead, so those sessions stay main sessions.
 */
export function isSubagentSession(ctx: Pick<GuardContext, "sessionManager">): boolean {
  const parent = ctx.sessionManager.getHeader()?.parentSession;
  return parent !== undefined && parent !== "" && !isAbsolute(parent) && !parent.endsWith(".jsonl");
}

const STATE_FAILURE_CONSEQUENCE = {
  load: "The prompt was left unchanged, and the model cannot read instruction or skill files until it is fixed.",
  update: "The toggle was not saved.",
} as const;

const MANUAL_SKILL = /^\/skill:(?<name>\S+)/u;
const GIT_TIMEOUT_MS = 5000;

function createFailureReporter(): (ctx: UiContext, failure: string | undefined) => void {
  let lastFailure: string | undefined;
  return (ctx, failure) => {
    if (failure !== undefined && failure !== lastFailure) {
      ctx.ui.notify(failure, "error");
    }
    lastFailure = failure;
  };
}

class SkillToggle {
  private contributedSkills: ReadonlySet<ResourcePath> = new Set();
  /** Resources Pi loaded for the latest run, before the prompt filter hid any. */
  private resources: readonly ToggleResource[] = [];
  /** Skills the user invoked with `/skill:name` in this session. */
  private readonly manualSkills = new Set<string>();
  private readonly reportStateFailure = createFailureReporter();
  private readonly reportPromptFailure = createFailureReporter();

  constructor(
    private readonly store: ToggleStateStore,
    private readonly pi: Readonly<Pick<ExtensionAPI, "getCommands" | "exec">>,
  ) {}

  async contributeProjectSkills(
    ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  ): Promise<{ skillPaths: string[] } | undefined> {
    if (!ctx.isProjectTrusted()) {
      this.contributedSkills = new Set();
      return undefined;
    }
    const loadedNativeNames = new Set(
      this.pi.getCommands().flatMap((command) => {
        if (
          command.source !== "skill" ||
          !command.name.startsWith("skill:") ||
          this.contributedSkills.has(resourcePathId(command.sourceInfo.path, ctx.cwd))
        ) {
          return [];
        }
        // Pi 0.85 and current Pi expose every loaded skill this way; `enableSkillCommands`
        // controls interactive command registration, not this public resource inventory.
        return [command.name.slice("skill:".length)];
      }),
    );
    const skillPaths = [
      ...(await discoverProjectSkillPaths(ctx.cwd, getAgentDir(), loadedNativeNames)),
    ];
    this.contributedSkills = new Set(skillPaths.map((path) => resourcePathId(path, ctx.cwd)));
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  }

  filterPrompt(event: PromptFilterEvent, ctx: UiContext): { systemPrompt: string } | undefined {
    const options = event.systemPromptOptions;
    const resources = toggleResources(options, this.contributedSkills);
    this.resources = resources;
    const loaded = this.overridesFrom("load", this.store.load(), ctx);
    if (!loaded) {
      return undefined;
    }
    const { overrides } = effectiveOverrides(loaded, resources);
    const hidden = new Set<ResourcePath>(
      resources
        .filter((resource) => toggleValue(overrides, resource) === "disabled")
        .map((resource) => resource.id),
    );
    if (hidden.size === 0) {
      return undefined;
    }

    const result = hideResources(event, (path) => hidden.has(resourcePathId(path, options.cwd)));
    if (result._tag === "options-filtered") {
      return undefined;
    }
    this.reportPromptFailure(
      ctx,
      result.unmatched.length > 0
        ? `Skill toggle could not update the ${result.unmatched.join(" and ")} prompt section. Another extension may have rewritten it.`
        : undefined,
    );
    return result.systemPrompt === event.systemPrompt
      ? undefined
      : { systemPrompt: result.systemPrompt };
  }

  /** Refuse `read` of a disabled resource, and subagent `bash` commands that print one. */
  guardToolCall(
    event: GuardedToolCall,
    ctx: GuardContext,
  ): { block: true; reason: string } | undefined {
    const shell = event.toolName === "bash";
    const paths = shell ? this.subagentShellReads(event, ctx) : this.readPath(event, ctx);
    if (paths.length === 0) {
      return undefined;
    }
    const loaded = this.overridesFrom("load", this.store.load(), ctx);
    const overrides =
      loaded === undefined ? undefined : effectiveOverrides(loaded, this.resources).overrides;
    const matcher = disabledResourceMatcher(
      this.resources,
      overrides,
      isSubagentSession(ctx) ? new Set() : this.manualSkills,
    );
    const blocked = [
      ...new Set(
        paths.flatMap((path) => {
          const match = matcher.match(path);
          return match === undefined ? [] : [match];
        }),
      ),
    ];
    if (blocked.length === 0) {
      return undefined;
    }
    const names = blocked.join(", ");
    return {
      block: true,
      reason: shell
        ? `This command reads ${names}, which the user disabled in /skill-toggle. Run it without ${blocked.length === 1 ? "that file" : "those files"}.`
        : `${names} is disabled in /skill-toggle, so it cannot be read.`,
    };
  }

  /** Remember a skill the user invoked explicitly, so its own files stay readable. */
  recordManualSkill(
    event: { readonly text: string; readonly source: InputSource },
    ctx: GuardContext,
  ): void {
    if (event.source === "extension" || isSubagentSession(ctx)) {
      return;
    }
    const name = MANUAL_SKILL.exec(event.text.trim())?.groups?.name;
    if (name !== undefined) {
      this.manualSkills.add(name);
    }
  }

  async openMenu(args: string, ctx: ToggleCommandContext): Promise<void> {
    if (args.trim()) {
      ctx.ui.notify("Usage: /skill-toggle", "error");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/skill-toggle requires TUI mode", "error");
      return;
    }
    const loadedResources = toggleResources(ctx.getSystemPromptOptions(), this.contributedSkills);
    const resources = withNestedInstructions(
      loadedResources,
      await this.nestedInstructions(ctx.cwd, loadedResources),
    );
    if (resources.length === 0) {
      ctx.ui.notify("No user-managed instructions or skills are loaded", "info");
      return;
    }
    const loaded = this.overridesFrom("load", this.store.load(), ctx);
    if (!loaded) {
      return;
    }
    let effective = effectiveOverrides(loaded, resources);

    const resourcesById = new Map<string, ToggleResource>(
      resources.map((resource) => [resource.id, resource]),
    );
    // Rows without `values` cannot be changed, which keeps manual-only skills read-only.
    const items = resources.map<SettingItem>((resource) => ({
      id: resource.id,
      label: `[${resource.origin}] ${resource.label}`,
      description: resource.description,
      ...(resource.editability === "editable"
        ? {
            currentValue: toggleValue(effective.overrides, resource),
            values: ["enabled", "disabled"],
          }
        : { currentValue: "manual only" }),
    }));

    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const accentBorder = (): DynamicBorder =>
        new DynamicBorder((text: string) => theme.fg("accent", text));
      const title = new Text("", 1, 0);
      const help = new Text("", 1, 0);
      const updateText = (): void => {
        title.setText(theme.fg("accent", theme.bold("Skill Toggle")));
        help.setText(theme.fg("dim", "enter/space toggle · type to search · esc close"));
      };
      const list = new SettingsList(
        items,
        Math.min(items.length + 2, 20),
        getSettingsListTheme(),
        (id, value) => {
          const resource = resourcesById.get(id);
          if (!(resource && isToggleValue(value))) {
            return;
          }
          // A worktree row that inherits another worktree's toggle keeps an explicit value,
          // so returning it to the default still overrides the inherited one.
          const stored =
            value === defaultToggleValue(resource) && !effective.inherited.has(resource.id)
              ? "default"
              : value;
          const saved = this.overridesFrom("update", this.store.set(resource.id, stored), ctx);
          if (saved) {
            effective = effectiveOverrides(saved, resources);
          } else {
            list.updateValue(id, toggleValue(effective.overrides, resource));
          }
        },
        () => {
          done(undefined);
        },
        { enableSearch: true },
      );
      const container = new Container();
      for (const child of [accentBorder(), title, list, help, accentBorder()]) {
        container.addChild(child);
      }
      updateText();
      return {
        render: (width: number) => container.render(width),
        invalidate: () => {
          updateText();
          container.invalidate();
        },
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  private readPath(event: GuardedToolCall, ctx: GuardContext): readonly string[] {
    const { path } = event.input;
    return event.toolName === "read" && typeof path === "string" ? [toolPath(path, ctx.cwd)] : [];
  }

  private subagentShellReads(event: GuardedToolCall, ctx: GuardContext): readonly string[] {
    const { command } = event.input;
    return typeof command === "string" && isSubagentSession(ctx)
      ? pathsReadByCommand(command, ctx.cwd)
      : [];
  }

  /** Instruction files tracked in the current worktree that Pi did not load. */
  private async nestedInstructions(
    cwd: string,
    loaded: readonly ToggleResource[],
  ): Promise<readonly ToggleResource[]> {
    const root = new RepositoryLocator().worktreeRoot(resourcePathId(cwd, cwd));
    if (root === undefined) {
      return [];
    }
    let stdout: string;
    try {
      const result = await this.pi.exec(
        "git",
        [
          "-C",
          root,
          "ls-files",
          "-z",
          "--",
          ...[...INSTRUCTION_FILE_NAMES].map((name) => `*${name}`),
        ],
        { timeout: GIT_TIMEOUT_MS },
      );
      if (result.code !== 0) {
        return [];
      }
      ({ stdout } = result);
    } catch {
      return [];
    }
    const known = new Set(loaded.map((resource) => resource.id));
    return [
      ...new Set(
        stdout
          .split("\0")
          .filter((path) => INSTRUCTION_FILE_NAMES.has(basename(path)))
          .map((path) => resourcePathId(path, root)),
      ),
    ]
      .filter((id) => !known.has(id))
      .toSorted()
      .map<ToggleResource>((id) => ({
        id,
        kind: "instruction",
        origin: "project",
        label: relative(root, id),
        description: `project instruction\n${id}`,
        editability: "editable",
      }));
  }

  private overridesFrom(
    operation: keyof typeof STATE_FAILURE_CONSEQUENCE,
    result: ToggleStateResult,
    ctx: UiContext,
  ): ToggleOverrides | undefined {
    if (result._tag === "ok") {
      this.reportStateFailure(ctx, undefined);
      return result.value;
    }
    this.reportStateFailure(
      ctx,
      `${result.error.message}\n${STATE_FAILURE_CONSEQUENCE[operation]}`,
    );
    return undefined;
  }
}

/** Place nested instructions after the loaded project instructions, before project skills. */
function withNestedInstructions(
  loaded: readonly ToggleResource[],
  nested: readonly ToggleResource[],
): readonly ToggleResource[] {
  const index = loaded.findIndex(
    (resource) => resource.origin === "project" && resource.kind === "skill",
  );
  return index === -1
    ? [...loaded, ...nested]
    : [...loaded.slice(0, index), ...nested, ...loaded.slice(index)];
}
