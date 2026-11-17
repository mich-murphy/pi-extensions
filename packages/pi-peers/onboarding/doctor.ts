import { lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { decodeConfiguration, permits, visibleText, loadConfiguration } from "../adapter/config.js";
import type { Configuration, Permission } from "../adapter/config.js";
import { stateLocations } from "../adapter/locations.js";
import type { StateSet } from "../adapter/locations.js";
import { readManaged } from "./backend.js";
import { regularBytes } from "./files.js";
import { diagnoseManaged } from "./managed.js";
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
function invalidFields(value: unknown): string[] {
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
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    fields.push("unknown keys (remove unsupported fields)");
  }
  return fields;
}

/** Bounded regular-file read, following valid Nix/home-manager config links read-only. */
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

/** No registration, daemon launch, trust reads, sends, or service-manager changes. */
export async function doctor(agentDir: string): Promise<string> {
  const inspection = await inspectConfiguration(agentDir);
  const { active, ignored } = stateLocations(agentDir);
  const lines = [
    "Peers doctor (read-only)",
    `User-agent config: ${visibleText(inspection.path)}`,
    ...stateSetLines(active, ignored),
  ];
  switch (inspection.kind) {
    case "missing": {
      lines.push(
        "Configuration: missing on disk; new sessions will not enable participation. An existing runtime may still be active; see its status below. Use the package README for manual setup.",
      );
      break;
    }
    case "unreadable": {
      lines.push(
        "Configuration: not a readable bounded regular file (valid config symlinks are followed read-only). This inspection does not determine whether a runtime is enabled. Check ownership/access and the runtime status below. No bytes changed.",
      );
      break;
    }
    case "too-large": {
      lines.push(
        "Configuration: exceeds 32 KiB. Reduce it before starting a runtime; existing bytes preserved.",
      );
      break;
    }
    case "invalid-json": {
      lines.push(
        "Configuration: invalid JSON. Repair syntax in the displayed file; no contents are printed or rewritten.",
      );
      break;
    }
    case "invalid-fields": {
      lines.push(
        `Configuration: invalid fields: ${inspection.fields.join(", ")}.`,
        "Required: machineId lowercase letter-led (max 32); socketPath absolute and <=100 UTF-8 bytes without controls; scopeIds 1–4 unique identifiers; label 1–128 UTF-8 bytes without controls; policies exact machine/scope/actions. Unknown keys are rejected.",
      );
      break;
    }
    case "valid": {
      lines.push(...(await describeValid(inspection.config, agentDir)));
      break;
    }
  }
  return lines.join("\n");
}

/** Which saved-state set is in use; legacy state is never moved, rewritten or deleted. */
function stateSetLines(active: StateSet, ignored: StateSet | undefined): string[] {
  if (active.kind === "legacy") {
    return [
      `State set: legacy (session-communication.json, ${visibleText(active.directory)}, ~/.pi/comms). It keeps working as a whole and is never moved, rewritten or deleted.`,
      "To migrate: run /peers reset, move the legacy config and directory aside yourself (the directory keeps credentials and floors), then /peers setup writes pi-peers.json, pi-peers/ and ~/.pi/pi-peers.",
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

async function describeValid(config: Configuration, agentDir: string): Promise<string[]> {
  const lines: string[] = [];
  lines.push(
    "Configuration: valid (disk state; an existing runtime may use an earlier snapshot).",
    `Socket: ${visibleText(config.socketPath)}`,
    `Requested scopes: ${config.scopeIds.map((scope) => visibleText(scope)).join(", ")}`,
  );
  try {
    const entry = await lstat(config.socketPath);
    lines.push(
      entry.isSocket()
        ? "Socket entry: present (not proof of gateway readiness/identity)."
        : "Socket entry: not a Unix socket; do not delete or replace unknown entries.",
    );
  } catch {
    lines.push(
      "Socket entry: absent or inaccessible. Start the configured external gateway, then /peers reconnect. Doctor never starts or connects to it.",
    );
  }
  const actions: readonly Permission[] = ["discover", "read", "push", "interest"];
  const missing = config.scopeIds.filter(
    (scope) => !actions.every((action) => permits(config, config.machineId, scope, action)),
  );
  if (missing.length > 0) {
    lines.push(
      "Some same-machine grants are absent; this may be intentional. Both gateway and adapter policies must allow the desired actions. Doctor does not broaden them.",
    );
  }
  lines.push(
    await remoteSnapshot(agentDir),
    await pairingExpiry(agentDir),
    "Reconnect preserves this runtime's nonce and volatile state and does not reread config or replay sends. For changed config, /reload currently replaces the runtime and loses inbox/publications/interests/receipts; other sessions are unchanged.",
  );
  return lines;
}

/** Native snapshot command never binds/connects or changes floor state. */
export async function remoteSnapshot(agentDir: string): Promise<string> {
  try {
    const config = await loadConfiguration(agentDir);
    if (config === undefined) {
      return "Remote config snapshot: missing disk configuration; any old runtime may still be active.";
    }
    const setup = await readManaged(agentDir, config);
    return setup === undefined
      ? "Remote config snapshot: external/manual gateway; no implicit helper selection or invocation."
      : await diagnoseManaged(setup);
  } catch {
    return "Remote config snapshot unavailable; setup ownership/config/credentials may differ. Local runtime status is separate; no remote readiness claim.";
  }
}

async function pairingExpiry(agentDir: string): Promise<string> {
  try {
    const { setupPaths } = await import("./backend.js");
    const bytes = await regularBytes(join(setupPaths(agentDir).directory, "pairing.json"));
    if (bytes === undefined) {
      return "Pair expiry: no setup-managed pairing.";
    }
    const value = decodePairing(parseJson(bytes));
    const deadlines = ["rootExpiresAt", "leafExpiresAt", "crlExpiresAt"].flatMap((key) =>
      typeof value.inspection?.[key] === "number" ? [[key, value.inspection[key]] as const] : [],
    );
    if (deadlines.length === 0) {
      return "Pair expiry: pending credentials or no saved native inspection; no remote readiness claim.";
    }
    return `Pair expiry (saved native inspection): ${deadlines.map(([key, time]) => `${key} ${new Date(time * 1000).toISOString()}${time * 1000 - Date.now() <= 7 * 86_400_000 ? " — renew/re-pair now (within seven days or expired)" : ""}`).join("; ")}. Use /peers setup for renewal/import; old floors are retained.`;
  } catch {
    return "Pair expiry: unavailable; existing credentials/floors preserved.";
  }
}
