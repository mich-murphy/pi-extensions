import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Context capabilities an on/off command needs. */
export type OnOffContext = {
  readonly ui: { readonly notify: (message: string, type: "info" | "warning") => void };
};

/** Options for a `/<name> [on|off]` command. */
export type OnOffOptions<C extends OnOffContext> = {
  /** Command name without the slash. */
  readonly name: string;
  /** Name shown in the confirmation, such as `Vim`. */
  readonly label: string;
  readonly description: string;
  /** Current session state. */
  readonly enabled: () => boolean;
  /** Apply the requested state; called before the confirmation is shown. */
  readonly apply: (enabled: boolean, ctx: C) => void;
  /** Extra text appended to the confirmation. */
  readonly note?: (enabled: boolean) => string;
};

/** Registration options Pi accepts for an on/off command. */
export type OnOffCommand<C extends OnOffContext> = {
  readonly description: string;
  readonly getArgumentCompletions: (prefix: string) => AutocompleteItem[];
  readonly handler: (args: string, ctx: C) => Promise<void>;
};

/**
 * Build a session-scoped `/<name> [on|off]` command.
 *
 * No argument toggles; `on` and `off` set the state; anything else warns with the usage and
 * changes nothing. Each change is confirmed as `<label> is on|off for this session.`
 */
export function onOffCommand<C extends OnOffContext>(options: OnOffOptions<C>): OnOffCommand<C> {
  return {
    description: options.description,
    getArgumentCompletions: (prefix) =>
      ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const choice = args.trim();
      if (choice !== "" && choice !== "on" && choice !== "off") {
        ctx.ui.notify(`Usage: /${options.name} [on|off]`, "warning");
        return;
      }
      const enabled = choice === "" ? !options.enabled() : choice === "on";
      options.apply(enabled, ctx);
      const note = options.note?.(enabled) ?? "";
      ctx.ui.notify(
        `${options.label} is ${enabled ? "on" : "off"} for this session.${note}`,
        "info",
      );
    },
  };
}
