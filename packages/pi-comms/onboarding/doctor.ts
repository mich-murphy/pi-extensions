import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import { decodeConfiguration, permits, visibleText } from "../adapter/config.js";
import type { Configuration, Permission } from "../adapter/config.js";

type Inspection =
  | {
      readonly kind: "missing" | "unreadable" | "too-large" | "invalid-json";
      readonly path: string;
    }
  | { readonly kind: "invalid-fields"; readonly path: string; readonly fields: readonly string[] }
  | { readonly kind: "valid"; readonly path: string; readonly config: Configuration };
const baseline = {
  machineId: "machine",
  socketPath: "/tmp/pi-comms.sock",
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

/** Bounded regular-file read only. Never follows a symlink or opens a socket/device. */
async function inspectConfiguration(agentDir: string): Promise<Inspection> {
  const path = join(agentDir, "session-communication.json");
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) {
      return { kind: "unreadable", path };
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        return { kind: "unreadable", path };
      }
      if (stat.size > 32_768) {
        return { kind: "too-large", path };
      }
      bytes = Buffer.alloc(32_769);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      bytes = bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    if (bytes.length > 32_768) {
      return { kind: "too-large", path };
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
  const lines = [
    "Session communication doctor (read-only)",
    `User-agent config: ${visibleText(inspection.path)}`,
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
        "Configuration: not a readable regular file, or symlink not inspected. The runtime loader may follow a config symlink; this inspection does not determine whether a runtime is enabled. Check ownership/access and the runtime status below. No bytes changed.",
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
      lines.push(...(await describeValid(inspection.config)));
      break;
    }
  }
  return lines.join("\n");
}

async function describeValid(config: Configuration): Promise<string[]> {
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
      "Socket entry: absent or inaccessible. Start the configured external gateway, then /comms reconnect. Doctor never starts or connects to it.",
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
    "Reconnect preserves this runtime's nonce and volatile state and does not reread config or replay sends. For changed config, /reload currently replaces the runtime and loses inbox/publications/interests/receipts; other sessions are unchanged.",
  );
  return lines;
}
