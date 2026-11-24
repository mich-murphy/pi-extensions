import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  configurationKeys,
  decodeConfiguration,
  loadConfiguration,
  permits,
  SOCKET_PATH_MAX_BYTES,
  visibleText,
} from "../adapter/config.js";
import type { Configuration, Permission } from "../adapter/config.js";
import { stateLocations } from "../adapter/locations.js";
import type { StateSet } from "../adapter/locations.js";
import { readManaged } from "./backend.js";
import { regularBytes } from "./files.js";
import { managedSnapshot } from "./managed.js";
import { decodePairing, parseJson } from "./schema.js";

type Inspection =
  | {
      readonly kind: "missing" | "unreadable" | "too-large" | "invalid-json";
      readonly path: string;
    }
  | {
      readonly kind: "invalid-fields";
      readonly path: string;
      readonly fields: readonly string[];
    }
  | {
      readonly kind: "valid";
      readonly path: string;
      readonly config: Configuration;
    };
const baseline = {
  machineId: "machine",
  socketPath: "/tmp/pi-peers.sock",
  scopeIds: ["local"],
  label: "Pi",
  policies: [],
};
const keys = Object.keys(baseline);
const optionalKeys = configurationKeys.filter((key) => !keys.includes(key));
export function invalidFields(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["root (expected an object)"];
  }
  const fields: string[] = [];
  for (const key of keys) {
    try {
      const field: unknown = Reflect.get(value, key);
      decodeConfiguration({ ...baseline, [key]: field });
    } catch {
      fields.push(key);
    }
  }
  for (const key of optionalKeys.filter((name) => Object.hasOwn(value, name))) {
    const field: unknown = Reflect.get(value, key);
    try {
      decodeConfiguration({ ...baseline, [key]: field });
    } catch {
      fields.push(key);
    }
  }
  if (Object.keys(value).some((key) => !keys.includes(key) && !optionalKeys.includes(key))) {
    fields.push("unknown keys (remove unsupported fields)");
  }
  return fields;
}

async function inspectConfiguration(agentDir: string): Promise<Inspection> {
  const path = stateLocations(agentDir).active.config;
  try {
    const target = await stat(path);
    if (target.isFile() && target.size > 32_768) {
      return { kind: "too-large", path };
    }
    const bytes = await regularBytes(path, true);
    if (bytes === undefined) {
      return { kind: "missing", path };
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { kind: "invalid-json", path };
    }
    const fields = invalidFields(value);
    if (fields.length > 0) {
      return { kind: "invalid-fields", path, fields };
    }
    return { kind: "valid", path, config: decodeConfiguration(value) };
  } catch (error) {
    return {
      kind:
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "unreadable",
      path,
    };
  }
}

export type DoctorLevel = "ok" | "warn" | "error";
export type DoctorRow = {
  readonly label: string;
  readonly value: string;
  readonly level: DoctorLevel;
};
export type DoctorReport = {
  readonly ok: boolean;
  readonly rows: DoctorRow[];
  readonly next?: string;
  readonly technical: string[];
};
type Check = { readonly row?: DoctorRow; readonly detail: string };
function line(label: string, value: string, level: DoctorLevel = "ok"): DoctorRow {
  return { label, value, level };
}
export type DoctorOptions = { readonly inMenu?: boolean };
function setupStep(options: DoctorOptions): string {
  return options.inMenu === true ? "Choose Setup" : "Run /peers setup";
}
function setupClause(options: DoctorOptions): string {
  return options.inMenu === true ? "choose Setup" : "run /peers setup";
}

