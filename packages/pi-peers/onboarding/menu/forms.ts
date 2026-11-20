import { visibleText } from "../../adapter/config.js";
import { pathError, sha256Error } from "../remote.js";
import type { Row, Saved, Screen } from "./model.js";
import type { Outcome, Step } from "./progress.js";

/**
 * Runs one consented effect under a progress view titled `title`, then shows its outcome titled
 * `result` (default `Result`). Both are breadcrumb segments below the screen that started it.
 */
export type Progress = (
  title: string,
  planned: readonly string[],
  work: (step: Step) => Promise<Outcome>,
  result?: string,
  /** What the footer shows while it runs; a reconnect that writes nothing passes `reconnect`. */
  kind?: "reconnect",
) => void;

/**
 * The state of a consent row. Only `ready` carries a value, and only a ready row is a consent
 * row; every other state shows its reason on the row and runs nothing.
 */
export type Gate<T> =
  | { readonly kind: "ready"; readonly value: T }
  | { readonly kind: "missing" | "invalid" | "blocked"; readonly reason: string }
  | { readonly kind: "unchanged" };

export const BLOCKED_HELP =
  "No verified gateway download for this platform. See the pi-peers README for manual setup.";

const PREFIX = { missing: "Missing", invalid: "Invalid", blocked: "Blocked" } as const;

export function gateText<T>(gate: Gate<T>): string {
  if (gate.kind === "ready") {
    return "Ready";
  }
  return gate.kind === "unchanged" ? "No changes" : `${PREFIX[gate.kind]}: ${gate.reason}`;
}

export function report(title: string, lines: () => readonly string[]): Screen {
  return { kind: "report", title, lines };
}

/** A read-only `Review details` row. */
export function detailsRow(
  lines: () => readonly string[],
  description = "Everything Apply will download, write and start.",
): Row {
  return {
    id: "review",
    label: "Review details",
    value: "",
    description,
    activation: { kind: "open", screen: () => report("Details", lines) },
  };
}

/** A row that opens a sub-screen. */
export function opener(id: string, label: string, description: string, screen: () => Screen): Row {
  return { id, label, value: "", description, activation: { kind: "open", screen } };
}

export type TextField = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
  readonly get: () => string;
  /**
   * Saves a valid value and returns undefined, or returns an inline error. An asynchronous save
   * returns a commit function instead, applied only if its editor is still open.
   */
  readonly save: (value: string) => Saved | Promise<Saved>;
};

/** A row edited in place by a text editor; an empty value shows `Required`. */
export function textField(field: TextField): Row {
  const current = field.get();
  return {
    id: field.id,
    label: field.label,
    value: current === "" ? "Required" : visibleText(current),
    description: field.description,
    activation: {
      kind: "open",
      screen: () => ({
        kind: "text",
        title: field.label,
        description: field.description,
        value: field.get,
        placeholder: field.placeholder,
        save: field.save,
      }),
    },
  };
}

/** Saves `value` with `set` when `validate` accepts it. */
export function validated(
  validate: (value: string) => string | undefined,
  set: (value: string) => void,
): (value: string) => string | undefined {
  return (value) => {
    const error = validate(value);
    if (error === undefined) {
      set(value);
    }
    return error;
  };
}

export type CycleField<T extends string> = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly options: readonly (readonly [T, string])[];
  readonly get: () => T;
  readonly set: (value: T) => void;
};

/** A row whose Enter cycles through a few named values. */
export function cycleField<T extends string>(field: CycleField<T>): Row {
  const index = Math.max(
    0,
    field.options.findIndex(([value]) => value === field.get()),
  );
  return {
    id: field.id,
    label: field.label,
    value: field.options[index]?.[1] ?? "",
    description: field.description,
    activation: {
      kind: "cycle",
      next: () => {
        const next = field.options[(index + 1) % field.options.length];
        if (next !== undefined) {
          field.set(next[0]);
        }
      },
    },
  };
}

export type ConsentSpec<T> = {
  readonly id?: string;
  readonly label: string;
  /** The consent seam's action name. */
  readonly action: string;
  readonly gate: Gate<T>;
  /** Shown when ready. */
  readonly description: string;
  /** Shown when blocked. */
  readonly blockedHelp?: string;
  readonly run: (value: T) => void;
};

function gateDescription<T>(spec: ConsentSpec<T>): string {
  const { gate } = spec;
  if (gate.kind === "ready") {
    return spec.description;
  }
  if (gate.kind === "missing") {
    return `Fill in ${gate.reason} above first.`;
  }
  if (gate.kind === "blocked") {
    return spec.blockedHelp ?? "This can't run here; the reason is shown.";
  }
  return gate.kind === "unchanged"
    ? "Change a setting above first."
    : "Fix the setting shown above first.";
}

/** The one explicit consent row of a screen; it consents only when its gate is ready. */
export function consentRow<T>(spec: ConsentSpec<T>): Row {
  const { gate } = spec;
  return {
    id: spec.id ?? "apply",
    label: spec.label,
    value: gateText(gate),
    description: gateDescription(spec),
    activation:
      gate.kind === "ready"
        ? {
            kind: "consent",
            action: spec.action,
            run: () => {
              spec.run(gate.value);
            },
          }
        : { kind: "none" },
  };
}

/** The first empty required field, as a `missing` gate. */
export function missingField(
  fields: readonly (readonly [label: string, value: string])[],
): Gate<never> | undefined {
  const absent = fields.find(([, value]) => value === "")?.[0];
  return absent === undefined ? undefined : { kind: "missing", reason: absent };
}

export type ActionForm<T> = {
  readonly title: string;
  readonly note?: string;
  readonly rows?: () => readonly Row[];
  readonly details: () => readonly string[];
  readonly detailsDescription?: string;
  readonly consent: () => ConsentSpec<T>;
};

/** A list screen: optional editable rows, then Review details, then its one consent row. */
export function actionForm<T>(form: ActionForm<T>): Screen {
  return {
    kind: "list",
    title: form.title,
    ...(form.note === undefined ? {} : { note: form.note }),
    rows: () => [
      ...(form.rows?.() ?? []),
      detailsRow(form.details, form.detailsDescription),
      consentRow(form.consent()),
    ],
  };
}

/** Plain lines, then internals under a `Technical details:` heading. */
export function withTechnical(lines: readonly string[], technical: readonly string[]): string[] {
  return technical.length === 0
    ? [...lines]
    : [...lines, "Technical details:", ...technical.map((line) => `  ${line}`)];
}

/** A required absolute-path row. */
export function pathField(
  id: string,
  label: string,
  description: string,
  value: { readonly get: () => string; readonly set: (value: string) => void },
  placeholder = "/absolute/path",
): Row {
  return textField({
    id,
    label,
    description,
    placeholder,
    get: value.get,
    save: validated(pathError, value.set),
  });
}

/** A required full-SHA256 row, confirmed through a separate trusted channel. */
export function hashField(
  id: string,
  label: string,
  description: string,
  value: { readonly get: () => string; readonly set: (value: string) => void },
): Row {
  return textField({
    id,
    label,
    description,
    placeholder: "64 lowercase hex characters",
    get: value.get,
    save: validated(sha256Error, value.set),
  });
}
