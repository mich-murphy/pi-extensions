import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleText } from "../adapter/config.js";
import { localPlan, localReview, permissions } from "./plan.js";
import type { LocalChoices, LocalPlan } from "./plan.js";

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
      "/comms setup and reset require TUI or attended RPC; print/JSON mutation is unsupported. No changes made.",
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

export async function chooseIntent(ctx: DialogContext): Promise<"local" | "remote" | undefined> {
  const answer = await selectChoice(ctx, "Collaboration setup — enabled only after final Apply", [
    "Local only — no remote connections (recommended)",
    "Configure one remote peer",
    "Cancel",
  ]);
  if (answer === "Local only — no remote connections (recommended)") {
    return "local";
  }
  if (answer === "Configure one remote peer") {
    return "remote";
  }
  return undefined;
}
export async function chooseRemoteTrust(
  ctx: DialogContext,
): Promise<"existing" | "create" | "join" | undefined> {
  const options = [
    "Use existing trust material",
    "Create a new trusted pair",
    "Join a new trusted pair",
    "Cancel",
  ];
  const answer = await selectChoice(
    ctx,
    "One authenticated remote peer — never paste keys or secrets here",
    options,
  );
  if (answer === options[0]) {
    return "existing";
  }
  if (answer === options[1]) {
    return "create";
  }
  if (answer === options[2]) {
    return "join";
  }
  return undefined;
}

async function editChoices(
  ctx: DialogContext,
  choices: LocalChoices,
): Promise<LocalChoices | undefined> {
  const field = await selectChoice(ctx, "Edit inferred choices", [
    "Machine identity",
    "Scope",
    "Session label",
    "Permissions",
    "Back",
  ]);
  if (field === undefined) {
    return undefined;
  }
  if (field === "Back") {
    return choices;
  }
  if (field === "Permissions") {
    return editPermissions(ctx, choices);
  }
  let key: "machineId" | "scopeId" | "label" = "label";
  if (field === "Machine identity") {
    key = "machineId";
  } else if (field === "Scope") {
    key = "scopeId";
  }
  const value = await inputChoice(
    ctx,
    `New ${field.toLowerCase()} (Escape cancels; placeholder is not prefilled)`,
    choices[key],
  );
  return value === undefined ? undefined : { ...choices, [key]: value };
}

async function editPermissions(
  ctx: DialogContext,
  choices: LocalChoices,
): Promise<LocalChoices | undefined> {
  const selected = new Set(choices.permissions);
  for (const permission of permissions) {
    // eslint-disable-next-line eslint/no-await-in-loop -- Native consent dialogs must remain sequential; cancellation stops subsequent questions.
    const answer = await selectChoice(
      ctx,
      `${permission}: currently ${selected.has(permission) ? "on" : "off"}`,
      ["Allow", "Deny", "Cancel"],
    );
    if (answer === undefined || answer === "Cancel") {
      return undefined;
    }
    if (answer === "Allow") {
      selected.add(permission);
    } else {
      selected.delete(permission);
    }
  }
  return {
    ...choices,
    permissions: permissions.filter((permission) => selected.has(permission)),
  };
}

/** Returns consented data only. The caller owns inspection, CAS and all post-Apply effects.
 * effectReview must enumerate actual verified acquisition/version/paths/service effects.
 * Do not call this with a speculative backend plan.
 */
