import { isAbsolute } from "node:path";
import { Schema } from "effect";

const text = Schema.String;
const path = text.check(
  Schema.makeFilter<string>((value) => isAbsolute(value) && !/\p{Cc}/u.test(value)),
);
const hash = text.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const machine = text.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u));
const endpoint = Schema.Struct({ mode: Schema.Literals(["connect", "listen"]), address: text });
export const credentialSchema = Schema.Struct({
  machineId: machine,
  peerMachineId: machine,
  pairId: hash,
  rootCertificates: Schema.Array(path),
  certificateChain: Schema.Array(path),
  issuerCertificates: Schema.Array(path),
  privateKey: path,
  crls: Schema.Array(path),
  revocationState: path,
});
export const managedSchema = Schema.Struct({
  version: Schema.Literal(1),
  executable: path,
  executableSha256: hash,
  adapterSha256: hash,
  gatewaySha256: hash,
  pairingSha256: Schema.optionalKey(hash),
  gatewayPath: path,
  socketPath: path,
});
export const cachedSchema = Schema.Struct({ executable: path, sha256: hash });
const resetSchema = Schema.Array(Schema.Struct({ path, backup: path, sha256: hash }));
const ownershipSchema = Schema.Struct({
  adapterSha256: Schema.optionalKey(hash),
  gatewaySha256: Schema.optionalKey(hash),
  pairingSha256: Schema.optionalKey(hash),
  previousAdapterSha256: Schema.optionalKey(hash),
  previousGatewaySha256: Schema.optionalKey(hash),
});
const existing = Schema.Struct({
  rootCertificate: path,
  certificate: path,
  privateKey: path,
  crl: path,
  revocationState: path,
  confirmedRootSha256: hash,
  floorMode: Schema.Literals(["new", "existing"]),
});
const intent = Schema.Struct({
  kind: Schema.Literals(["create", "join", "existing"]),
  peerMachineId: machine,
  endpoint,
  localMachineId: Schema.optionalKey(machine),
  offerPath: Schema.optionalKey(path),
  confirmedRootSha256: Schema.optionalKey(hash),
  existing: Schema.optionalKey(existing),
});
const record = Schema.Record(text, Schema.Unknown);
const pairingSchema = Schema.Struct({
  version: Schema.Literal(1),
  intent,
  runtimeDir: path,
  issuerDir: path,
  output: record,
  inspection: Schema.optionalKey(record),
});
const permissions = Schema.Array(Schema.Literals(["discover", "read", "push", "interest"]));
const gatewaySchema = Schema.Struct({
  machineId: machine,
  socketPath: path,
  scopeIds: Schema.Array(text),
  policies: Schema.Array(
    Schema.Struct({
      machineId: machine,
      scopeId: text,
      permissions,
      direction: Schema.Literals(["outgoing", "incoming"]),
    }),
  ),
  remote: Schema.optionalKey(
    Schema.Struct({
      machineId: machine,
      endpoint,
      rootCertificates: Schema.Array(path),
      certificateChain: Schema.Array(path),
      issuerCertificates: Schema.Array(path),
      privateKey: path,
      crls: Schema.Array(path),
      revocationState: path,
    }),
  ),
});
export function parseJson(bytes: Buffer | string): unknown {
  return JSON.parse(bytes.toString());
}
export function decodeRecord(value: unknown): Record<string, unknown> {
  return Schema.decodeUnknownSync(record)(value);
}
export const decodeManaged = Schema.decodeUnknownSync(managedSchema, { onExcessProperty: "error" });
export const decodeCached = Schema.decodeUnknownSync(cachedSchema, { onExcessProperty: "error" });
export const decodeReset = Schema.decodeUnknownSync(resetSchema, { onExcessProperty: "error" });
export const decodeOwnership = Schema.decodeUnknownSync(ownershipSchema);
export const decodePairing = Schema.decodeUnknownSync(pairingSchema, { onExcessProperty: "error" });
export const decodeGateway = Schema.decodeUnknownSync(gatewaySchema, { onExcessProperty: "error" });
export const decodeCredentials = Schema.decodeUnknownSync(credentialSchema);
