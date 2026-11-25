import { basename, isAbsolute, relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  InputSource,
  ResourcesDiscoverEvent,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { cacheDebugSink, runRecord, usageRecord } from "./cache-debug";
import type { DebugSink } from "./cache-debug";
import { diagnosticText } from "./diagnostic-text";
import { disabledResourceMatcher, INSTRUCTION_FILE_NAMES, toolPath } from "./guard";
import { readInstructionHeading } from "./instruction-heading";
import { createContextMenu } from "./menu";
import { discoverProjectSkillPaths } from "./project-skill-paths";
import { planPrompt, promptSnapshot } from "./prompt-epoch";
import type { ModelRef, SessionProjection, TranscriptMessage } from "./prompt-epoch";
import { hideResources } from "./prompt-filter";
import type { PromptFilterEvent } from "./prompt-filter";
import { promptResources, skillReader } from "./prompt-view";
import { RepositoryLocator } from "./repository";
import { resourcePathId } from "./resource-path";
import type { ResourcePath } from "./resource-path";
import { defaultToggleValue, ResourcePolicy, toggleResources } from "./resources";
import type { ToggleOverrides, ToggleResource } from "./resources";
import { registerSession, sessionPolicy, unregisterSession } from "./session-registry";
import type { SessionPolicy, SessionResource } from "./session-registry";
import { pathsReadByCommand } from "./shell-reads";
import { ToggleStateFile } from "./state";
import type { ToggleStateResult, ToggleStateStore } from "./state";
import type { ToggleNote } from "./toggle-note";

export type ToggleDialogFactory = (
  tui: Parameters<Parameters<ExtensionUIContext["custom"]>[0]>[0],
  theme: ExtensionUIContext["theme"],
  keybindings: Parameters<Parameters<ExtensionUIContext["custom"]>[0]>[2],
  done: () => void,
) => ReturnType<Parameters<ExtensionUIContext["custom"]>[0]>;

export type ToggleCommandContext = Pick<
  ExtensionCommandContext,
  "cwd" | "mode" | "getSystemPromptOptions"
> & {
  readonly ui: Pick<ExtensionUIContext, "notify"> & {
    readonly custom: (factory: ToggleDialogFactory) => Promise<void>;
  };
};

export type UiContext = { readonly ui: Readonly<Pick<ExtensionUIContext, "notify">> };

export type SessionIdentity = {
  readonly getSessionId?: () => string;
  readonly getHeader?: () => { readonly parentSession?: string } | null;
};

export type GuardContext = UiContext & {
  readonly cwd: string;
  readonly sessionManager: SessionIdentity & {
    readonly getHeader: () => { readonly parentSession?: string } | null;
  };
};

export type PromptContext = UiContext & {
  readonly model: ModelRef | undefined;
  readonly sessionManager: SessionIdentity & {
    readonly buildSessionProjection: () => SessionProjection;
    readonly getSessionId: () => string;
  };
};

export type PromptFilterResult = { systemPrompt: string } | { message: ToggleNote } | undefined;

export type GuardedToolCall = Readonly<Pick<ToolCallEvent, "toolName" | "input">>;

const isReadInput = Schema.is(Schema.Struct({ path: Schema.String }));
const isShellInput = Schema.is(Schema.Struct({ command: Schema.String }));

export type ToggleHandlers = {
  readonly resources_discover: (
    event: ResourcesDiscoverEvent,
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
    event: SessionStartEvent,
    ctx: { readonly sessionManager: SessionIdentity },
  ) => void;
  readonly session_shutdown: () => void;
};

export type ToggleRegistration = Pick<ExtensionAPI, "getCommands" | "exec"> & {
  readonly on: {
    (name: "resources_discover", handler: ToggleHandlers["resources_discover"]): void;
    (name: "before_agent_start", handler: ToggleHandlers["before_agent_start"]): void;
    (name: "tool_call", handler: ToggleHandlers["tool_call"]): void;
    (name: "input", handler: ToggleHandlers["input"]): void;
    (name: "message_end", handler: ToggleHandlers["message_end"]): void;
    (name: "session_start", handler: ToggleHandlers["session_start"]): void;
    (name: "session_shutdown", handler: ToggleHandlers["session_shutdown"]): void;
  };
  readonly registerCommand: (
    name: string,
    command: {
      readonly description: string;
      readonly handler: (args: string, ctx: ToggleCommandContext) => Promise<void>;
    },
  ) => void;
};

export default function piSkills(pi: ToggleRegistration): void {
  registerPiSkills(pi, new ToggleStateFile());
}

export function registerPiSkills(
  pi: ToggleRegistration,
  store: ToggleStateStore,
  debug: DebugSink | undefined = cacheDebugSink(),
): void {
  const extension = new PiSkills(store, pi, debug);
  pi.registerCommand("skills", {
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

export function isSubagentSession(ctx: Pick<GuardContext, "sessionManager">): boolean {
  return parentSessionId(ctx.sessionManager) !== undefined;
}

function parentSessionId(sessionManager: SessionIdentity): string | undefined {
  const parent = sessionManager.getHeader?.()?.parentSession;
  return parent !== undefined && parent !== "" && !isAbsolute(parent) && !parent.endsWith(".jsonl")
    ? parent
    : undefined;
}

const STATE_FAILURE_CONSEQUENCE = {
  load: "Until the file is fixed, the prompt is unchanged and all skill and instruction reads are blocked.",
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

class PiSkills {
  private contributedSkills: ReadonlySet<ResourcePath> = new Set();
  private resources: readonly ToggleResource[] = [];
  private readonly manualSkills = new Set<string>();
  private readonly reportStateFailure = createFailureReporter();
  private readonly reportPromptFailure = createFailureReporter();
  private sessionId: string | undefined;
  private parentId: string | undefined;
  private answering = false;
  private stateUnavailable = false;
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
        return [command.name.slice("skill:".length)];
      }),
    );
    const skillPaths = [
      ...(await discoverProjectSkillPaths(ctx.cwd, getAgentDir(), loadedNativeNames)),
    ];
    this.contributedSkills = new Set(skillPaths.map((path) => resourcePathId(path, ctx.cwd)));
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  }

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
        ? `pi-skills could not hide disabled ${result.unmatched.join(" and ")}: another extension may have changed the prompt.`
        : undefined,
    );
    return result.systemPrompt === event.systemPrompt
      ? undefined
      : { systemPrompt: result.systemPrompt };
  }

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
    const names = diagnosticText(blocked.join(", "));
    const it = blocked.length === 1 ? "it" : "them";
    if (this.stateUnavailable) {
      const is = blocked.length === 1 ? "is" : "are";
      return {
        block: true,
        reason: `pi-skills could not read its settings, so ${names} ${is} blocked for now.${shell ? " This command did not run." : ""} Continue without ${it}; the user has been told.`,
      };
    }
    return {
      block: true,
      reason: `${shell ? `This command reads ${names}, which the user disabled in /skills on purpose; it did not run.` : `The user disabled ${names} in /skills on purpose.`} Continue without ${it}, do not retry ${it} with any path or tool, and ask the user to re-enable ${it} only if you need ${it}.`,
    };
  }

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
      ctx.ui.notify("Usage: /skills", "error");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("`/skills` works only in the interactive TUI.", "error");
      return;
    }
    const loadedResources = toggleResources(ctx.getSystemPromptOptions(), this.contributedSkills);
    const resources = withNestedInstructions(
      loadedResources,
      await this.nestedInstructions(ctx.cwd, loadedResources),
    );
    if (resources.length === 0) {
      ctx.ui.notify("No instructions or skills that can be toggled are loaded.", "info");
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
    await ctx.ui.custom((tui, theme, keybindings, done) =>
      createContextMenu({
        resources,
        policy: () => policy,
        save: (id, value) => {
          const resource = resourcesById.get(id);
          if (resource === undefined) {
            return;
          }
          const stored = value === defaultToggleValue(resource) ? "default" : value;
          const saved = this.overridesFrom(
            "update",
            this.store.set(resource.id, stored, resource.origin),
            ctx,
          );
          if (saved !== undefined) {
            policy = new ResourcePolicy(saved);
          }
        },
        tui,
        theme,
        keybindings,
        done: () => {
          done();
        },
      }),
    );
  }

  private parentPolicy(): SessionPolicy | undefined {
    return this.parentId === undefined || this.parentId === this.sessionId
      ? undefined
      : sessionPolicy(this.parentId);
  }

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

  private ownMatch(
    ctx: UiContext | undefined,
    parent: SessionPolicy | undefined,
  ): (path: string) => string | undefined {
    const result = this.store.load();
    const loaded = ctx === undefined ? okValue(result) : this.overridesFrom("load", result, ctx);
    this.stateUnavailable = result._tag === "err";
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

  private guardMatch(ctx?: UiContext): (path: string) => string | undefined {
    const parent = this.parentPolicy();
    const own = this.ownMatch(ctx, parent);
    return parent === undefined ? own : (path) => parent.match(path) ?? own(path);
  }

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
    return event.toolName === "read" && isReadInput(event.input)
      ? [toolPath(event.input.path, ctx.cwd)]
      : [];
  }

  private subagentShellReads(event: GuardedToolCall, ctx: GuardContext): readonly string[] {
    return isShellInput(event.input) && isSubagentSession(ctx)
      ? pathsReadByCommand(event.input.command, ctx.cwd)
      : [];
  }

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
    const paths = [
      ...new Set(
        stdout
          .split("\0")
          .filter((path) => INSTRUCTION_FILE_NAMES.has(basename(path)))
          .map((path) => resourcePathId(path, root)),
      ),
    ];
    return Promise.all(
      paths
        .filter((id) => !known.has(id))
        .toSorted()
        .map(async (id): Promise<ToggleResource> => ({
          id,
          kind: "instruction",
          origin: "project",
          label: relative(root, id),
          description: await readInstructionHeading(id),
          editability: "editable",
        })),
    );
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

function disabledIds(
  loaded: ToggleOverrides,
  resources: readonly ToggleResource[],
): ReadonlySet<ResourcePath> {
  const policy = new ResourcePolicy(loaded);
  return new Set(
    resources.flatMap((resource) => (policy.value(resource) === "disabled" ? [resource.id] : [])),
  );
}

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
