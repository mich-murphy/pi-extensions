import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { applyResourceToggles } from "./prompt-filter";
import { type ResourcePath, resourcePathId } from "./resource-path";
import { type ToggleResource, toggleResourcesFromPrompt } from "./resources";
import {
  type SkillToggleState,
  type SkillToggleStateResult,
  type SkillToggleStateStore,
  SkillToggleStore,
} from "./state";

/** Register the skill-toggle extension with its default persistent store. */
export default function skillToggle(pi: ExtensionAPI): void {
  registerSkillToggle(pi, new SkillToggleStore());
}

/** Register the skill-toggle command and prompt handler with an injected store. */
export function registerSkillToggle(pi: ExtensionAPI, store: SkillToggleStateStore): void {
  const stateAccess = createStateAccess(store);
  pi.registerCommand("skill-toggle", {
    description: "Enable or disable user-managed instructions and skills",
    handler: (args, ctx) => runToggleCommand(args, ctx, store, stateAccess),
  });
  registerPromptHandler(pi, stateAccess);
}

interface StateAccess {
  load(
    resources: ReadonlyArray<ToggleResource>,
    ctx: Pick<ExtensionCommandContext, "ui">,
  ): SkillToggleState | undefined;
  report(
    result: Extract<SkillToggleStateResult, { readonly _tag: "err" }>,
    ctx: Pick<ExtensionCommandContext, "ui">,
  ): void;
  clearFailure(): void;
}

function createStateAccess(store: SkillToggleStateStore): StateAccess {
  let lastFailure = "";
  const report: StateAccess["report"] = (result, ctx) => {
    if (result.error.message !== lastFailure) {
      ctx.ui.notify(`${result.error.message}\nThe prompt was left unchanged.`, "error");
    }
    lastFailure = result.error.message;
  };
  return {
    load: (resources, ctx) => {
      const result = store.load(resources);
      if (result._tag === "err") {
        report(result, ctx);
        return;
      }
      lastFailure = "";
      return result.value;
    },
    report,
    clearFailure: () => {
      lastFailure = "";
    },
  };
}

// fallow-ignore-next-line complexity -- Command validation branches are explicit user-facing outcomes.
async function runToggleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  store: SkillToggleStateStore,
  stateAccess: StateAccess,
): Promise<void> {
  if (args.trim()) {
    ctx.ui.notify("Usage: /skill-toggle", "error");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/skill-toggle requires TUI mode", "error");
    return;
  }
  const resources = toggleResourcesFromPrompt(ctx.getSystemPromptOptions());
  if (resources.length === 0) {
    ctx.ui.notify("No user-managed instructions or skills are loaded", "info");
    return;
  }
  const state = stateAccess.load(resources, ctx);
  if (state) await openToggleDialog({ ctx, resources, state, store, stateAccess });
}

interface ToggleDialogOptions {
  readonly ctx: ExtensionCommandContext;
  readonly resources: ReadonlyArray<ToggleResource>;
  readonly state: SkillToggleState;
  readonly store: SkillToggleStateStore;
  readonly stateAccess: StateAccess;
}

interface ToggleSession {
  state: SkillToggleState;
  readonly resources: ReadonlyArray<ToggleResource>;
  readonly resourcesById: ReadonlyMap<string, ToggleResource>;
  readonly itemsById: ReadonlyMap<string, SettingItem>;
  readonly ctx: ExtensionCommandContext;
  readonly store: SkillToggleStateStore;
  readonly stateAccess: StateAccess;
}

async function openToggleDialog(options: ToggleDialogOptions): Promise<void> {
  const { ctx, resources, state, store, stateAccess } = options;
  const items = buildSettingItems(resources, state);
  const session: ToggleSession = {
    state,
    resources,
    resourcesById: new Map(resources.map((resource) => [resource.id, resource])),
    itemsById: new Map(items.map((item) => [item.id, item])),
    ctx,
    store,
    stateAccess,
  };
  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const container = new Container();
    const title = new Text("", 1, 0);
    const help = new Text("", 1, 0);
    const updateText = (): void => {
      title.setText(theme.fg("accent", theme.bold("Skill Toggle")));
      help.setText(theme.fg("dim", "enter/space toggle · type to search · esc close"));
    };
    updateText();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(title);
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 20),
      getSettingsListTheme(),
      createToggleHandler(session),
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(help);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => {
        updateText();
        container.invalidate();
      },
      handleInput: (data: string) => {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

function isToggleValue(value: string): value is "enabled" | "disabled" {
  return value === "enabled" || value === "disabled";
}

function createToggleHandler(session: ToggleSession): (id: string, value: string) => void {
  // fallow-ignore-next-line complexity -- The UI callback keeps validation, persistence, and rollback atomic.
  return (id, value) => {
    const resource = session.resourcesById.get(id);
    const item = session.itemsById.get(id);
    if (!(resource && item) || resource.editability === "manual-only") return;
    const previousValue = Object.hasOwn(session.state.resources, id) ? "disabled" : "enabled";
    if (!isToggleValue(value)) {
      item.currentValue = previousValue;
      session.ctx.ui.notify(`Unsupported toggle value: ${value}`, "error");
      return;
    }
    const result = session.store.setValue(resource, value, session.resources);
    if (result._tag === "err") {
      item.currentValue = previousValue;
      session.stateAccess.report(result, session.ctx);
      return;
    }
    session.state = result.value;
    session.stateAccess.clearFailure();
  };
}

function registerPromptHandler(pi: ExtensionAPI, stateAccess: StateAccess): void {
  let lastPromptFailure = "";
  pi.on("before_agent_start", (event, ctx) => {
    const resources = toggleResourcesFromPrompt(event.systemPromptOptions);
    const state = stateAccess.load(resources, ctx);
    if (!state) return;
    const eligiblePaths = new Set<string>(resources.map((resource) => resource.id));
    const disabledPaths = new Set<ResourcePath>(
      Object.keys(state.resources)
        .filter((path) => eligiblePaths.has(path))
        .map((path) => resourcePathId(path)),
    );
    const result = applyResourceToggles(
      event.systemPrompt,
      event.systemPromptOptions,
      disabledPaths,
    );
    const failure = result.failures.join(",");
    if (failure && failure !== lastPromptFailure) {
      ctx.ui.notify(
        `Skill toggle could not update the ${result.failures.join(" and ")} prompt section. Pi's prompt format may have changed.`,
        "error",
      );
    }
    lastPromptFailure = failure;
    return { systemPrompt: result.systemPrompt };
  });
}

function buildSettingItems(
  resources: ReadonlyArray<ToggleResource>,
  state: SkillToggleState,
): SettingItem[] {
  return resources.map((resource) => ({
    id: resource.id,
    label: `[${resource.origin}] ${resource.label}`,
    description: resource.description,
    currentValue:
      resource.editability === "manual-only"
        ? "manual only"
        : Object.hasOwn(state.resources, resource.id)
          ? "disabled"
          : "enabled",
    ...(resource.editability === "manual-only" ? {} : { values: ["enabled", "disabled"] }),
  }));
}
