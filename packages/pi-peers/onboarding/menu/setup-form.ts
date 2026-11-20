import { isAbsolute, normalize } from "node:path";
import { visibleText } from "../../adapter/config.js";
import { localPlan, permissions } from "../plan.js";
import type { LocalChoices, LocalPlan } from "../plan.js";
import type { RemoteIntent } from "../remote.js";
import {
  BLOCKED_HELP,
  consentRow,
  cycleField,
  detailsRow,
  gateText,
  textField,
  validated,
} from "./forms.js";
import type { Gate } from "./forms.js";
import type { Row, Screen } from "./model.js";
import { remoteGate, remoteRows } from "./remote-form.js";
import type { RemoteDraft } from "./remote-form.js";

/** Editable fresh-setup state. Nothing here has effects; Apply receives a rebuilt, validated plan. */
export type SetupDraft = {
  mode: "local" | "remote";
  choices: LocalChoices;
  socket: string;
  /** True when the default socket exceeds 100 bytes, so the user must choose one. */
  socketRequired: boolean;
  /** Whether a shared gateway was seen live on the reviewed socket (read-only observation). */
  shared: boolean;
  remote: RemoteDraft;
};

/** What Apply receives: the rebuilt local plan and, in remote mode, the checked remote intent. */
export type SetupChoice = {
  readonly plan: LocalPlan;
  readonly remote?: RemoteIntent;
  /** The shared-gateway observation the review disclosed; Apply refuses if it changed. */
  readonly shared: boolean;
};

export type SetupFormOptions = {
  readonly draft: SetupDraft;
  /** Short acquisition-blocked reason for local mode; when set, Apply is never offered as consent. */
  readonly blocked?: string;
  /** The same for remote mode, which needs pairing capabilities. */
  readonly remoteBlocked?: string;
  readonly details: (choice: SetupChoice) => string;
  readonly apply: (choice: SetupChoice) => void;
  /** Read-only: is a shared gateway live on this socket? */
  readonly probe?: (socket: string) => Promise<boolean>;
};

type Field = "machineId" | "scopeId" | "label";

function validateField(field: Field, value: string): string | undefined {
  if (field === "machineId") {
    return /^[a-z][a-z0-9-]{0,31}$/u.test(value)
      ? undefined
      : "Use lowercase letters, digits and dashes, starting with a letter (at most 32).";
  }
  if (field === "scopeId") {
    return /^[A-Za-z0-9_-]{1,64}$/u.test(value)
      ? undefined
      : "Use 1–64 letters, digits, dashes or underscores.";
  }
  return value !== "" &&
    Buffer.byteLength(value) <= 128 &&
    visibleText(value) === value &&
    !/\p{Cc}/u.test(value)
    ? undefined
    : "Use 1–128 bytes of visible text.";
}

function validateSocket(value: string): string | undefined {
  return isAbsolute(value) &&
    normalize(value) === value &&
    Buffer.byteLength(value) <= 100 &&
    !/^\/(?:private\/)?(?:tmp|var\/folders)(?:\/|$)/u.test(value)
    ? undefined
    : "Use a normalized absolute path of at most 100 bytes, outside OS temporary storage.";
}

const labels: Record<Field, string> = { machineId: "Machine", scopeId: "Scope", label: "Label" };
const descriptions: Record<Field, string> = {
  machineId: "How other sessions name this computer. Lowercase letters, digits and dashes.",
  scopeId: "Sessions only see peers in the same scope. It covers every project on this account.",
  label: "The name other sessions see for this Pi.",
};
const PERMISSION_TEXT: Record<(typeof permissions)[number], string> = {
  discover: "See that this session exists",
  read: "Read records this session publishes",
  push: "Send messages to this session (can wake the model at provider cost)",
  interest: "Follow updates to this session's published work",
};

/** The first text field whose value is invalid. */
function invalidField(choices: LocalChoices): Field | undefined {
  return (["machineId", "scopeId", "label"] as const).find(
    (field) => validateField(field, choices[field]) !== undefined,
  );
}

/** The local part of a gate: Missing socket, then invalid fields, else the rebuilt plan. */
function localGate(
  choices: LocalChoices,
  socket: string,
  socketRequired: boolean,
): Gate<LocalPlan> {
  if (socketRequired && socket === "") {
    return { kind: "missing", reason: "Socket" };
  }
  const invalid = invalidField(choices);
  if (invalid !== undefined) {
    return { kind: "invalid", reason: `check ${labels[invalid]}` };
  }
  if (socketRequired && validateSocket(socket) !== undefined) {
    return { kind: "invalid", reason: "check Socket" };
  }
  try {
    return { kind: "ready", value: localPlan(choices, socket) };
  } catch {
    return { kind: "invalid", reason: "check the settings above" };
  }
}

/**
 * Apply row state: a blocked route first (nothing the user fills in can unblock it), then Missing
 * (local, then remote), then invalid fields and remote cross-field checks, else Ready.
 */
