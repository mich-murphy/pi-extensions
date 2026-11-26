import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { Schema } from "effect";
import { createPrivate, regularBytes, privateDirectory } from "./files.js";
import { credentials, pairAction } from "./pair.js";
import type { Credentials } from "./pair.js";
import type { LocalPlan } from "./plan.js";
import { RefusalError } from "./refusal.js";
import { decodeRecord, parseJson } from "./schema.js";

export type RemoteIntent = {
  kind: "create" | "join" | "existing";
  peerMachineId: string;
  endpoint: { mode: "connect" | "listen"; address: string };
  offerPath?: string;
  confirmedRootSha256?: string;
  localMachineId?: string;
  existing?: {
    rootCertificate: string;
    certificate: string;
    privateKey: string;
    crl: string;
    revocationState: string;
    confirmedRootSha256: string;
    floorMode: "new" | "existing";
  };
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
    : "Use an IP address and port, like 192.168.1.20:7443 or [fe80::1]:7443.";
}

export function sha256Error(value: string): string | undefined {
  return /^[a-f0-9]{64}$/u.test(value)
    ? undefined
    : "Use the full SHA256: 64 lowercase hex characters.";
}

export function pathError(value: string): string | undefined {
  return isAbsolute(value) ? undefined : "Use an absolute path, starting with /.";
}

const validOfferNames = Schema.is(
  Schema.Struct({
    machineId: Schema.String.check(Schema.isPattern(MACHINE)),
    peerMachineId: Schema.String.check(Schema.isPattern(MACHINE)),
  }),
);

export type OfferPreview = { readonly peerMachineId: string; readonly localMachineId: string };

export async function readOffer(path: string): Promise<OfferPreview | string> {
  const invalid = pathError(path);

  if (invalid !== undefined) {
    return invalid;
  }

  let offer: Schema.JsonObject;

  try {
    const bytes = await regularBytes(path, true);

    if (bytes === undefined) {
      return "No file at that path.";
    }

    offer = decodeRecord(parseJson(bytes));
  } catch {
    return "That file could not be read as a public offer.";
  }

  if (!validOfferNames(offer)) {
    return "That offer has invalid machine names.";
  }

  return { peerMachineId: offer.machineId, localMachineId: offer.peerMachineId };
}

export function remoteReview(intent: RemoteIntent, directory: string): string {
  return [
    `Remote: ${intent.kind}; one exact peer ${intent.peerMachineId}; ${intent.endpoint.mode} ${intent.endpoint.address}.`,
    "Remote discover/push grants apply in both directions for the reviewed scope; authorized remote pushes can wake models and incur provider usage.",
    intent.kind === "create"
      ? `Pair-specific initiator CA custody: ${join(directory, "issuer")}; runtime credentials: ${join(directory, "pair")}. The gateway never loads the issuer key. Same-account directories are NOT privilege isolation: account/root compromise requires both machines to re-pair with a new root. Optional offline offload is manual.`
      : "Private leaf keys stay on this machine; exchange public offer/CSR/bundle files only, with independent full SHA256 confirmation. Missing revocation records are never recreated.",
    "Pair roots last 365 days; leaves 90 days; CRLs 30 days. Explicit renewal/CRL export and import before expiry is required. Root compromise/loss requires re-pair; reset keeps all keys and revocation records.",
    "Local connected does not mean remote linked. New pairs may remain pending public exchange; no handshake/readiness claim is made from config alone.",
  ].join("\n");
}

function grantedPlan(plan: LocalPlan, intent: RemoteIntent): LocalPlan {
  if (intent.peerMachineId === plan.adapter.machineId) {
    throw new RefusalError(
      "this computer and the peer have the same machine name",
      "Give one of them a different machine name",
    );
  }

  const grant = {
    machineId: intent.peerMachineId,
    scopeId: plan.choices.scopeId,
    permissions: [...plan.choices.permissions],
  };

  return {
    ...plan,
    adapter: {
      ...plan.adapter,
      policies: [
        ...plan.adapter.policies.filter((policy) => policy.machineId !== intent.peerMachineId),
        ...(grant.permissions.length === 0 ? [] : [grant]),
      ],
    },
    gateway: {
      ...plan.gateway,
      policies: [
        ...plan.gateway.policies.filter((policy) => policy.machineId !== intent.peerMachineId),
        ...(grant.permissions.length === 0
          ? []
          : [
              { ...grant, direction: "outgoing" as const },
              { ...grant, direction: "incoming" as const },
            ]),
      ],
    },
  };
}

export function keptPair(
  plan: LocalPlan,
  intent: RemoteIntent,
  remote: LocalPlan["gateway"]["remote"],
): LocalPlan {
  const granted = grantedPlan(plan, intent);

  return remote === undefined ? granted : { ...granted, gateway: { ...granted.gateway, remote } };
}

export function configured(
  plan: LocalPlan,
  intent: RemoteIntent,
  material: Credentials,
): LocalPlan {
  if (
    material.machineId !== plan.adapter.machineId ||
    material.peerMachineId !== intent.peerMachineId
  ) {
    throw new RefusalError(
      "the certificate files name a different machine",
      "Check the certificate files, then try again",
    );
  }

  const granted = grantedPlan(plan, intent);

  return {
    ...granted,
    gateway: {
      ...granted.gateway,
      remote: {
        machineId: material.peerMachineId,
        endpoint: intent.endpoint,
        rootCertificates: material.rootCertificates,
        certificateChain: material.certificateChain,
        issuerCertificates: material.issuerCertificates,
        privateKey: material.privateKey,
        crls: material.crls,
        revocationState: material.revocationState,
      },
    },
  };
}

export async function prepareRemote(
  executable: string,
  directory: string,
  plan: LocalPlan,
  intent: RemoteIntent,
): Promise<LocalPlan> {
  await privateDirectory(directory);
  const runtimeDir = join(directory, "pair");
  let material: Credentials | undefined;
  let output: Schema.JsonObject = {};

  if (intent.kind === "create") {
    output = await pairAction(executable, directory, "create", {
      issuerDir: join(directory, "issuer"),
      runtimeDir,
      machineId: plan.adapter.machineId,
      peerMachineId: intent.peerMachineId,
    });
    material = credentials(output.credentials);
  } else if (intent.kind === "existing") {
    output = await pairAction(executable, directory, "import-existing", {
      ...intent.existing,
      runtimeDir,
      machineId: plan.adapter.machineId,
      peerMachineId: intent.peerMachineId,
    });
    material = credentials(output);
  } else if (intent.kind === "join") {
    output = await pairAction(executable, directory, "join", {
      runtimeDir,
      offerPath: intent.offerPath,
      confirmedRootSha256: intent.confirmedRootSha256,
    });
  }

  const inspection = await pairAction(executable, directory, "inspect", {
    runtimeDir,
  });

  await createPrivate(
    join(directory, "pairing.json"),
    JSON.stringify({
      version: 1,
      intent,
      runtimeDir,
      issuerDir: join(directory, "issuer"),
      output,
      inspection,
    }),
  );

  return material === undefined
    ? grantedPlan(
        {
          ...plan,
          gateway: {
            machineId: plan.gateway.machineId,
            socketPath: plan.gateway.socketPath,
            scopeIds: plan.gateway.scopeIds,
            policies: plan.gateway.policies,
          },
        },
        intent,
      )
    : configured(plan, intent, material);
}
