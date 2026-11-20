import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DialogContext = Pick<ExtensionContext, "mode" | "hasUI" | "signal"> & {
  readonly ui: Pick<ExtensionContext["ui"], "select" | "input" | "notify">;
};
const timeout = 120_000;
function aborted(ctx: DialogContext): boolean {
  return ctx.signal?.aborted === true;
}

export function requireAttendedUI(ctx: DialogContext): void {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    throw new Error(
      "/peers setup and reset require TUI or attended RPC; print/JSON mutation is unsupported. No changes made.",
    );
  }
}

/** RPC responses are untrusted; a string outside the offered set is cancellation. */
export async function selectChoice(
  ctx: DialogContext,
  title: string,
  options: readonly string[],
): Promise<string | undefined> {
  requireAttendedUI(ctx);
  if (aborted(ctx)) {
    return undefined;
  }
  const answer = await ctx.ui.select(title, [...options], {
    timeout,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  return !aborted(ctx) && typeof answer === "string" && options.includes(answer)
    ? answer
    : undefined;
}
export async function inputChoice(
  ctx: DialogContext,
  title: string,
  placeholder: string,
): Promise<string | undefined> {
  requireAttendedUI(ctx);
  if (aborted(ctx)) {
    return undefined;
  }
  const answer = await ctx.ui.input(title, placeholder, {
    timeout,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  return !aborted(ctx) && typeof answer === "string" ? answer : undefined;
}
