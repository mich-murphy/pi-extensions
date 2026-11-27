import { lstat, stat } from "node:fs/promises";
import { Schema } from "effect";
import { errnoCode } from "../../shared/errno.js";
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
import type { ManagedSnapshot, RemoteGrant } from "./managed.js";
import { decodeGateway, isRetiredRemote, parseJson } from "./schema.js";
import { degradedText } from "./tailscale.js";

type Inspection =
  | {
      readonly kind: "missing" | "unreadable" | "too-large" | "invalid-json";
      readonly path: string;
    }
  | {
      readonly kind: "invalid-fields";
      readonly path: string;
      readonly fields: ReadonlyArray<string>;
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
const isJsonObject = Schema.is(Schema.JsonObject);

export function invalidFields(value: Schema.Json): Array<string> {
  if (!isJsonObject(value)) {
    return ["root (expected an object)"];
  }

  const fields: Array<string> = [];

  for (const key of keys) {
    try {
      const field = value[key];

      if (field === undefined) {
        fields.push(key);
        continue;
      }

      decodeConfiguration({ ...baseline, [key]: field });
    } catch {
      fields.push(key);
    }
  }

  for (const key of optionalKeys.filter((name) => Object.hasOwn(value, name))) {
    const field = value[key];

    if (field === undefined) {
      continue;
    }

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

    let value: Schema.Json;

    try {
      value = parseJson(bytes);
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
      kind: errnoCode(error) === "ENOENT" ? "missing" : "unreadable",
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
  readonly rows: Array<DoctorRow>;
  readonly next?: string;
  readonly technical: Array<string>;
};

type Check = { readonly row?: DoctorRow; readonly detail: string };

function line(label: string, value: string, level: DoctorLevel = "ok"): DoctorRow {
  return { label, value, level };
}

export type DoctorOptions = {
  readonly inMenu?: boolean;
  readonly liveLinks?: ReadonlyArray<{
    readonly machineId: string;
    readonly state: string;
  }>;
};

function liveLinkText(options: DoctorOptions): string | undefined {
  const links = options.liveLinks;

  if (links === undefined || links.length === 0) {
    return undefined;
  }

  return `Live link: ${links.map((link) => `${visibleText(link.machineId)} ${visibleText(link.state)}`).join(", ")} (from this session)`;
}

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
  const rows: Array<DoctorRow> = [];

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

export async function doctor(agentDir: string, options: DoctorOptions = {}): Promise<string> {
  const report = await doctorReport(agentDir, options);

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

function stateSetLines(active: StateSet, ignored: StateSet | undefined): Array<string> {
  if (active.kind === "legacy") {
    return [
      `State set: legacy (session-communication.json, ${visibleText(active.directory)}, ~/.pi/comms). It keeps working as a whole and is never moved, rewritten or deleted.`,
      "To migrate: run /peers reset, move the legacy config and directory aside yourself (the directory keeps keys), then /peers setup writes pi-peers.json, pi-peers/ and ~/.pi/pi-peers.",
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
): Promise<{ rows: Array<DoctorRow>; technical: Array<string> }> {
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
  const actions: ReadonlyArray<Permission> = ["discover", "push"];

  const missing = config.scopeIds.filter(
    (scope) => !actions.every((action) => permits(config, config.machineId, scope, action)),
  );

  if (missing.length > 0) {
    technical.push(
      "Some actions are off for this machine; this may be intentional. Doctor never widens them.",
    );
  }

  const remote = await remoteCheck(agentDir, options);
  technical.push(
    remote.detail,
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

    const gateway = await regularBytes(setup.gatewayPath);
    const remote = gateway === undefined ? undefined : decodeGateway(parseJson(gateway)).remote;

    const snapshot =
      remote === undefined || !isRetiredRemote(remote)
        ? await managedSnapshot(setup)
        : {
            state: "retired-certificates",
            text: "Remote config snapshot: retired-certificates (read from gateway.json; the gateway was not asked).",
          };

    return snapshotCheck(snapshot, options);
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

function grantText(allow: ReadonlyArray<RemoteGrant>): string {
  return allow
    .map((grant) => `${grant.actions.join(", ")} in ${visibleText(grant.scope)}`)
    .join("; ");
}

function peerText(peer: NonNullable<ManagedSnapshot["peer"]>): string {
  const tags =
    peer.tags.length === 0
      ? "no tags"
      : `tags ${peer.tags.map((tag) => visibleText(tag)).join(", ")}`;

  return `Peer ${visibleText(peer.name)} (StableID ${visibleText(peer.stableId)}, ${tags})`;
}

function configuredText(snapshot: ManagedSnapshot, options: DoctorOptions): string {
  const live = liveLinkText(options);
  const endpoint = snapshot.endpoint;

  return [
    `Tailscale: this computer is ${visibleText(snapshot.self ?? "unknown")}`,
    ...(endpoint === undefined
      ? []
      : [
          endpoint.mode === "listen"
            ? `Listening on ${visibleText(endpoint.address)}`
            : `Connecting to ${visibleText(endpoint.address)}`,
        ]),
    ...(snapshot.peer === undefined
      ? []
      : [
          snapshot.peer.allow.length === 0
            ? `${peerText(snapshot.peer)} may do nothing here yet; add a grant for it to your tailnet policy`
            : `${peerText(snapshot.peer)} may ${grantText(snapshot.peer.allow)} here`,
        ]),
    live ?? "The live link is not checked here",
  ].join(". ");
}

function snapshotCheck(snapshot: ManagedSnapshot, options: DoctorOptions): Check {
  const SETUP = setupStep(options);
  const detail = snapshot.text;

  if (snapshot.state === "disabled") {
    return { row: line("Remote link", "None (this machine only)"), detail };
  }

  if (snapshot.state === "configured") {
    const live = liveLinkText(options);
    const up =
      live === undefined || options.liveLinks?.every((link) => link.state === "up") === true;
    const granted = snapshot.peer === undefined || snapshot.peer.allow.length > 0;

    return {
      row: line(
        "Remote link",
        `${configuredText(snapshot, options)}.`,
        up && granted ? "ok" : "warn",
      ),
      detail,
    };
  }

  if (snapshot.state === "retired-certificates") {
    return {
      row: line(
        "Remote link",
        `This link uses retired certificates or keys. Link again over Tailscale: ${SETUP} › Link a remote computer. This machine still works locally.`,
        "error",
      ),
      detail,
    };
  }

  const reason = snapshot.reason ?? snapshot.state;
  const known = degradedText(reason);

  return {
    row: line(
      "Remote link",
      known === undefined
        ? `Needs attention (${visibleText(reason)}). ${SETUP} › Link a remote computer to check it; this machine still works locally.`
        : `${known}. This machine still works locally.`,
      "error",
    ),
    detail,
  };
}

export async function remoteStatus(agentDir: string): Promise<string | undefined> {
  const check = await remoteCheck(agentDir);

  return check.row === undefined ? undefined : doctorRowText(check.row);
}
