import { visibleText } from "../../adapter/config.js";
import { peerKeyError } from "../keys.js";
import { addressError, machineError } from "../remote.js";
import type { RemoteIntent } from "../remote.js";
import { isPinnedRemote } from "../schema.js";
import type { GatewayRemote } from "../schema.js";
import { cycleField, textField, validated } from "./forms.js";
import type { Gate } from "./forms.js";
import type { Row } from "./model.js";

export type RemoteDraft = {
  peer: string;
  mode: "connect" | "listen";
  address: string;
  peerKey: string;
};

export function remoteDraft(saved?: GatewayRemote): RemoteDraft {
  return {
    peer: saved?.machineId ?? "",
    mode: saved?.endpoint.mode ?? "connect",
    address: saved?.endpoint.address ?? "",
    peerKey: isPinnedRemote(saved) ? saved.peerPublicKey : "",
  };
}

const LISTEN_HELP =
  "The address this computer listens on. Use its Tailscale IP, like 100.101.102.103:7443, and let only the other computer reach that port.";

const CONNECT_HELP =
  "The other computer's listening address, usually its Tailscale IP, like 100.101.102.103:7443.";

export function remoteRows(draft: RemoteDraft, own: string): Array<Row> {
  return [
    textField({
      id: "peer",
      label: "Peer machine",
      description: "The other computer's machine name, exactly as it set it.",
      placeholder: "peer-machine",
      get: () => draft.peer,
      save: validated(machineError, (value) => {
        draft.peer = value;
      }),
    }),
    cycleField({
      id: "connection",
      label: "Connection",
      description:
        "One computer listens and the other connects. Connect: this computer dials the peer. Listen: the peer dials this computer.",
      options: [
        ["connect", "Connect to peer"],
        ["listen", "Listen for peer"],
      ],
      get: () => draft.mode,
      set: (value) => {
        draft.mode = value;
      },
    }),
    textField({
      id: "address",
      label: "Address",
      description: draft.mode === "connect" ? CONNECT_HELP : LISTEN_HELP,
      placeholder: "IPv4:port or [IPv6]:port",
      get: () => draft.address,
      save: validated(addressError, (value) => {
        draft.address = value;
      }),
    }),
    textField({
      id: "peerKey",
      label: "Peer public key",
      description:
        "The public key the other computer shows in Setup › Link a remote computer: 64 characters, 0-9 and a-f.",
      placeholder: "64 lowercase hex characters",
      get: () => draft.peerKey,
      save: (value) => {
        const error = peerKeyError(value, own);

        return error === undefined
          ? {
              apply: () => {
                draft.peerKey = value.trim();
              },
            }
          : { error };
      },
    }),
  ];
}

export function remoteGate(draft: RemoteDraft, machine: string, own: string): Gate<RemoteIntent> {
  const absent = (
    [
      ["Peer machine", draft.peer],
      ["Address", draft.address],
      ["Peer public key", draft.peerKey],
    ] as const
  ).find(([, value]) => value === "")?.[0];

  if (absent !== undefined) {
    return { kind: "missing", reason: absent };
  }

  if (draft.peer === machine) {
    return { kind: "invalid", reason: "the peer must be another computer" };
  }

  const keyError = peerKeyError(draft.peerKey, own);

  if (keyError !== undefined) {
    return {
      kind: "invalid",
      reason: keyError.replace(/\.$/u, "").toLowerCase(),
    };
  }

  return {
    kind: "ready",
    value: {
      peerMachineId: draft.peer,
      endpoint: { mode: draft.mode, address: draft.address },
      peerPublicKey: draft.peerKey,
    },
  };
}

export function remoteSummary(intent: RemoteIntent): string {
  return `${visibleText(intent.peerMachineId)} (${intent.endpoint.mode} ${visibleText(intent.endpoint.address)})`;
}
