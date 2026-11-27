import { decodeConfiguration, SOCKET_PATH_MAX_BYTES, visibleText } from "../adapter/config.js";
import type { Configuration, Permission } from "../adapter/config.js";
import { decodeGateway, parseJson } from "./schema.js";
import type { GatewayRemote } from "./schema.js";

export const permissions: ReadonlyArray<Permission> = ["discover", "push"];

const consent =
  "Other participating Pi sessions on this OS account, including other projects, can discover this session and send it messages within the reviewed grants. Authorized new messages can wake the model and incur provider usage. Peer content is untrusted. This does not automatically share files or the whole transcript, execute patches, or grant filesystem access.";

const lifetime =
  "The first participating Pi session starts the shared gateway; it exits after the last participant closes. No login/boot auto-start or idle keepalive. Session inboxes are volatile.";

export type LocalChoices = {
  readonly machineId: string;
  readonly scopeId: string;
  readonly label: string;
  readonly permissions: ReadonlyArray<Permission>;
};

export type LocalPlan = {
  readonly choices: LocalChoices;
  readonly adapter: Configuration;
  readonly gateway: {
    readonly machineId: string;
    readonly socketPath: string;
    readonly remote?: GatewayRemote;
    readonly scopeIds: ReadonlyArray<string>;
    readonly policies: ReadonlyArray<{
      readonly machineId: string;
      readonly scopeId: string;
      readonly permissions: ReadonlyArray<Permission>;
      readonly direction: "outgoing" | "incoming";
    }>;
  };
};

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
  const machineId = suggestedMachineId(hostname);

  return {
    machineId,
    scopeId: "local",
    label: machineId,
    permissions: [...permissions],
  };
}

export function localPlan(choices: LocalChoices, socketPath: string): LocalPlan {
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES) {
    throw new Error(`The socket path is longer than ${SOCKET_PATH_MAX_BYTES} bytes`);
  }

  if (new Set(choices.permissions).size !== choices.permissions.length) {
    throw new Error("A permission is listed twice");
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
      ? "Remote: one linked computer, trusted by its pinned public key and granted the same permissions in both directions. Scope is account-wide, not a project boundary."
      : "Remote: none; no TCP listener. Scope is account-wide, not a project boundary.",
    consent,
    lifetime,
  ].join("\n");
}

export function savedChoices(config: Configuration): LocalChoices {
  const scopeId = config.scopeIds[0];

  if (scopeId === undefined) {
    throw new Error("pi-peers.json lists no scope");
  }

  const granted =
    config.policies.find(
      (grant) => grant.machineId === config.machineId && grant.scopeId === scopeId,
    )?.permissions ?? [];

  return {
    machineId: config.machineId,
    scopeId,
    label: config.label,
    permissions: granted,
  };
}

export function currentPlan(config: Configuration, gatewayBytes: Buffer): LocalPlan {
  return {
    choices: savedChoices(config),
    adapter: config,
    gateway: decodeGateway(parseJson(gatewayBytes)),
  };
}
