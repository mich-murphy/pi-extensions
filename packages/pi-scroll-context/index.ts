import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createHostAdapter } from "./host";

/** Minimal lifecycle surface, also usable by deterministic offline tests. */
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
};

export default function scrollContext(pi: ScrollRegistration): void {
  let cleanup: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    cleanup?.();
    if (ctx.mode !== "tui") {
      return;
    }
    ctx.ui.setWidget("pi-scroll-context", (tui) => {
      const adapter = createHostAdapter(tui, (text) =>
        ctx.ui.theme.bg("userMessageBg", ctx.ui.theme.fg("muted", text)),
      );
      cleanup = adapter.dispose;
      return adapter;
    });
  });
  pi.on("session_shutdown", () => {
    cleanup?.();
    cleanup = undefined;
  });
}
