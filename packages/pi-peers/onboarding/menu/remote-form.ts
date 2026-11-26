import { Schema } from "effect";
import { visibleText } from "../../adapter/config.js";
import { addressError, machineError, readOffer } from "../remote.js";
import type { OfferPreview, RemoteIntent } from "../remote.js";
import { cycleField, hashField, pathField, textField, validated } from "./forms.js";
import type { Gate } from "./forms.js";
import type { Row } from "./model.js";

export type Kind = RemoteIntent["kind"];

export type CredentialKey =
  | "rootCertificate"
  | "certificate"
  | "privateKey"
  | "crl"
  | "revocationState";

export type RemoteDraft = {
  kind: Kind;
  peer: string;
  mode: "connect" | "listen";
  address: string;
  offerPath: string;
  offer: OfferPreview | undefined;
  rootSha256: string;
  paths: Record<CredentialKey, string>;
  floor: "existing" | "new";
};

export function remoteDraft(): RemoteDraft {
  return {
    kind: "create",
    peer: "",
    mode: "connect",
    address: "",
    offerPath: "",
    offer: undefined,
    rootSha256: "",
    paths: { rootCertificate: "", certificate: "", privateKey: "", crl: "", revocationState: "" },
    floor: "existing",
  };
}

export type RemoteOptions = {
  readonly kinds?: ReadonlyArray<Kind>;
  readonly peer?: string;
  readonly oldRoot?: string;
  readonly adopt?: (machine: string) => void;
};

const KINDS: ReadonlyArray<readonly [Kind, string]> = [
  ["create", "Create new pair"],
  ["join", "Join a pair"],
  ["existing", "Use existing files"],
];

const CREDENTIALS: ReadonlyArray<readonly [CredentialKey, string, string]> = [
  ["rootCertificate", "Root certificate", "The pair's trusted root certificate file (DER)."],
  ["certificate", "Leaf certificate", "This computer's own certificate file (DER)."],
  [
    "privateKey",
    "Private key path",
    "Where this computer's private key file is. Never paste key bytes.",
  ],
  ["crl", "Revocation list", "The pair's current revocation list file (CRL, DER)."],
  [
    "revocationState",
    "Revocation floor file",
    "The saved revocation floor. A missing existing floor is never recreated.",
  ],
];

const ROOT_SHA256 =
  "The full root fingerprint, confirmed with the other person through a separate trusted channel.";

function sha256Row(draft: RemoteDraft): Row {
  return hashField("rootSha256", "Root SHA256", ROOT_SHA256, {
    get: () => draft.rootSha256,
    set: (value) => {
      draft.rootSha256 = value;
    },
  });
}

const isMessage = Schema.is(Schema.String);

function offerRows(draft: RemoteDraft, options: RemoteOptions): Array<Row> {
  return [
    textField({
      id: "offerPath",
      label: "Offer file",
      description: "The public offer file the other computer made. It is only read here.",
      placeholder: "/path/to/offer.json",
      get: () => draft.offerPath,
      save: async (value) => {
        const offer = await readOffer(value);

        if (isMessage(offer)) {
          return { error: offer };
        }

        return {
          apply: () => {
            draft.offerPath = value;
            draft.offer = offer;
            options.adopt?.(offer.localMachineId);
          },
        };
      },
    }),
    sha256Row(draft),
  ];
}

function existingRows(draft: RemoteDraft): Array<Row> {
  return [
    ...CREDENTIALS.map(([key, label, description]) =>
      pathField(key, label, description, {
        get: () => draft.paths[key],
        set: (value) => {
          draft.paths = { ...draft.paths, [key]: value };
        },
      }),
    ),
    cycleField({
      id: "floor",
      label: "Floor",
      description:
        "Existing: never create a missing floor (choose this for any trust used before). Genuinely initial: create a new one.",
      options: [
        ["existing", "Existing"],
        ["new", "Genuinely initial"],
      ],
      get: () => draft.floor,
      set: (value) => {
        draft.floor = value;
      },
    }),
    sha256Row(draft),
  ];
}