export function applyState(
  draft: SetupDraft,
  blocked?: string,
  remoteBlocked?: string,
): Gate<SetupChoice> {
  const reason = draft.mode === "remote" ? remoteBlocked : blocked;
  if (reason !== undefined) {
    return { kind: "blocked", reason };
  }
  const local = localGate(draft.choices, draft.socket, draft.socketRequired);
  const remote =
    draft.mode === "remote" ? remoteGate(draft.remote, draft.choices.machineId) : undefined;
  if (local.kind === "missing") {
    return local;
  }
  if (remote?.kind === "missing") {
    return remote;
  }
  if (local.kind !== "ready") {
    return local;
  }
  if (remote !== undefined && remote.kind !== "ready") {
    return remote;
  }
  return {
    kind: "ready",
    value: {
      plan: local.value,
      shared: draft.shared,
      ...(remote?.kind === "ready" ? { remote: remote.value } : {}),
    },
  };
}

/** Machine, Scope and Label rows; `set` saves a validated value. */
function localRows(
  choices: () => LocalChoices,
  set: (next: LocalChoices) => void,
  fields: readonly Field[] = ["machineId", "scopeId", "label"],
): Row[] {
  return fields.map((field) =>
    textField({
      id: field,
      label: labels[field],
      description: descriptions[field],
      placeholder: choices()[field],
      get: () => choices()[field],
      save: validated(
        (value) => validateField(field, value),
        (value) => {
          set({ ...choices(), [field]: value });
        },
      ),
    }),
  );
}

const PERMISSIONS_HELP = "What other sessions on this account may do with this one.";

/** The plain disclosure that a paired setup's permissions are also the peer's grants. */
export function peerGrantText(peer: string): string {
  return `Also changes what ${visibleText(peer)} may do with this Pi.`;
}

function permissionsRow(
  choices: () => LocalChoices,
  set: (next: LocalChoices) => void,
  description = PERMISSIONS_HELP,
): Row {
  return {
    id: "permissions",
    label: "Permissions",
    value: `${choices().permissions.length} of ${permissions.length} on`,
    description,
    activation: {
      kind: "open",
      screen: () => ({
        kind: "toggle",
        title: "Permissions",
        items: () =>
          permissions.map((id) => ({
            id,
            label: id,
            on: choices().permissions.includes(id),
            description: PERMISSION_TEXT[id],
          })),
        toggle: (id) => {
          const current = choices().permissions;
          const on = new Set(current.filter((item) => item !== id));
          if (!current.some((item) => item === id)) {
            const added = permissions.find((item) => item === id);
            if (added !== undefined) {
              on.add(added);
            }
          }
          set({ ...choices(), permissions: permissions.filter((item) => on.has(item)) });
        },
      }),
    },
  };
}

function socketRow(draft: SetupDraft, probe: SetupFormOptions["probe"]): Row[] {
  if (!draft.socketRequired) {
    return [];
  }
  return [
    textField({
      id: "socket",
      label: "Socket",
      description: "A short private path for the gateway socket; the default is too long here.",
      placeholder: "/persistent/private/path/s",
      get: () => draft.socket,
      save: async (value) => {
        const error = validateSocket(value);
        if (error !== undefined) {
          return error;
        }
        const shared = (await probe?.(value)) ?? false;
        return () => {
          draft.shared = shared;
          draft.socket = value;
        };
      },
    }),
  ];
}

function applyRows(options: SetupFormOptions): Row[] {
  const { draft } = options;
  const state = applyState(draft, options.blocked, options.remoteBlocked);
  const details = (): string[] => {
    if (state.kind === "ready") {
      return options.details(state.value).split("\n");
    }
    const local = localGate(draft.choices, draft.socket, draft.socketRequired);
    return [
      `Apply is not ready: ${gateText(state)}`,
      ...(local.kind === "ready"
        ? options.details({ plan: local.value, shared: draft.shared }).split("\n")
        : []),
    ];
  };
  return [
    detailsRow(details),
    consentRow({
      label: "Apply",
      action: "Apply",
      gate: state,
      description: draft.shared
        ? "Restarts the shared gateway once, then turns peers on as reviewed."
        : "Performs the reviewed changes and turns peers on.",
      blockedHelp: BLOCKED_HELP,
      run: (choice) => {
        options.apply(choice);
      },
    }),
  ];
}

