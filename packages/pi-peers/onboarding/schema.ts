import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { dropRetiredPermissions } from "../adapter/config.js";

const text = Schema.String;

const path = text.check(
  Schema.makeFilter<string>((value) => isAbsolute(value) && !/\p{Cc}/u.test(value)),
);

const hash = text.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const machine = text.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u));
const endpoint = Schema.Struct({
  mode: Schema.Literals(["connect", "listen"]),
  address: text,
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

const parseJsonString = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const pinnedRemote = Schema.Struct({
  machineId: machine,
  endpoint,
  privateKey: path,
  peerPublicKey: hash,
});

const retiredRemote = Schema.Struct({
  machineId: machine,
  endpoint,
  rootCertificates: Schema.Array(path),
  certificateChain: Schema.Array(path),
  issuerCertificates: Schema.Array(path),
  privateKey: path,
  crls: Schema.Array(path),
  revocationState: path,
});

export type PinnedRemote = typeof pinnedRemote.Type;
export type GatewayRemote = PinnedRemote | typeof retiredRemote.Type;
export const isPinnedRemote = Schema.is(pinnedRemote);

const permissions = Schema.Array(Schema.Literals(["discover", "push"]));

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
  remote: Schema.optionalKey(Schema.Union([pinnedRemote, retiredRemote])),
});

export function parseJson(bytes: Buffer | string): Schema.Json {
  return parseJsonString(bytes.toString());
}

export const decodeRecord = Schema.decodeUnknownSync(Schema.JsonObject);
export const decodeManaged = Schema.decodeUnknownSync(managedSchema, { onExcessProperty: "error" });
export const decodeCached = Schema.decodeUnknownSync(cachedSchema, { onExcessProperty: "error" });
export const decodeReset = Schema.decodeUnknownSync(resetSchema, { onExcessProperty: "error" });
export const decodeOwnership = Schema.decodeUnknownSync(ownershipSchema);
const decodeGatewayFields = Schema.decodeUnknownSync(gatewaySchema, {
  onExcessProperty: "error",
});

export function decodeGateway(value: Schema.Json): typeof gatewaySchema.Type {
  return decodeGatewayFields(dropRetiredPermissions(value));
}
