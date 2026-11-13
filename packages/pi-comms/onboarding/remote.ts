import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { chooseRemoteTrust, inputChoice, selectChoice } from "./dialog.js";
import type { DialogContext } from "./dialog.js";
import { createPrivate, regularBytes, privateDirectory } from "./files.js";
import { credentials, pairAction } from "./pair.js";
import type { Credentials } from "./pair.js";
import type { LocalPlan } from "./plan.js";
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
async function required(
  ctx: DialogContext,
  title: string,
  placeholder: string,
): Promise<string | undefined> {
  const value = await inputChoice(ctx, title, placeholder);
  return value === undefined || value === "" ? undefined : value;
}
async function endpointChoice(ctx: DialogContext): Promise<RemoteIntent["endpoint"] | undefined> {
  const role = await selectChoice(
    ctx,
    "Remote endpoint — one peer only, no inferred public listener",
    ["Connect to peer", "Listen for peer", "Cancel"],
  );
  if (role === undefined || role === "Cancel") {
    return undefined;
  }
  const address = await required(
    ctx,
    role === "Connect to peer" ? "Peer IP:port" : "Local listener IP:port (explicit TCP exposure)",
    "127.0.0.1:7443",
  );
  if (address === undefined) {
    return undefined;
  }
  const match = /^(?:\[(?<ipv6>[^\]]+)\]|(?<ipv4>[^:]+)):(?<port>\d+)$/u.exec(address);
  if (
    !match ||
    !isIP(match.groups?.ipv6 ?? match.groups?.ipv4 ?? "") ||
    Number(match.groups?.port) < 1 ||
    Number(match.groups?.port) > 65_535
  ) {
    throw new Error("Expected explicit IPv4:port or [IPv6]:port");
  }
  return { mode: role === "Connect to peer" ? "connect" : "listen", address };
}
async function joinPreview(ctx: DialogContext) {
  const offerPath = await required(
    ctx,
    "Absolute path to initiator's PUBLIC offer file",
    "/path/to/offer.json",
  );
  if (offerPath === undefined) {
    return undefined;
  }
  if (!isAbsolute(offerPath)) {
    throw new Error("Expected absolute public offer path");
  }
  const bytes = await regularBytes(offerPath, true);
  if (bytes === undefined) {
    throw new Error("Public offer missing");
  }
  const offer = decodeRecord(parseJson(bytes));
  if (
    typeof offer.machineId !== "string" ||
    typeof offer.peerMachineId !== "string" ||
    !/^[a-z][a-z0-9-]{0,31}$/u.test(offer.machineId) ||
    !/^[a-z][a-z0-9-]{0,31}$/u.test(offer.peerMachineId)
  ) {
    throw new Error("Public offer has invalid machine identifiers");
  }
  const confirmedRootSha256 = await required(
    ctx,
    "Independently confirm initiator's full root SHA256 via a trusted separate channel (not this transferred file)",
    "64 lowercase hex characters",
  );
  if (confirmedRootSha256 === undefined) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/u.test(confirmedRootSha256)) {
    throw new Error("Full independently confirmed root SHA256 required");
  }
  // These names are untrusted suggestions; native signed/bound validation after Apply is authoritative.
  return {
    offerPath,
    confirmedRootSha256,
    peerMachineId: offer.machineId,
    localMachineId: offer.peerMachineId,
  };
}
async function credentialPaths(ctx: DialogContext): Promise<Record<string, string> | undefined> {
  const paths: Record<string, string> = {};
  for (const [key, description] of [
    ["rootCertificate", "Trusted pair root certificate DER"],
    ["certificate", "This machine's leaf certificate DER"],
    ["privateKey", "This machine's PRIVATE key file (path only; never paste key bytes)"],
    ["crl", "Current complete numbered CRL DER"],
    [
      "revocationState",
      "Existing revocation-floor file; missing existing floors MUST NOT be recreated",
    ],
  ]) {
    // eslint-disable-next-line eslint/no-await-in-loop -- Native consent dialogs must remain sequential; cancellation stops subsequent questions.
    const path = await required(ctx, `${description} — absolute path`, "/absolute/path");
    if (path === undefined) {
      return undefined;
    }
    if (!isAbsolute(path)) {
      throw new Error("Credential paths must be absolute");
    }
    paths[key ?? ""] = path;
  }
  return paths;
}
async function existingMaterial(ctx: DialogContext): Promise<RemoteIntent["existing"] | undefined> {
  const paths = await credentialPaths(ctx);
  if (paths === undefined) {
    return undefined;
  }
  const floor = await selectChoice(
    ctx,
    "Revocation floor provenance — choose existing for any previously configured trust",
    [
      "Existing floor — never initialize missing state (recommended)",
      "Genuinely initial material — explicitly create a NEW floor",
      "Cancel",
    ],
  );
  if (floor === undefined || floor === "Cancel") {
    return undefined;
  }
  const confirmedRootSha256 = await required(
    ctx,
    "Independently confirmed root DER SHA256 from trusted channel",
    "64 lowercase hex characters",
  );
  if (confirmedRootSha256 === undefined) {
    return undefined;
  }
  if (!/^[a-f0-9]{64}$/u.test(confirmedRootSha256)) {
    throw new Error("Full root SHA256 required");
  }
  return {
    rootCertificate: paths.rootCertificate ?? "",
    certificate: paths.certificate ?? "",
    privateKey: paths.privateKey ?? "",
    crl: paths.crl ?? "",
    revocationState: paths.revocationState ?? "",
    confirmedRootSha256,
    floorMode: floor.startsWith("Existing") ? "existing" : "new",
  };
}
/** Only public facts and file paths; native helper is authoritative after the one consolidated Apply. */
export async function remoteIntent(ctx: DialogContext): Promise<RemoteIntent | undefined> {
  const kind = await chooseRemoteTrust(ctx);
  if (kind === undefined) {
    return undefined;
  }
  const preview = kind === "join" ? await joinPreview(ctx) : undefined;
  if (kind === "join" && preview === undefined) {
    return undefined;
  }
  const peerMachineId =
    preview?.peerMachineId ??
    (await required(ctx, "Peer's exact certificate-bound machine identity", "peer-machine"));
  if (peerMachineId === undefined) {
    return undefined;
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(peerMachineId)) {
    throw new Error("Peer identity must be lowercase letter-led, at most 32 characters");
  }
  const endpoint = await endpointChoice(ctx);
  if (endpoint === undefined) {
    return undefined;
  }
  const existing = kind === "existing" ? await existingMaterial(ctx) : undefined;
  if (kind === "existing" && existing === undefined) {
    return undefined;
  }
  return {
    kind,
    peerMachineId,
    endpoint,
    ...preview,
    ...(existing === undefined ? {} : { existing }),
  };
}
export function remoteReview(intent: RemoteIntent, directory: string): string {
  return [
    `Remote: ${intent.kind}; one exact peer ${intent.peerMachineId}; ${intent.endpoint.mode} ${intent.endpoint.address}.`,
    "Remote discover/read/push/interest grants apply in both directions for the reviewed scope; authorized remote pushes can wake models and incur provider usage. Only published records are readable.",
    intent.kind === "create"
      ? `Pair-specific initiator CA custody: ${join(directory, "issuer")}; runtime credentials: ${join(directory, "pair")}. The gateway never loads the issuer key. Same-account directories are NOT privilege isolation: account/root compromise requires both machines to re-pair with a new root. Optional offline offload is manual.`
      : "Private leaf keys stay on this machine; exchange public offer/CSR/bundle files only, with independent full SHA256 confirmation. Existing missing revocation floors are never initialized.",
    "Pair roots last 365 days; leaves 90 days; CRLs 30 days. Explicit renewal/CRL export and import before expiry is required. Root compromise/loss requires re-pair; reset retains all keys and floors.",
    "Local connected does not mean remote linked. New pairs may remain pending public exchange; no handshake/readiness claim is made from config alone.",
  ].join("\n");
}
function grantedPlan(plan: LocalPlan, intent: RemoteIntent): LocalPlan {
  if (intent.peerMachineId === plan.adapter.machineId) {
    throw new Error("A trusted pair needs two different machine identities");
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
export function configured(
  plan: LocalPlan,
  intent: RemoteIntent,
  material: Credentials,
): LocalPlan {
  if (
    material.machineId !== plan.adapter.machineId ||
    material.peerMachineId !== intent.peerMachineId
  ) {
    throw new Error("Credential identities differ from reviewed identities");
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
  let output: Record<string, unknown> = {};
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
