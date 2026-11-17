import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { onOffCommand } from "../shared/on-off-command";
import type { OnOffCommand } from "../shared/on-off-command";
import { createHostAdapter } from "./host";

const WIDGET = "scrollback";

/** Minimal lifecycle and command surface, also usable by deterministic offline tests. */
export type ScrollRegistration = {
  on: (
    event: "session_start" | "session_shutdown",
    handler: (
      event: unknown,
      ctx: {
        mode: string;
        ui: {
          theme: ExtensionUIContext["theme"];
          setWidget: (key: string, content: Parameters<ExtensionUIContext["setWidget"]>[1]) => void;
        };
      },
    ) => void,
  ) => void;
  registerCommand: (name: string, options: OnOffCommand<ScrollCommandContext>) => void;
};

type ScrollContext = Parameters<Parameters<ScrollRegistration["on"]>[1]>[1];

/** Context the `/scrollback` command reads from Pi. */
export type ScrollCommandContext = {
  mode: string;
  ui: {
    theme: ExtensionUIContext["theme"];
    setWidget: (key: string, content: Parameters<ExtensionUIContext["setWidget"]>[1]) => void;
    notify: (message: string, type: "info" | "warning") => void;
  };
};

export default function scrollback(pi: ScrollRegistration): void {
  let enabled = true;
  let cleanup: (() => void) | undefined;

  const dispose = (): void => {
    cleanup?.();
    cleanup = undefined;
  };

  const install = (ctx: ScrollContext): void => {
    if (ctx.mode !== "tui") {
      return;
    }
    ctx.ui.setWidget(WIDGET, (tui) => {
      const adapter = createHostAdapter(tui, (text) =>
        ctx.ui.theme.bg("userMessageBg", ctx.ui.theme.fg("muted", text)),
      );
      cleanup = adapter.dispose;
      return adapter;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    dispose();
    if (enabled) {
      install(ctx);
    }
  });
  pi.on("session_shutdown", dispose);

  pi.registerCommand(
    "scrollback",
    onOffCommand<ScrollCommandContext>({
      name: "scrollback",
      label: "Scrollback",
      description: "Turn the scrollback prompt row on or off for this session",
      enabled: () => enabled,
      apply: (next, ctx) => {
        if (next === enabled) {
          return;
        }
        enabled = next;
        dispose();
        if (enabled) {
          install(ctx);
        } else {
          ctx.ui.setWidget(WIDGET, undefined);
        }
      },
    }),
  );
}