export async function doctorReport(
  agentDir: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const SETUP = setupStep(options);
  const inspection = await inspectConfiguration(agentDir);
  const { active, ignored } = stateLocations(agentDir);
  const path = visibleText(inspection.path);
  const technical = [`User-agent config: ${path}`, ...stateSetLines(active, ignored)];
  const rows: DoctorRow[] = [];
  switch (inspection.kind) {
    case "missing": {
      rows.push(line("Config file", `Not found at ${path}. ${SETUP} to create it.`, "warn"));
      technical.push(
        "Configuration: pi-peers.json is missing on disk; new sessions will not connect. This session may still be connected.",
      );
      break;
    }
    case "unreadable": {
      rows.push(
        line(
          "Config file",
          `Can't read ${path}. Check its owner and permissions, then run /peers doctor again.`,
          "error",
        ),
      );
      technical.push(
        "Configuration: not a readable regular file. Check its owner and permissions. Nothing was changed.",
      );
      break;
    }
    case "too-large": {
      rows.push(
        line(
          "Config file",
          `${path} is larger than 32 KiB. Shrink it, then run /peers reconnect.`,
          "error",
        ),
      );
      technical.push(
        "Configuration: exceeds 32 KiB. Shrink it, then run /peers reconnect. Nothing was changed.",
      );
      break;
    }
    case "invalid-json": {
      rows.push(
        line(
          "Config file",
          `${path} is not valid JSON. Fix the syntax, then run /peers reconnect.`,
          "error",
        ),
      );
      technical.push(
        "Configuration: invalid JSON. Fix the syntax in the file above. Nothing was changed.",
      );
      break;
    }
    case "invalid-fields": {
      rows.push(
        line(
          "Config file",
          `${path} has invalid settings: ${inspection.fields.join(", ")}. Fix them, or ${setupClause(options)} to write new ones.`,
          "error",
        ),
      );
      technical.push(
        `Configuration: invalid fields: ${inspection.fields.join(", ")}.`,
        `Required: machineId lowercase letter-led (max 32); socketPath absolute and <=${SOCKET_PATH_MAX_BYTES} UTF-8 bytes without controls; scopeIds 1–4 unique identifiers; label 1–128 UTF-8 bytes without control or bidi characters and with visible text; policies exact machine/scope/actions. Unknown keys are rejected.`,
      );
      break;
    }
    case "valid": {
      rows.push(line("Config file", path));
      const valid = await describeValid(inspection.config, agentDir, options);
      rows.push(...valid.rows);
      technical.push(...valid.technical);
      break;
    }
  }
  rows.push(stateSetRow(active, ignored));
  const ok = rows.every((row) => row.level !== "error");
  const clean = rows.every((row) => row.level === "ok");
  return {
    ok,
    rows,
    next: clean
      ? "Run /peers status to see this session's live connection."
      : "Start with the first item marked ✗ or !, then run /peers doctor again.",
    technical,
  };
}

const MARK: Record<DoctorLevel, string> = { ok: "✓", warn: "!", error: "✗" };
export function doctorRowText(row: DoctorRow): string {
  return `${MARK[row.level]} ${row.label}: ${row.value}`;
}
export async function doctor(agentDir: string): Promise<string> {
  const report = await doctorReport(agentDir);
  return [
    "Peers doctor (read-only)",
    ...report.rows.map((row) => doctorRowText(row)),
    ...(report.next === undefined ? [] : [`Next: ${report.next}`]),
    ...(report.technical.length === 0
      ? []
      : ["Technical details:", ...report.technical.map((entry) => `  ${entry}`)]),
  ].join("\n");
}

function stateSetRow(active: StateSet, ignored: StateSet | undefined): DoctorRow {
  if (active.kind === "legacy") {
    return line(
      "Saved files",
      "Using the older session-communication files. They keep working; see Technical details to move to the new names.",
      "warn",
    );
  }
  return ignored === undefined
    ? line("Saved files", "Current (pi-peers.json)")
    : line(
        "Saved files",
        "Older session-communication files are also present but ignored. Move them aside when convenient; nothing reads them.",
        "warn",
      );
}

function stateSetLines(active: StateSet, ignored: StateSet | undefined): string[] {
  if (active.kind === "legacy") {
    return [
      `State set: legacy (session-communication.json, ${visibleText(active.directory)}, ~/.pi/comms). It keeps working as a whole and is never moved, rewritten or deleted.`,
      "To migrate: run /peers reset, move the legacy config and directory aside yourself (the directory keeps credentials and revocation records), then /peers setup writes pi-peers.json, pi-peers/ and ~/.pi/pi-peers.",
    ];
  }
  return [
    "State set: current (pi-peers.json, pi-peers/, ~/.pi/pi-peers).",
    ...(ignored === undefined
      ? []
      : [
          `Warning: legacy state (${visibleText(ignored.config)}, ${visibleText(ignored.directory)}) is present but ignored because current state exists; the two sets are never mixed.`,
        ]),
  ];
}

async function socketCheck(socketPath: string): Promise<Check> {
  try {
    const entry = await lstat(socketPath);
    return entry.isSocket()
      ? {
          row: line("Gateway", "Socket found. Run /peers status to see the live connection."),
          detail: "Socket entry: present (this does not prove the gateway is ready).",
        }
      : {
          row: line(
            "Gateway",
            "Something other than the gateway is at its socket path. Move that file aside yourself, then run /peers reconnect.",
            "error",
          ),
          detail:
            "Socket entry: not a Unix socket. Doctor never deletes it; move it aside yourself.",
        };
  } catch {
    return {
      row: line(
        "Gateway",
        "Not running. Run /peers reconnect to start it; if you run the gateway yourself, start it first.",
        "warn",
      ),
      detail:
        "Socket entry: absent or inaccessible. Start a self-run gateway first, then run /peers reconnect.",
    };
  }
}

