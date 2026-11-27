import { DEFAULT_PORT, hostError, portError } from "../remote.js";
import type { Endpoint, RemoteIntent } from "../remote.js";
import { cycleField, textField, validated } from "./forms.js";
import type { Gate } from "./forms.js";
import type { Row } from "./model.js";

export type RemoteDraft = {
  mode: "connect" | "listen";
  host: string;
  port: string;
};

const ADDRESS = /^(?:\[(?<ipv6>[^\]]+)\]|(?<ipv4>[^:]+)):(?<port>\d+)$/u;

export function remoteDraft(saved?: Endpoint): RemoteDraft {
  const groups = ADDRESS.exec(saved?.address ?? "")?.groups;
  const port = groups?.port ?? String(DEFAULT_PORT);

  if (saved?.mode === "connect") {
    return { mode: "connect", host: groups?.ipv6 ?? groups?.ipv4 ?? "", port };
  }

  return { mode: "listen", host: "", port };
}

const CONNECTION_HELP =
  "One computer listens and the other connects. Listen: this computer waits on its own tailnet IP. Connect: this computer dials the other one.";

const HOST_HELP =
  "The other computer's MagicDNS name, like dev-01, or its tailnet IP. Required to connect; optional when listening. Setup asks Tailscale once, when you link, which computer it is and names it in the grant to add to your tailnet policy.";

const PORT_HELP = `The TCP port the listening computer uses. The default is ${String(DEFAULT_PORT)}.`;

export function remoteRows(draft: RemoteDraft): Array<Row> {
  return [
    cycleField({
      id: "connection",
      label: "Connection",
      description: CONNECTION_HELP,
      options: [
        ["listen", "Listen on this computer"],
        ["connect", "Connect to another computer"],
      ],
      get: () => draft.mode,
      set: (value) => {
        draft.mode = value;
      },
    }),
    textField({
      id: "host",
      label: "Other computer",
      description: HOST_HELP,
      placeholder: "MagicDNS name or tailnet IP",
      empty: draft.mode === "connect" ? "Required" : "Optional",
      get: () => draft.host,
      save: validated(
        (value) => (draft.mode === "listen" && value.trim() === "" ? undefined : hostError(value)),
        (value) => {
          draft.host = value.trim();
        },
      ),
    }),
    textField({
      id: "port",
      label: "Port",
      description: PORT_HELP,
      placeholder: String(DEFAULT_PORT),
      get: () => draft.port,
      save: validated(portError, (value) => {
        draft.port = value.trim();
      }),
    }),
  ];
}

export function remoteGate(draft: RemoteDraft): Gate<RemoteIntent> {
  if (draft.mode === "connect" && draft.host === "") {
    return { kind: "missing", reason: "Other computer" };
  }

  if (draft.port === "") {
    return { kind: "missing", reason: "Port" };
  }

  const invalid = (draft.host === "" ? undefined : hostError(draft.host)) ?? portError(draft.port);

  if (invalid !== undefined) {
    return { kind: "invalid", reason: invalid.replace(/\.$/u, "").toLowerCase() };
  }

  return {
    kind: "ready",
    value: { mode: draft.mode, host: draft.host, port: Number(draft.port) },
  };
}
