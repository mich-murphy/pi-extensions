import { visibleText } from "../../adapter/config.js";
import { pathError, sha256Error } from "../remote.js";
import type { Row, Saved, Screen } from "./model.js";
import type { Outcome, Step } from "./progress.js";

export type Progress = (
  title: string,
  planned: readonly string[],
  work: (step: Step) => Promise<Outcome>,
  result?: string,
  kind?: "reconnect",
) => void;

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

export function opener(id: string, label: string, description: string, screen: () => Screen): Row {
  return { id, label, value: "", description, activation: { kind: "open", screen } };
}

export type TextField = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
  readonly get: () => string;
  readonly save: (value: string) => Saved | Promise<Saved>;
};

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

export function validated(
  validate: (value: string) => string | undefined,
  set: (value: string) => void,
): (value: string) => Saved {
  return (value) => {
    const error = validate(value);

    if (error === undefined) {
      set(value);
    }

    return error === undefined ? undefined : { error };
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
  readonly action: string;
  readonly gate: Gate<T>;
  readonly description: string;
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

export function actionForm<T>(form: ActionForm<T>): Screen {
  type Heading = Pick<Extract<Screen, { kind: "list" }>, "kind" | "title"> & { note?: string };

  const heading: Heading = { kind: "list", title: form.title };

  if (form.note !== undefined) {
    heading.note = form.note;
  }

  return {
    ...heading,
    rows: () => [
      ...(form.rows?.() ?? []),
      detailsRow(form.details, form.detailsDescription),
      consentRow(form.consent()),
    ],
  };
}

export function withTechnical(lines: readonly string[], technical: readonly string[]): string[] {
  return technical.length === 0
    ? [...lines]
    : [...lines, "Technical details:", ...technical.map((line) => `  ${line}`)];
}

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