/** The fresh setup form, titled `Setup`, pushed on top of the Peers root. */
export function setupForm(options: SetupFormOptions): Screen {
  const { draft } = options;
  const choices = (): LocalChoices => draft.choices;
  const set = (next: LocalChoices): void => {
    draft.choices = next;
  };
  return {
    kind: "list",
    title: "Setup",
    note: "Nothing changes until you choose Apply.",
    rows: () => [
      cycleField({
        id: "mode",
        label: "Mode",
        description:
          "Local only: sessions on this computer. One remote peer: also link one other computer.",
        options: [
          ["local", "Local only"],
          ["remote", "One remote peer"],
        ],
        get: () => draft.mode,
        set: (value) => {
          draft.mode = value;
        },
      }),
      ...localRows(choices, set),
      permissionsRow(choices, set),
      ...socketRow(draft, options.probe),
      ...(draft.mode === "remote"
        ? remoteRows(draft.remote, {
            adopt: (machine) => {
              set({ ...draft.choices, machineId: machine });
            },
          })
        : []),
      ...applyRows(options),
    ],
  };
}

function sameChoices(left: LocalChoices, right: LocalChoices): boolean {
  return (
    left.machineId === right.machineId &&
    left.scopeId === right.scopeId &&
    left.label === right.label &&
    left.permissions.join() === right.permissions.join()
  );
}

/**
 * Apply state of the Manage form: `No changes` until a row differs from the saved settings, then
 * an invalid field, then a blocked rebuild (saved files unreadable), else the rebuilt plan.
 */
export function editState(
  saved: LocalChoices,
  edited: LocalChoices,
  rebuild: ((choices: LocalChoices) => LocalPlan) | undefined,
): Gate<LocalPlan> {
  if (sameChoices(saved, edited)) {
    return { kind: "unchanged" };
  }
  const invalid = invalidField(edited);
  if (invalid !== undefined) {
    return { kind: "invalid", reason: `check ${labels[invalid]}` };
  }
  if (rebuild === undefined) {
    return {
      kind: "blocked",
      reason: "settings were edited by hand — change pi-peers.json by hand or Reset",
    };
  }
  try {
    return { kind: "ready", value: rebuild(edited) };
  } catch {
    return { kind: "invalid", reason: "check the settings above" };
  }
}

const FIXED_SCOPE = "Can't change here: the paired computer uses this scope. Re-pair to change it.";

export type ManageFormOptions = {
  /** The saved settings; the form starts from a copy of them. */
  readonly saved: LocalChoices;
  /** A note naming this computer (and its peer, when paired). */
  readonly note: string;
  /** Why Machine can't change here (for example a pair's certificates name it); else editable. */
  readonly fixedMachine?: string;
  /**
   * The paired peer, if any. Its grants follow this Pi's permissions, so the Permissions and Apply
   * descriptions say so, and Scope is read-only (the peer uses the same scope).
   */
  readonly peer?: string;
  /**
   * Rebuilds the full plan from edited choices; undefined when the saved files can't be read or
   * hold more than this form shows, so an edit is Blocked rather than silently dropping settings.
   */
  readonly rebuild?: (choices: LocalChoices) => LocalPlan;
  /** Whether a shared gateway was seen live (read-only); Apply then restarts it once. */
  readonly shared: () => boolean;
  /** Review details for an edited plan, or for the saved settings when nothing is ready. */
  readonly details: (plan: LocalPlan | undefined) => readonly string[];
  readonly apply: (plan: LocalPlan) => void;
  /** The other existing-setup actions, listed below Apply. */
  readonly actions: () => readonly Row[];
};

/** The Manage form, titled `Setup`: the saved settings as editable rows, Apply, then the actions. */
export function manageForm(options: ManageFormOptions): Screen {
  const draft = { choices: options.saved };
  const choices = (): LocalChoices => draft.choices;
  const set = (next: LocalChoices): void => {
    draft.choices = next;
  };
  const { fixedMachine, peer } = options;
  const fixed = (field: Field, reason: string | undefined): Row[] =>
    reason === undefined
      ? localRows(choices, set, [field])
      : [
          {
            id: field,
            label: labels[field],
            value: visibleText(draft.choices[field]),
            description: reason,
            activation: { kind: "none" },
          },
        ];
  const grants = peer === undefined ? "" : ` ${peerGrantText(peer)}`;
  return {
    kind: "list",
    title: "Setup",
    note: options.note,
    rows: () => {
      const state = editState(options.saved, draft.choices, options.rebuild);
      return [
        ...fixed("machineId", fixedMachine),
        ...fixed("scopeId", peer === undefined ? undefined : FIXED_SCOPE),
        ...localRows(choices, set, ["label"]),
        permissionsRow(choices, set, `${PERMISSIONS_HELP}${grants}`),
        detailsRow(
          () => [
            ...(state.kind === "ready" ? [] : [`Apply is not ready: ${gateText(state)}`]),
            ...options.details(state.kind === "ready" ? state.value : undefined),
          ],
          "What Apply will change and restart.",
        ),
        consentRow({
          label: "Apply",
          action: "Apply",
          gate: state,
          description: `${
            options.shared()
              ? "Saves the changes, restarts the shared gateway once and reconnects this Pi with them."
              : "Saves the changes and reconnects this Pi with them."
          }${grants}`,
          run: (plan) => {
            options.apply(plan);
          },
        }),
        ...options.actions(),
      ];
    },
  };
}
