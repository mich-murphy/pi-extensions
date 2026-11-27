import { isIP } from "node:net";
import { visibleText } from "../adapter/config.js";
import type { LocalPlan } from "./plan.js";
import { RefusalError } from "./refusal.js";

export type RemoteIntent = {
  readonly peerMachineId: string;
  readonly endpoint: {
    readonly mode: "connect" | "listen";
    readonly address: string;
  };
  readonly peerPublicKey: string;
};

const MACHINE = /^[a-z][a-z0-9-]{0,31}$/u;
const ADDRESS = /^(?:\[(?<ipv6>[^\]]+)\]|(?<ipv4>[^:]+)):(?<port>\d+)$/u;

export function machineError(value: string): string | undefined {
  return MACHINE.test(value)
    ? undefined
    : "Use lowercase letters, digits and dashes, starting with a letter (at most 32).";
}

export function addressError(value: string): string | undefined {
  const match = ADDRESS.exec(value);
  const port = Number(match?.groups?.port);

  return match !== null &&
    isIP(match.groups?.ipv6 ?? match.groups?.ipv4 ?? "") !== 0 &&
    port >= 1 &&
    port <= 65_535
    ? undefined
    : "Use an IP address and port, like 100.101.102.103:7443 or [fd7a:115c:a1e0::1]:7443.";
}

export function remoteReview(intent: RemoteIntent, privateKey: string): Array<string> {
  return [
    `Link: ${visibleText(intent.peerMachineId)} (${intent.endpoint.mode} ${visibleText(intent.endpoint.address)}), trusted only by its public key ${intent.peerPublicKey}.`,
    "This link trusts exactly this one key. Nothing expires. To revoke it, link again with another key or remove the remote link.",
    "Remote discover/push grants apply in both directions for the reviewed scope; authorized remote pushes can wake models and incur provider usage.",
    `This computer's private key: ${visibleText(privateKey)}. Same-account processes are not isolated: anything running as you can read it.`,
    "The network only has to reach the peer: use Tailscale (listener on its tailnet IP, a tailnet policy that allows only the peer on that port) or an SSH -L forward. A local connection does not prove the remote link.",
  ];
}

function samePeer(plan: LocalPlan, peer: string): RefusalError | undefined {
  return peer === plan.adapter.machineId
    ? new RefusalError(
        "this computer and the peer have the same machine name",
        "Give one of them a different machine name",
      )
    : undefined;
}

function withoutPeers(plan: LocalPlan, peers: ReadonlyArray<string>): LocalPlan {
  const { remote: _remote, ...gateway } = plan.gateway;

  return {
    ...plan,
    adapter: {
      ...plan.adapter,
      policies: plan.adapter.policies.filter((policy) => !peers.includes(policy.machineId)),
    },
    gateway: {
      ...gateway,
      policies: gateway.policies.filter((policy) => !peers.includes(policy.machineId)),
    },
  };
}

function grantedPlan(plan: LocalPlan, peer: string): LocalPlan {
  const refused = samePeer(plan, peer);

  if (refused !== undefined) {
    throw refused;
  }

  const base = withoutPeers(plan, [peer]);
  const permissions = [...plan.choices.permissions];

  if (permissions.length === 0) {
    return base;
  }

  const grant = { machineId: peer, scopeId: plan.choices.scopeId, permissions };

  return {
    ...base,
    adapter: { ...base.adapter, policies: [...base.adapter.policies, grant] },
    gateway: {
      ...base.gateway,
      policies: [
        ...base.gateway.policies,
        { ...grant, direction: "outgoing" as const },
        { ...grant, direction: "incoming" as const },
      ],
    },
  };
}

export function linkedPeer(plan: LocalPlan): string | undefined {
  return (
    plan.gateway.remote?.machineId ??
    plan.adapter.policies.find((policy) => policy.machineId !== plan.adapter.machineId)?.machineId
  );
}

function otherPeers(plan: LocalPlan): Array<string> {
  return [
    ...new Set(
      [
        ...plan.adapter.policies.map((policy) => policy.machineId),
        ...plan.gateway.policies.map((policy) => policy.machineId),
        ...(plan.gateway.remote === undefined ? [] : [plan.gateway.remote.machineId]),
      ].filter((machine) => machine !== plan.adapter.machineId),
    ),
  ];
}

export function keptLink(plan: LocalPlan, saved: LocalPlan): LocalPlan {
  const peer = linkedPeer(saved);
  const remote = saved.gateway.remote;

  if (peer === undefined) {
    return plan;
  }

  const granted = grantedPlan(plan, peer);

  return remote === undefined ? granted : { ...granted, gateway: { ...granted.gateway, remote } };
}

export function linkedPlan(plan: LocalPlan, intent: RemoteIntent, privateKey: string): LocalPlan {
  const granted = grantedPlan(withoutPeers(plan, otherPeers(plan)), intent.peerMachineId);

  return {
    ...granted,
    gateway: {
      ...granted.gateway,
      remote: {
        machineId: intent.peerMachineId,
        endpoint: {
          mode: intent.endpoint.mode,
          address: intent.endpoint.address,
        },
        privateKey,
        peerPublicKey: intent.peerPublicKey,
      },
    },
  };
}

export function unlinkedPlan(plan: LocalPlan): LocalPlan {
  return withoutPeers(plan, otherPeers(plan));
}
