import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type OnOffContext = {
  readonly ui: { readonly notify: (message: string, type: "info" | "warning") => void };
};

export type OnOffOptions<C extends OnOffContext> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: () => boolean;
  readonly apply: (enabled: boolean, ctx: C) => void;
  readonly note?: (enabled: boolean) => string;
};

export type OnOffCommand<C extends OnOffContext> = {
  readonly description: string;
  readonly getArgumentCompletions: (prefix: string) => AutocompleteItem[];
  readonly handler: (args: string, ctx: C) => Promise<void>;
};

export function onOffCommand<C extends OnOffContext>(options: OnOffOptions<C>): OnOffCommand<C> {
  return {
    description: options.description,
    getArgumentCompletions: (prefix) =>
      ["on", "off"].flatMap((value) => (value.startsWith(prefix) ? [{ value, label: value }] : [])),
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
