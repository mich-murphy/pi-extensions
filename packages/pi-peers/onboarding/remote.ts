import { isIP } from "node:net";
import type { Schema } from "effect";
import { visibleText } from "../adapter/config.js";
import type { LocalPlan } from "./plan.js";
import { isRetiredRemote } from "./schema.js";
import type { GatewayConfig } from "./schema.js";

export const DEFAULT_PORT = 7443;
const CAPABILITY = "github.com/mich-murphy/cap/pi-peers";

export type Endpoint = {
  readonly mode: "connect" | "listen";
  readonly address: string;
};

export type RemoteIntent = {
  readonly mode: "connect" | "listen";
  readonly host: string;
  readonly port: number;
};

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*\.?$/iu;

export function hostError(value: string): string | undefined {
  const host = value.trim();

  return isIP(host) !== 0 || (host.length <= 253 && HOST.test(host))
    ? undefined
    : "Use the other computer's MagicDNS name, like dev-01, or its tailnet IP, like 100.101.102.103.";
}

export function portError(value: string): string | undefined {
  const port = Number(value.trim());

  return /^\d{1,5}$/u.test(value.trim()) && port >= 1 && port <= 65_535
    ? undefined
    : "Use a port number from 1 to 65535, like 7443.";
}

export function joinAddress(ip: string, port: number): string {
  return isIP(ip) === 6 ? `[${ip}]:${String(port)}` : `${ip}:${String(port)}`;
}

export function savedTailscale(plan: LocalPlan | undefined): string | undefined {
  const remote = plan?.gateway.remote;

  return remote === undefined || isRetiredRemote(remote) ? undefined : remote.tailscale;
}

export function remoteReview(intent: RemoteIntent, machine: string): Array<string> {
  const where =
    intent.mode === "listen"
      ? `Listen on this computer's tailnet IP, port ${String(intent.port)}.`
      : `Connect to ${visibleText(intent.host)} on port ${String(intent.port)}; a name is resolved to its tailnet IP once, now.`;

  return [
    where,
    "Tailscale identifies the other computer. Your tailnet policy decides what it may do here, with the app capability github.com/mich-murphy/cap/pi-peers; the computer that receives a message enforces it.",
    `This computer's tailnet name must be ${visibleText(machine)}, the machine name other computers know it by.`,
    "Authorized remote messages can wake models and incur provider usage. Peer content is untrusted.",
  ];
}

function ownPolicies<T extends { readonly machineId: string }>(
  machine: string,
  policies: ReadonlyArray<T>,
): Array<T> {
  return policies.filter((policy) => policy.machineId === machine);
}

function localGateway(gateway: GatewayConfig): GatewayConfig {
  const { remote: _remote, ...rest } = gateway;

  return {
    ...rest,
    policies: ownPolicies(gateway.machineId, gateway.policies).map(
      ({ direction: _direction, ...policy }) => policy,
    ),
  };
}

export function unlinkedPlan(plan: LocalPlan): LocalPlan {
  return {
    ...plan,
    adapter: {
      ...plan.adapter,
      policies: ownPolicies(plan.adapter.machineId, plan.adapter.policies),
    },
    gateway: localGateway(plan.gateway),
  };
}

export function keptLink(plan: LocalPlan, saved: LocalPlan): LocalPlan {
  const remote = saved.gateway.remote;
  const base = unlinkedPlan(plan);

  return remote === undefined ? base : { ...base, gateway: { ...base.gateway, remote } };
}

export function linkedPlan(plan: LocalPlan, endpoint: Endpoint, tailscale?: string): LocalPlan {
  const base = unlinkedPlan(plan);

  return {
    ...base,
    gateway: {
      ...base.gateway,
      remote:
        tailscale === undefined
          ? { endpoint: { ...endpoint } }
          : { endpoint: { ...endpoint }, tailscale },
    },
  };
}

export function savedLink(
  plan: LocalPlan,
): { readonly endpoint: Endpoint; readonly retired: boolean } | undefined {
  const remote = plan.gateway.remote;

  return remote === undefined
    ? undefined
    : { endpoint: remote.endpoint, retired: isRetiredRemote(remote) };
}

export function endpointText(endpoint: Endpoint): string {
  return endpoint.mode === "listen"
    ? `listening on ${visibleText(endpoint.address)}`
    : `connecting to ${visibleText(endpoint.address)}`;
}

const OTHER_COMPUTER = "<other computer>";

export function otherName(intent: RemoteIntent): string {
  return intent.mode === "connect" && isIP(intent.host) === 0
    ? (intent.host.toLowerCase().split(".")[0] ?? OTHER_COMPUTER)
    : OTHER_COMPUTER;
}

export function grantInto(
  self: string,
  other: string,
  scope: string,
  listenPort: number | undefined,
): Schema.Json {
  const app = { [CAPABILITY]: [{ scopes: [scope], allow: ["discover", "push"] }] };

  return listenPort === undefined
    ? { src: [other], dst: [self], app }
    : { src: [other], dst: [self], ip: [`tcp:${String(listenPort)}`], app };
}