function peerRow(draft: RemoteDraft, options: RemoteOptions): Row {
  if (draft.kind === "join") {
    return {
      id: "peer",
      label: "Peer machine",
      value: draft.offer === undefined ? "From the offer" : visibleText(draft.offer.peerMachineId),
      description: "The computer that made the offer; read from the offer file.",
      activation: { kind: "none" },
    };
  }

  return textField({
    id: "peer",
    label: "Peer machine",
    description:
      options.peer === undefined
        ? "The other computer's machine name, exactly as it set it."
        : `Re-pairing keeps the same peer: ${visibleText(options.peer)}.`,
    placeholder: options.peer ?? "peer-machine",
    get: () => draft.peer,
    save: validated(machineError, (value) => {
      draft.peer = value;
    }),
  });
}

export function remoteRows(draft: RemoteDraft, options: RemoteOptions = {}): Array<Row> {
  const kinds = KINDS.filter(([kind]) => options.kinds?.includes(kind) ?? true);

  return [
    cycleField({
      id: "trust",
      label: "Trust",
      description:
        "Create: this computer makes a new pair. Join: use the other computer's offer. Existing: use certificate files you already have.",
      options: kinds,
      get: () => draft.kind,
      set: (value) => {
        draft.kind = value;
      },
    }),
    ...(draft.kind === "join" ? offerRows(draft, options) : []),
    peerRow(draft, options),
    cycleField({
      id: "connection",
      label: "Connection",
      description: "Connect: this computer dials the peer. Listen: the peer dials this computer.",
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
      description:
        draft.mode === "connect"
          ? "The peer's IP address and port, like 192.168.1.20:7443."
          : "The IP address and port to listen on. This opens a network port.",
      placeholder: "IPv4:port or [IPv6]:port",
      get: () => draft.address,
      save: validated(addressError, (value) => {
        draft.address = value;
      }),
    }),
    ...(draft.kind === "existing" ? existingRows(draft) : []),
  ];
}

function missing(draft: RemoteDraft): string | undefined {
  const required: Array<readonly [string, string]> = [
    ...(draft.kind === "join"
      ? [
          ["Offer file", draft.offer === undefined ? "" : draft.offerPath] as const,
          ["Root SHA256", draft.rootSha256] as const,
        ]
      : [["Peer machine", draft.peer] as const]),
    ["Address", draft.address],
    ...(draft.kind === "existing"
      ? [
          ...CREDENTIALS.map(([key, label]) => [label, draft.paths[key]] as const),
          ["Root SHA256", draft.rootSha256] as const,
        ]
      : []),
  ];

  return required.find(([, value]) => value === "")?.[0];
}

function intentOf(draft: RemoteDraft): RemoteIntent {
  const endpoint = { mode: draft.mode, address: draft.address };

  if (draft.kind === "join" && draft.offer !== undefined) {
    return {
      kind: "join",
      peerMachineId: draft.offer.peerMachineId,
      localMachineId: draft.offer.localMachineId,
      endpoint,
      offerPath: draft.offerPath,
      confirmedRootSha256: draft.rootSha256,
    };
  }

  const intent: RemoteIntent = { kind: draft.kind, peerMachineId: draft.peer, endpoint };

  if (draft.kind === "existing") {
    intent.existing = {
      ...draft.paths,
      confirmedRootSha256: draft.rootSha256,
      floorMode: draft.floor,
    };
  }

  return intent;
}

export function remoteGate(
  draft: RemoteDraft,
  machine: string,
  options: RemoteOptions = {},
): Gate<RemoteIntent> {
  const absent = missing(draft);

  if (absent !== undefined) {
    return { kind: "missing", reason: absent };
  }

  if (options.kinds !== undefined && !options.kinds.includes(draft.kind)) {
    return { kind: "invalid", reason: "choose a new pair here" };
  }

  const intent = intentOf(draft);

  if (intent.localMachineId !== undefined && intent.localMachineId !== machine) {
    return {
      kind: "invalid",
      reason: `the offer is for ${visibleText(intent.localMachineId)}, not this computer`,
    };
  }

  if (intent.peerMachineId === machine) {
    return { kind: "invalid", reason: "the peer must be another computer" };
  }

  if (options.peer !== undefined && intent.peerMachineId !== options.peer) {
    return { kind: "invalid", reason: `re-pairing keeps peer ${visibleText(options.peer)}` };
  }

  if (options.oldRoot !== undefined && intent.confirmedRootSha256 === options.oldRoot) {
    return { kind: "invalid", reason: "use the new root, not the old one" };
  }

  return { kind: "ready", value: intent };
}
