import { basename, isAbsolute, relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  InputSource,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  SettingsList,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import { cacheDebugSink, runRecord, usageRecord } from "./cache-debug";
import type { DebugSink } from "./cache-debug";
import { disabledResourceMatcher, INSTRUCTION_FILE_NAMES, toolPath } from "./guard";
import { discoverProjectSkillPaths } from "./project-skill-paths";
import { planPrompt, promptSnapshot } from "./prompt-epoch";
import type { ModelRef, SessionProjection, TranscriptMessage } from "./prompt-epoch";
import { hideResources } from "./prompt-filter";
import type { PromptFilterEvent } from "./prompt-filter";
import { promptResources, skillReader } from "./prompt-view";
import { RepositoryLocator } from "./repository";
import { resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { defaultToggleValue, isToggleValue, ResourcePolicy, toggleResources } from "./resources";
import type { ToggleOverrides, ToggleResource } from "./resources";
import { registerSession, sessionPolicy, unregisterSession } from "./session-registry";
import type { SessionPolicy, SessionResource } from "./session-registry";
import { pathsReadByCommand } from "./shell-reads";
import { ToggleStateFile } from "./state";
import type { ToggleStateResult, ToggleStateStore } from "./state";
import type { ToggleNote } from "./toggle-note";

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

/** Session identity, which handlers report when Pi provides it. */
export type SessionIdentity = {
  readonly getSessionId?: () => string;
  readonly getHeader?: () => { readonly parentSession?: string } | null;
};

/** Session capabilities the guard reads. */
export type GuardContext = UiContext & {
  readonly cwd: string;
  readonly sessionManager: SessionIdentity & {
    readonly getHeader: () => { readonly parentSession?: string } | null;
  };
};

/** Session capabilities the prompt filter reads. */
export type PromptContext = UiContext & {
  readonly model: ModelRef | undefined;
  readonly sessionManager: SessionIdentity & {
    readonly buildSessionProjection: () => SessionProjection;
    readonly getSessionId: () => string;
  };
};

/** What the prompt filter hands back to Pi. */
export type PromptFilterResult = { systemPrompt: string } | { message: ToggleNote } | undefined;

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
  readonly before_agent_start: (event: PromptFilterEvent, ctx: PromptContext) => PromptFilterResult;
  readonly tool_call: (
    event: GuardedToolCall,
    ctx: GuardContext,
  ) => { block: true; reason: string } | undefined;
  readonly input: (
    event: { readonly text: string; readonly source: InputSource },
    ctx: GuardContext,
  ) => void;
  readonly message_end: (
    event: { readonly message: TranscriptMessage },
    ctx: { readonly sessionManager: Pick<PromptContext["sessionManager"], "getSessionId"> },
  ) => void;
  readonly session_start: (
    event: unknown,
    ctx: { readonly sessionManager: SessionIdentity },
  ) => void;
  readonly session_shutdown: (event: unknown, ctx: unknown) => void;
};

/** Pi registration capabilities used by skill toggle. */
export type ToggleRegistration = Pick<ExtensionAPI, "getCommands" | "exec"> & {
  readonly on: {
    (name: "resources_discover", handler: ToggleHandlers["resources_discover"]): unknown;
    (name: "before_agent_start", handler: ToggleHandlers["before_agent_start"]): unknown;
    (name: "tool_call", handler: ToggleHandlers["tool_call"]): unknown;
    (name: "input", handler: ToggleHandlers["input"]): unknown;
    (name: "message_end", handler: ToggleHandlers["message_end"]): unknown;
    (name: "session_start", handler: ToggleHandlers["session_start"]): unknown;
    (name: "session_shutdown", handler: ToggleHandlers["session_shutdown"]): unknown;
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

/**
 * Register the skill-toggle command and event handlers with an injected store.
 *
 * @param debug - Cache diagnostics sink, read from `PI_SKILL_TOGGLE_CACHE_DEBUG` by default.
 */
export function registerSkillToggle(
  pi: ToggleRegistration,
  store: ToggleStateStore,
  debug: DebugSink | undefined = cacheDebugSink(),
): void {
  const extension = new SkillToggle(store, pi, debug);
  pi.registerCommand("skill-toggle", {
    description: "Enable or disable user-managed instructions and skills",
    handler: async (args, ctx) => extension.openMenu(args, ctx),
  });
  pi.on("session_start", (_event, ctx) => {
    extension.learnSession(ctx.sessionManager);
  });
  pi.on("session_shutdown", () => {
    extension.forgetSession();
  });
  pi.on("resources_discover", async (_event, ctx) => extension.discover(ctx));
  pi.on("before_agent_start", (event, ctx) => extension.filterPrompt(event, ctx));
  pi.on("tool_call", (event, ctx) => extension.guardToolCall(event, ctx));
  pi.on("input", (event, ctx) => {
    extension.recordManualSkill(event, ctx);
  });
  if (debug !== undefined) {
    pi.on("message_end", (event, ctx) => {
      const record = usageRecord(event.message, ctx.sessionManager.getSessionId());
      if (record !== undefined) {
        debug(record);
      }
    });
  }
}

/**
 * Whether a session is a subagent's child session.
 *
 * Subagent extensions record the parent's session id. Pi's own `/new` and `/fork` record the
 * parent's session file path instead, so those sessions stay main sessions.
 */
export function isSubagentSession(ctx: Pick<GuardContext, "sessionManager">): boolean {
  return parentSessionId(ctx.sessionManager) !== undefined;
}

/** The parent session id a subagent's header records, if any. */
function parentSessionId(sessionManager: SessionIdentity): string | undefined {
  const parent = sessionManager.getHeader?.()?.parentSession;
  return parent !== undefined && parent !== "" && !isAbsolute(parent) && !parent.endsWith(".jsonl")
    ? parent
    : undefined;
}

const STATE_FAILURE_CONSEQUENCE = {
  load: "The prompt was left unchanged. Recognized reads of loaded instructions and skills are blocked until it is fixed.",
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
  /** The session this instance serves, once a handler has seen it. */
  private sessionId: string | undefined;
  /** The parent session id, when this is a subagent session. */
  private parentId: string | undefined;
  /** Set while answering a child, so a cyclic parent chain cannot recurse forever. */
  private answering = false;
  /** What this session decides for its subagents, registered under its session id. */
  private readonly policy: SessionPolicy = {
    version: 1,
    match: (path) => this.answer(path, () => this.guardMatch()(path)),
    desiredVisible: (resource) =>
      this.answer(
        undefined,
        (parent) => parent?.desiredVisible(resource) ?? this.ownDesiredVisible(resource),
      ),
  };

  constructor(
    private readonly store: ToggleStateStore,
    private readonly pi: Readonly<Pick<ExtensionAPI, "getCommands" | "exec">>,
    private readonly debug: DebugSink | undefined,
  ) {}

  /** Contribute project skills, timing the discovery when diagnostics are on. */
  async discover(
    ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  ): Promise<{ skillPaths: string[] } | undefined> {
    const started = performance.now();
    const result = await this.contributeProjectSkills(ctx);
    this.debug?.({
      type: "discover",
      cwd: ctx.cwd,
      contributed: result?.skillPaths.length ?? 0,
      durationMs: performance.now() - started,
    });
    return result;
  }

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

  /** Register this session, so its subagents can follow it, and note its parent. */
  learnSession(sessionManager: SessionIdentity): void {
    const id = sessionManager.getSessionId?.();
    if (sessionManager.getHeader !== undefined) {
      this.parentId = parentSessionId(sessionManager);
    }
    if (id === undefined || id === this.sessionId) {
      return;
    }
    this.forgetSession();
    this.sessionId = id;
    registerSession(id, this.policy);
  }

  /** Unregister the session when it shuts down. */
  forgetSession(): void {
    if (this.sessionId !== undefined) {
      unregisterSession(this.sessionId, this.policy);
      this.sessionId = undefined;
    }
  }

  filterPrompt(event: PromptFilterEvent, ctx: PromptContext): PromptFilterResult {
    const started = performance.now();
    this.learnSession(ctx.sessionManager);
    const options = event.systemPromptOptions;
    const resources = toggleResources(options, this.contributedSkills);
    this.resources = resources;
    const loaded = this.overridesFrom("load", this.store.load(), ctx);
    const hidden =
      loaded === undefined ? undefined : this.desiredHidden(disabledIds(loaded, resources));
    return "sections" in options
      ? this.filterSections(event, ctx, { hidden, started })
      : this.filterLegacy(event, ctx, hidden);
  }

  /**
   * Pi 0.86+: keep a cached prompt frozen and announce toggles as appended notes.
   *
   * Pi diffs the filtered options against the transcript's prompt, so the options keep every
   * toggle resource as the model has it unless the prompt is being written anyway.
   */
  private filterSections(
    event: PromptFilterEvent,
    ctx: PromptContext,
    run: { readonly hidden: ReadonlySet<ResourcePath> | undefined; readonly started: number },
  ): PromptFilterResult {
    const options = event.systemPromptOptions;
    const resources = promptResources(options, this.resources);
    const snapshot = promptSnapshot(ctx.sessionManager.buildSessionProjection(), resources);
    const plan = planPrompt({
      ...snapshot,
      resources,
      desiredHidden: run.hidden,
      reader: skillReader(options),
    });
    if (plan.hidden.size > 0) {
      hideResources(event, (path) => plan.hidden.has(resourcePathId(path, options.cwd)));
    }
    this.debug?.(
      runRecord({
        sessionId: ctx.sessionManager.getSessionId(),
        model: ctx.model,
        snapshot,
        plan,
        resources,
        desiredHidden: run.hidden,
        options,
        durationMs: performance.now() - run.started,
      }),
    );
    return plan.note === undefined ? undefined : { message: plan.note };
  }

  /** Pi 0.85: replace the rendered sections that list hidden resources. */
  private filterLegacy(
    event: PromptFilterEvent,
    ctx: UiContext,
    hidden: ReadonlySet<ResourcePath> | undefined,
  ): PromptFilterResult {
    if (hidden === undefined || hidden.size === 0) {
      return undefined;
    }
    const result = hideResources(event, (path) =>
      hidden.has(resourcePathId(path, event.systemPromptOptions.cwd)),
    );
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
    this.learnSession(ctx.sessionManager);
    const shell = event.toolName === "bash";
    const paths = shell ? this.subagentShellReads(event, ctx) : this.readPath(event, ctx);
    if (paths.length === 0) {
      return undefined;
    }
    const matcher = this.guardMatch(ctx);
    const blocked = [
      ...new Set(
        paths.flatMap((path) => {
          const match = matcher(path);
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
    this.learnSession(ctx.sessionManager);
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
    let policy = new ResourcePolicy(loaded);

    const resourcesById = new Map<string, ToggleResource>(
      resources.map((resource) => [resource.id, resource]),
    );
    // Rows without `values` cannot be changed, which keeps manual-only skills read-only.
    const items = resources.map<SettingItem>((resource) => ({
      id: resource.id,
      label: `[${resource.origin} ${resource.kind}] ${resource.label}`,
      description: menuDescription(resource, policy),
      ...(resource.editability === "editable"
        ? {
            currentValue: policy.value(resource),
            values: ["enabled", "disabled"],
          }
        : { currentValue: "manual only" }),
    }));

    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const accentBorder = (): DynamicBorder =>
        new DynamicBorder((text: string) => theme.fg("accent", text));
      const title = new Text("", 1, 0);
      const scope = new Text("", 1, 0);
      const updateText = (): void => {
        title.setText(theme.fg("accent", theme.bold("Skill Toggle")));
        scope.setText(
          theme.fg("dim", "Saved immediately · repository choices affect all worktrees"),
        );
      };
      const save = (id: string, value: string): void => {
        const resource = resourcesById.get(id);
        if (!(resource && isToggleValue(value))) {
          return;
        }
        const stored = value === defaultToggleValue(resource) ? "default" : value;
        const saved = this.overridesFrom(
          "update",
          this.store.set(resource.id, stored, resource.origin),
          ctx,
        );
        if (saved) {
          policy = new ResourcePolicy(saved);
        }
        // A save can change equivalent rows too. Never display the optimistic SettingsList value.
        for (const [index, row] of resources.entries()) {
          const item = items[index];
          if (item !== undefined && row.editability === "editable") {
            item.currentValue = policy.value(row);
          }
        }
      };
      const createList = (): SettingsList =>
        new SettingsList(
          items,
          Math.min(items.length + 2, 20),
          menuListTheme(),
          save,
          () => {
            done(undefined);
          },
          { enableSearch: true },
        );
      const search = new SearchQueryMirror();
      let list = createList();
      const container = new Container();
      const assemble = (): void => {
        container.clear();
        for (const child of [accentBorder(), title, scope, list, accentBorder()]) {
          container.addChild(child);
        }
      };
      assemble();
      updateText();
      return {
        // Older SettingsList versions can overrun very narrow widths; constrain every line.
        render: (width: number) =>
          container.render(Math.max(width, 10)).map((line) => truncateToWidth(line, width)),
        invalidate: () => {
          updateText();
          container.invalidate();
        },
        handleInput: (data: string) => {
          // SettingsList cancels on Esc even mid-search and keeps its query private, so clear a
          // nonempty query by replacing the list; an empty query lets SettingsList cancel (close).
          if (search.cancelClears(data)) {
            list = createList();
            assemble();
          } else {
            search.handleInput(data);
            list.handleInput(data);
          }
          tui.requestRender();
        },
      };
    });
  }

  /** The registered policy of this subagent's parent session, if it runs in this process. */
  private parentPolicy(): SessionPolicy | undefined {
    return this.parentId === undefined || this.parentId === this.sessionId
      ? undefined
      : sessionPolicy(this.parentId);
  }

  /** Answer a child once at a time; a re-entrant question from a cycle gets the fallback. */
  private answer<T>(fallback: T, decide: (parent: SessionPolicy | undefined) => T): T {
    if (this.answering) {
      return fallback;
    }
    this.answering = true;
    try {
      return decide(this.parentPolicy());
    } finally {
      this.answering = false;
    }
  }

  /** This session's own matcher. Without state, every listed resource is blocked. */
  private ownMatch(
    ctx: UiContext | undefined,
    parent: SessionPolicy | undefined,
  ): (path: string) => string | undefined {
    const result = this.store.load();
    const loaded = ctx === undefined ? okValue(result) : this.overridesFrom("load", result, ctx);
    const matcher = disabledResourceMatcher(
      this.resources,
      loaded,
      this.parentId === undefined ? this.manualSkills : new Set(),
      parent === undefined
        ? undefined
        : (resource) => {
            const visible = parentVisible(parent, resource);
            return visible === undefined ? undefined : !visible;
          },
    );
    return (path) => matcher.match(path);
  }

  /**
   * The read matcher. A registered parent blocks what it would block itself; for resources this
   * session loaded, the parent decides visibility and this session finds which resource owns a
   * path, so a child's own copy of a skill the parent enabled or invoked stays readable.
   */
  private guardMatch(ctx?: UiContext): (path: string) => string | undefined {
    const parent = this.parentPolicy();
    const own = this.ownMatch(ctx, parent);
    return parent === undefined ? own : (path) => parent.match(path) ?? own(path);
  }

  /** Whether this session wants a resource a child asks about visible: by id, then skill name. */
  private ownDesiredVisible(resource: SessionResource): boolean | undefined {
    const own =
      this.resources.find(({ id, kind }) => kind === resource.kind && id === resource.id) ??
      this.resources.find(
        ({ kind, label }) =>
          resource.kind === "skill" && kind === "skill" && label === resource.name,
      );
    if (own === undefined) {
      return undefined;
    }
    if (own.kind === "skill" && this.parentId === undefined && this.manualSkills.has(own.label)) {
      return true;
    }
    const loaded = okValue(this.store.load());
    return loaded === undefined ? undefined : new ResourcePolicy(loaded).value(own) === "enabled";
  }

  /** A subagent hides what its parent hides; resources the parent does not know keep their own state. */
  private desiredHidden(own: ReadonlySet<ResourcePath>): ReadonlySet<ResourcePath> {
    const parent = this.parentPolicy();
    if (parent === undefined) {
      return own;
    }
    return new Set(
      this.resources
        .filter((resource) => {
          const visible = parentVisible(parent, resource);
          return visible === undefined ? own.has(resource.id) : !visible;
        })
        .map(({ id }) => id),
    );
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
        description: id,
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

/** Whether a subagent's parent wants one of the subagent's resources visible, if it knows it. */
function parentVisible(parent: SessionPolicy, resource: ToggleResource): boolean | undefined {
  return parent.desiredVisible({
    id: resource.id,
    kind: resource.kind,
    name: resource.kind === "skill" ? resource.label : resource.id,
  });
}

function okValue(result: ToggleStateResult): ToggleOverrides | undefined {
  return result._tag === "ok" ? result.value : undefined;
}

/** Toggle resources the user's overrides disable. */
function disabledIds(
  loaded: ToggleOverrides,
  resources: readonly ToggleResource[],
): ReadonlySet<ResourcePath> {
  const policy = new ResourcePolicy(loaded);
  return new Set(
    resources
      .filter((resource) => policy.value(resource) === "disabled")
      .map((resource) => resource.id),
  );
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

/**
 * Mirror of SettingsList's private search query.
 *
 * Routes keys exactly as SettingsList 1.1 does: selection, confirm, cancel, and Space with an
 * empty query never reach its search input; everything else does.
 */
class SearchQueryMirror {
  private input = new Input();

  /** Whether a cancel key should clear a nonempty query; if so, the mirror is cleared too. */
  cancelClears(data: string): boolean {
    if (!getKeybindings().matches(data, "tui.select.cancel") || this.input.getValue() === "") {
      return false;
    }
    this.input = new Input();
    return true;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const listKey = (
      ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const
    ).some((binding) => kb.matches(data, binding));
    if (!listKey && !(data === " " && this.input.getValue() === "")) {
      this.input.handleInput(data);
    }
  }
}

/**
 * SettingsList's own search-enabled hint says "Esc to cancel", but Esc first clears a nonempty
 * query here. Replace exactly that known string; every other hint (no matches, scroll position,
 * or an unknown future hint) passes through unchanged. Search is always enabled, so the
 * search-disabled hint cannot occur, and its "Esc to cancel" would be accurate if it did.
 * Enter and Esc come first so they stay visible when SettingsList truncates the hint (60 columns).
 */
const SETTINGS_LIST_HINTS: ReadonlyMap<string, string> = new Map([
  [
    "  Type to search · Enter/Space to change · Esc to cancel",
    "  Enter toggle · Esc clear search, then close · type to search · Space toggle (empty search)",
  ],
]);

function menuListTheme(): SettingsListTheme {
  const base = getSettingsListTheme();
  return { ...base, hint: (text) => base.hint(SETTINGS_LIST_HINTS.get(text) ?? text) };
}

/** Discovery details plus one scope line derived from the policy rule used for persistence. */
function menuDescription(resource: ToggleResource, policy: ResourcePolicy): string {
  const origin = resource.origin === "global" ? "Global" : "Project";
  const scope = policy.repositoryWide(resource)
    ? "repository-wide (all worktrees)"
    : "this path only";
  const manual = resource.editability === "manual-only" ? " · Manual only (read-only)" : "";
  return `${resource.description}\n${origin} ${resource.kind} · ${scope}${manual}`;
}