export async function reviewLocal(
  ctx: DialogContext,
  initial: LocalChoices,
  socketPath: string,
  effectReview: (plan: LocalPlan) => string,
  remote = false,
  effectSummary = "Full source, private paths and recovery: Review details",
): Promise<LocalPlan | undefined> {
  requireAttendedUI(ctx);
  let choices: LocalChoices | undefined = initial;
  while (choices !== undefined) {
    const plan = checkedPlan(ctx, choices, socketPath);
    if (plan === undefined) {
      // eslint-disable-next-line eslint/no-await-in-loop -- Each native edit must finish before the next review; cancellation stops the flow.
      choices = await editChoices(ctx, choices);
      continue;
    }
    const review = `${localReview(plan, remote)}\n${effectReview(plan)}`;
    const compact = [
      `Enable ${short(plan.adapter.machineId)} / ${short(plan.choices.scopeId)} / ${short(plan.adapter.label)}`,
      `Grants: ${plan.choices.permissions.join("/") || "none"}`,
      "ALL projects on this OS account; published records only.",
      "Untrusted messages may wake model + provider cost.",
      "Shared detached gateway: first Pi starts, last closes.",
      effectSummary,
      "Exact source, paths and recovery: Review details.",
    ].join("\n");
    // eslint-disable-next-line eslint/no-await-in-loop -- Each native review must finish before subsequent editing/detail UI.
    const answer = await selectChoice(ctx, compact, [
      "Cancel — no changes",
      "Edit choices",
      "Review details",
      "Apply — perform the listed changes and enable participation",
    ]);
    if (answer === "Apply — perform the listed changes and enable participation") {
      return plan;
    }
    // eslint-disable-next-line eslint/no-await-in-loop -- Sequential native dialog decisions preserve cancellation and one final Apply.
    choices = await amendReview(ctx, answer, choices, review);
  }
  return undefined;
}
function checkedPlan(
  ctx: DialogContext,
  choices: LocalChoices,
  socketPath: string,
): LocalPlan | undefined {
  try {
    return localPlan(choices, socketPath);
  } catch {
    ctx.ui.notify(
      "Invalid choices: machine must be lowercase letter-led (max 32), scope 1–64 identifier characters, label 1–128 UTF-8 bytes without controls, socket absolute and at most 100 bytes.",
      "warning",
    );
    return undefined;
  }
}
async function amendReview(
  ctx: DialogContext,
  answer: string | undefined,
  choices: LocalChoices,
  review: string,
): Promise<LocalChoices | undefined> {
  if (answer === "Edit choices") {
    return editChoices(ctx, choices);
  }
  if (answer === "Review details" && (await reviewDetails(ctx, review))) {
    return choices;
  }
  return undefined;
}

function short(value: string): string {
  const visible = visibleText(value);
  return visible.length > 18 ? `${visible.slice(0, 17)}…` : visible;
}
async function reviewDetails(ctx: DialogContext, review: string): Promise<boolean> {
  const lines = review.split("\n").flatMap((line) => line.match(/.{1,48}/gu) ?? [""]);
  const count = Math.ceil(lines.length / 8);
  let page = 0;
  for (;;) {
    // eslint-disable-next-line eslint/no-await-in-loop -- Native consent dialogs must remain sequential; cancellation stops subsequent questions.
    const answer = await selectChoice(
      ctx,
      `Plan details ${page + 1}/${count}\n${lines.slice(page * 8, (page + 1) * 8).join("\n")}`,
      [
        "Back to review",
        ...(page + 1 < count ? ["Next details"] : []),
        ...(page > 0 ? ["Previous details"] : []),
        "Cancel — no changes",
      ],
    );
    if (answer === "Back to review") {
      return true;
    }
    if (answer === "Next details") {
      page += 1;
    } else if (answer === "Previous details") {
      page -= 1;
    } else {
      return false;
    }
  }
}

/** One explicit Apply, with optional bounded native detail pages on narrow terminals. */
export async function reviewAction(
  ctx: DialogContext,
  summary: string,
  details: string,
  apply: string,
): Promise<boolean> {
  for (;;) {
    // eslint-disable-next-line eslint/no-await-in-loop -- Native consent dialogs must remain sequential; cancellation stops subsequent questions.
    const answer = await selectChoice(ctx, summary, [
      "Cancel — no changes",
      "Review details",
      apply,
    ]);
    if (answer === apply) {
      return true;
    }
    // eslint-disable-next-line eslint/no-await-in-loop -- Native consent dialogs must remain sequential; cancellation stops subsequent questions.
    if (answer !== "Review details" || !(await reviewDetails(ctx, details))) {
      return false;
    }
  }
}
