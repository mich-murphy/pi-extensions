import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";

export type DialogContext = Pick<ExtensionContext, "mode" | "hasUI" | "signal"> & {
  readonly ui: Pick<ExtensionContext["ui"], "select" | "input" | "notify">;
};

const isAnswer = Schema.is(Schema.String);
const timeout = 120_000;

function aborted(ctx: DialogContext): boolean {
  return ctx.signal?.aborted === true;
}

function dialogOptions(signal: AbortSignal | undefined): ExtensionUIDialogOptions {
  const options: ExtensionUIDialogOptions = { timeout };

  if (signal !== undefined) {
    options.signal = signal;
  }

  return options;
}

export function requireAttendedUI(ctx: DialogContext): void {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    throw new Error("Setup and reset need the TUI or attended RPC. Nothing was changed.");
  }
}

export async function selectChoice(
  ctx: DialogContext,
  title: string,
  options: readonly string[],
): Promise<string | undefined> {
  requireAttendedUI(ctx);

  if (aborted(ctx)) {
    return undefined;
  }

  const answer = await ctx.ui.select(title, [...options], dialogOptions(ctx.signal));

  return !aborted(ctx) && isAnswer(answer) && options.includes(answer) ? answer : undefined;
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

  const answer = await ctx.ui.input(title, placeholder, dialogOptions(ctx.signal));

  return !aborted(ctx) && isAnswer(answer) ? answer : undefined;
}
