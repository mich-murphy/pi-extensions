import { decodeConfiguration, visibleText } from "../adapter/config.js";
import type { Configuration, Permission } from "../adapter/config.js";

export const permissions: readonly Permission[] = ["discover", "read", "push", "interest"];
const consent =
  "Other participating Pi sessions on this OS account, including other projects, can discover this session, read explicitly published records, send messages, and subscribe to published work updates within the reviewed grants. Authorized new messages can wake the model and incur provider usage. Peer content is untrusted. This does not automatically share files or the whole transcript, execute patches, or grant filesystem access.";
const lifetime =
  "The first participating Pi session starts the shared gateway; it exits after the last participant closes. No login/boot auto-start or idle keepalive. Session inboxes and publications are volatile.";

export type LocalChoices = {
  readonly machineId: string;
  readonly scopeId: string;
  readonly label: string;
  readonly permissions: readonly Permission[];
};
export type LocalPlan = {
  readonly choices: LocalChoices;
  readonly adapter: Configuration;
  readonly gateway: {
    readonly machineId: string;
    readonly socketPath: string;
    readonly remote?: {
      readonly machineId: string;
      readonly endpoint: {
        readonly mode: "connect" | "listen";
        readonly address: string;
      };
      readonly rootCertificates: readonly string[];
      readonly certificateChain: readonly string[];
      readonly issuerCertificates: readonly string[];
      readonly privateKey: string;
      readonly crls: readonly string[];
      readonly revocationState: string;
    };
    readonly scopeIds: readonly string[];
    readonly policies: readonly {
      readonly machineId: string;
      readonly scopeId: string;
      readonly permissions: readonly Permission[];
      readonly direction: "outgoing" | "incoming";
    }[];
  };
};

/** Host facts are suggestions, never identities or proof of trust. No filesystem effects. */
function suggestedMachineId(hostname: string): string {
  let value = hostname
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  if (value === "") {
    return "machine";
  }
  if (!/^[a-z]/u.test(value)) {
    value = `m-${value}`;
  }
  return value.slice(0, 32).replace(/-+$/u, "");
}
export function defaultChoices(hostname: string): LocalChoices {
  return {
    machineId: suggestedMachineId(hostname),
    scopeId: "local",
    label: "Pi",
    permissions: [...permissions],
  };
}

/** Validate the intersection of adapter and native gateway contracts, not just the adapter. */
export function localPlan(choices: LocalChoices, socketPath: string): LocalPlan {
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error("Socket path must be at most 100 UTF-8 bytes");
  }
  if (new Set(choices.permissions).size !== choices.permissions.length) {
    throw new Error("Duplicate permissions");
  }
  const policies =
    choices.permissions.length === 0
      ? []
      : [
          {
            machineId: choices.machineId,
            scopeId: choices.scopeId,
            permissions: [...choices.permissions],
          },
        ];
  const adapter = decodeConfiguration({
    machineId: choices.machineId,
    socketPath,
    scopeIds: [choices.scopeId],
    label: choices.label,
    policies,
  });
  const gateway = {
    machineId: adapter.machineId,
    socketPath: adapter.socketPath,
    scopeIds: [...adapter.scopeIds],
    policies: adapter.policies.map((policy) => ({
      ...policy,
      permissions: [...policy.permissions],
      direction: "outgoing" as const,
    })),
  };
  if (Buffer.byteLength(JSON.stringify(gateway)) > 32_764) {
    throw new Error("Gateway configuration is too large");
  }
  return {
    choices: { ...choices, permissions: [...choices.permissions] },
    adapter,
    gateway,
  };
}

export function localReview(plan: LocalPlan, remote = false): string {
  return [
    "Enable participation for this user-agent directory",
    `Machine: ${visibleText(plan.adapter.machineId)}; scope: ${visibleText(plan.choices.scopeId)}; label: ${visibleText(plan.adapter.label)}`,
    `Same-machine grants: ${plan.choices.permissions.join(", ") || "none"}`,
    remote
      ? "Remote settings and TCP exposure are reviewed below. Scope is account-wide, not a project boundary."
      : "Remote: none; no TCP listener. Scope is account-wide, not a project boundary.",
    consent,
    lifetime,
  ].join("\n");
}
