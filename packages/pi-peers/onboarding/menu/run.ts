import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DialogContext } from "../dialog.js";
import type { MenuModel } from "./model.js";
import { driveRpc } from "./rpc.js";
import { PeersMenu } from "./tui.js";

export type MenuContext = DialogContext & {
  readonly ui: DialogContext["ui"] & Partial<Pick<ExtensionContext["ui"], "custom">>;
};

export async function runMenu(
  ctx: MenuContext,
  model: MenuModel,
  cancelled?: () => void,
): Promise<void> {
  const abort = (): void => {
    model.close();
    model.refresh();
  };
  ctx.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (ctx.mode === "tui" && ctx.ui.custom !== undefined) {
      await ctx.ui.custom<undefined>(
        (tui, theme, keybindings, done) =>
          new PeersMenu(model, {
            tui,
            theme,
            keybindings,
            done: () => {
              done(undefined);
            },
          }),
        { blocked: { kind: "question", message: "Peers" } },
      );
    } else {
      await driveRpc(model, ctx);
    }
  } finally {
    ctx.signal?.removeEventListener("abort", abort);
  }
  if (ctx.mode !== "tui" && !model.acted) {
    cancelled?.();
  }
}