async function describeValid(
  config: Configuration,
  agentDir: string,
  options: DoctorOptions,
): Promise<{ rows: DoctorRow[]; technical: string[] }> {
  const technical = [
    "Configuration: valid (on disk; a running session may still use an earlier copy).",
    `Socket: ${visibleText(config.socketPath)}`,
    `Requested scopes: ${config.scopeIds.map((scope) => visibleText(scope)).join(", ")}`,
  ];
  const rows = [
    line("Machine", visibleText(config.machineId)),
    line("Scopes", config.scopeIds.map((scope) => visibleText(scope)).join(", ")),
  ];
  const socket = await socketCheck(config.socketPath);
  technical.push(socket.detail);
  const actions: readonly Permission[] = ["discover", "push"];
  const missing = config.scopeIds.filter(
    (scope) => !actions.every((action) => permits(config, config.machineId, scope, action)),
  );
  if (missing.length > 0) {
    technical.push(
      "Some actions are off for this machine; this may be intentional. Doctor never widens them.",
    );
  }
  const remote = await remoteCheck(agentDir, options);
  const pairing = await pairingCheck(agentDir, options);
  technical.push(
    remote.detail,
    pairing.detail,
    "Reconnect keeps this session's state and does not reread pi-peers.json. /reload loads changed settings but clears this session's inbox and receipts.",
  );
  return {
    rows: [
      ...rows,
      ...(socket.row === undefined ? [] : [socket.row]),
      missing.length === 0
        ? line("Permissions", "All actions allowed on this machine")
        : line(
            "Permissions",
            `Some actions are off on this machine in ${missing.map((scope) => visibleText(scope)).join(", ")}. That may be intended; ${setupClause(options)} to change them.`,
            "warn",
          ),
      ...(remote.row === undefined ? [] : [remote.row]),
      ...(pairing.row === undefined ? [] : [pairing.row]),
    ],
    technical,
  };
}

async function remoteCheck(agentDir: string, options: DoctorOptions = {}): Promise<Check> {
  const SETUP = setupStep(options);
  try {
    const config = await loadConfiguration(agentDir);
    if (config === undefined) {
      return {
        row: line("Remote link", `No saved settings to check. ${SETUP} first.`, "warn"),
        detail:
          "Remote config snapshot: pi-peers.json is missing; a running session may still use it.",
      };
    }
    const setup = await readManaged(agentDir, config);
    if (setup === undefined) {
      return {
        row: line("Remote link", "Not managed by setup (you run the gateway yourself)"),
        detail:
          "Remote config snapshot: you run the gateway yourself, so doctor does not check it.",
      };
    }
    const { state, text: detail } = await managedSnapshot(setup);
    if (state === "disabled") {
      return { row: line("Remote link", "None (this machine only)"), detail };
    }
    if (state === "configured") {
      return {
        row: line("Remote link", "Credentials look valid; the live link is not checked here"),
        detail,
      };
    }
    return {
      row: line(
        "Remote link",
        `Credentials need attention. ${SETUP} to renew or pair again; this machine still works locally.`,
        "error",
      ),
      detail,
    };
  } catch {
    return {
      row: line(
        "Remote link",
        `Couldn't check the remote setup files. ${SETUP} to review them.`,
        "warn",
      ),
      detail:
        "Remote config snapshot unavailable: the setup files could not be read. The local connection is separate.",
    };
  }
}

const WEEK = 7 * 86_400_000;
async function pairingCheck(agentDir: string, options: DoctorOptions): Promise<Check> {
  const SETUP = setupStep(options);
  try {
    const { setupPaths } = await import("./backend.js");
    const bytes = await regularBytes(join(setupPaths(agentDir).directory, "pairing.json"));
    if (bytes === undefined) {
      return { detail: "Pair expiry: no pairing saved by setup." };
    }
    const value = decodePairing(parseJson(bytes));
    const deadlines = ["rootExpiresAt", "leafExpiresAt", "crlExpiresAt"].flatMap((key) =>
      typeof value.inspection?.[key] === "number" ? [[key, value.inspection[key]] as const] : [],
    );
    if (deadlines.length === 0) {
      return {
        row: line("Pairing", "No expiry dates saved yet"),
        detail: "Pair expiry: no saved expiry dates yet (pairing pending).",
      };
    }
    const now = Date.now();
    const detail = `Pair expiry (saved native inspection): ${deadlines.map(([key, time]) => `${key} ${new Date(time * 1000).toISOString()}${time * 1000 - now <= WEEK ? " — renew or re-pair now" : ""}`).join("; ")}. Use /peers setup to renew or import; old revocation records are kept.`;
    const earliest = Math.min(...deadlines.map(([, time]) => time * 1000));
    const date = new Date(earliest).toISOString().slice(0, 10);
    if (earliest <= now) {
      return {
        row: line("Pairing", `Expired on ${date}. ${SETUP} to renew or pair again.`, "error"),
        detail,
      };
    }
    return {
      row:
        earliest - now <= WEEK
          ? line("Pairing", `Expires on ${date}. ${SETUP} to renew it soon.`, "warn")
          : line("Pairing", `Valid until ${date}`),
      detail,
    };
  } catch {
    return {
      row: line("Pairing", `Couldn't read the pairing details. ${SETUP} to review them.`, "warn"),
      detail: "Pair expiry: could not read the saved dates; credentials were kept.",
    };
  }
}
