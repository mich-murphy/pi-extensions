import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { discoverProjectSkillPaths } from "./project-skill-paths";
import { hideResources } from "./prompt-filter";
import { type ResourcePath, resourcePathId } from "./resource-path";
import {
  defaultToggleValue,
  isToggleValue,
  type ToggleOverrides,
  type ToggleResource,
  toggleResources,
  toggleValue,
} from "./resources";
import { ToggleStateFile, type ToggleStateResult, type ToggleStateStore } from "./state";

/** Register the skill-toggle extension with its default persistent store. */
export default function skillToggle(pi: ExtensionAPI): void {
  registerSkillToggle(pi, new ToggleStateFile());
}

/** Register the skill-toggle command and event handlers with an injected store. */
export function registerSkillToggle(pi: ExtensionAPI, store: ToggleStateStore): void {
  const extension = new SkillToggle(store);
  pi.registerCommand("skill-toggle", {
    description: "Enable or disable user-managed instructions and skills",
    handler: (args, ctx) => extension.openMenu(args, ctx),
  });
  pi.on("resources_discover", (_event, ctx) => extension.contributeProjectSkills(ctx));
  pi.on("before_agent_start", (event, ctx) => extension.filterPrompt(event, ctx));
}

type UiContext = Pick<ExtensionContext, "ui">;

const STATE_FAILURE_CONSEQUENCE = {
  load: "The prompt was left unchanged.",
  update: "The toggle was not saved.",
} as const;

/** Report a failure once until it changes or clears, so it does not repeat on every prompt. */
function createFailureReporter(): (ctx: UiContext, failure: string | undefined) => void {
  let lastFailure: string | undefined;
  return (ctx, failure) => {
    if (failure !== undefined && failure !== lastFailure) ctx.ui.notify(failure, "error");
    lastFailure = failure;
  };
}

/** Session state shared by the command and event handlers. */
class SkillToggle {
  private contributedSkills: ReadonlySet<ResourcePath> = new Set();
  private readonly reportStateFailure = createFailureReporter();
  private readonly reportPromptFailure = createFailureReporter();

  constructor(private readonly store: ToggleStateStore) {}

  contributeProjectSkills(
    ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  ): { skillPaths: string[] } | undefined {
    const skillPaths = ctx.isProjectTrusted() ? [...discoverProjectSkillPaths(ctx.cwd)] : [];
    this.contributedSkills = new Set(skillPaths.map((path) => resourcePathId(path, ctx.cwd)));
    return skillPaths.length > 0 ? { skillPaths } : undefined;
  }

  filterPrompt(
    event: Pick<BeforeAgentStartEvent, "systemPrompt" | "systemPromptOptions">,
    ctx: UiContext,
  ): { systemPrompt: string } | undefined {
    const options = event.systemPromptOptions;
    const overrides = this.overridesFrom(this.store.load(), ctx);
    if (!overrides) return;
    const hidden = new Set<ResourcePath>(
      toggleResources(options, this.contributedSkills)
        .filter((resource) => toggleValue(overrides, resource) === "disabled")
        .map((resource) => resource.id),
    );
    if (hidden.size === 0) return;

    const result = hideResources(event, (path) => hidden.has(resourcePathId(path, options.cwd)));
    if (result._tag === "options-filtered") return;
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

  async openMenu(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (args.trim()) {
      ctx.ui.notify("Usage: /skill-toggle", "error");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/skill-toggle requires TUI mode", "error");
      return;
    }
    const resources = toggleResources(ctx.getSystemPromptOptions(), this.contributedSkills);
    if (resources.length === 0) {
      ctx.ui.notify("No user-managed instructions or skills are loaded", "info");
      return;
    }
    const loaded = this.overridesFrom(this.store.load(), ctx);
    if (!loaded) return;
    let overrides = loaded;

    const resourcesById = new Map<string, ToggleResource>(
      resources.map((resource) => [resource.id, resource]),
    );
    // Rows without `values` cannot be changed, which keeps manual-only skills read-only.
    const items = resources.map<SettingItem>((resource) => ({
      id: resource.id,
      label: `[${resource.origin}] ${resource.label}`,
      description: resource.description,
      ...(resource.editability === "editable"
        ? { currentValue: toggleValue(loaded, resource), values: ["enabled", "disabled"] }
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
          if (!(resource && isToggleValue(value))) return;
          const saved = this.overridesFrom(
            this.store.set(resource.id, value === defaultToggleValue(resource) ? "default" : value),
            ctx,
          );
          if (saved) overrides = saved;
          else list.updateValue(id, toggleValue(overrides, resource));
        },
        () => done(undefined),
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

  /** Unwrap a state result, surfacing a failure to the user once. */
  private overridesFrom(result: ToggleStateResult, ctx: UiContext): ToggleOverrides | undefined {
    if (result._tag === "ok") {
      this.reportStateFailure(ctx, undefined);
      return result.value;
    }
    const consequence = STATE_FAILURE_CONSEQUENCE[result.error.operation];
    this.reportStateFailure(ctx, `${result.error.message}\n${consequence}`);
    return undefined;
  }
}
