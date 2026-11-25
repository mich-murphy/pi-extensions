import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Schema } from "effect";
import { isGatewayVersion, validatePin } from "./catalog.js";
import type { GatewayReleasePin } from "./catalog.js";
import { parseJson } from "./schema.js";

export const MAX_ARCHIVE = 64 * 1024 * 1024;
export const MAX_BINARY = 128 * 1024 * 1024;

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function gatewayReleaseTag(version: string): string {
  if (!isGatewayVersion(version)) {
    throw new Error("Invalid trusted gateway pin");
  }

  return `pi-gateway-v${version}`;
}

const artifactRecord = Schema.StructWithRest(
  Schema.Struct({
    schema: Schema.Number,
    sourceRevision: Schema.String,
    version: Schema.String,
    target: Schema.String,
    file: Schema.String,
    size: Schema.Number,
    sha256: Schema.String,
    binarySize: Schema.Number,
    binarySha256: Schema.String,
  }),
  [Schema.JsonObject],
);

export type ArtifactRecord = typeof artifactRecord.Type;

const manifestHeader = Schema.StructWithRest(
  Schema.Struct({
    schema: Schema.Number,
    sourceRevision: Schema.String,
    version: Schema.String,
    releaseTag: Schema.String,
    artifacts: Schema.Array(Schema.Json),
  }),
  [Schema.JsonObject],
);

const isManifestHeader = Schema.is(manifestHeader);
const isArtifactRecord = Schema.is(artifactRecord);
const isJsonObject = Schema.is(Schema.JsonObject);

export type VerifiedManifest = {
  manifest: Omit<typeof manifestHeader.Type, "artifacts"> & {
    readonly artifacts: ArtifactRecord[];
  };
  record: ArtifactRecord;
};

type ArtifactManifest = VerifiedManifest["manifest"];

export function jsonObject(value: Schema.Json | undefined): Schema.JsonObject {
  if (!isJsonObject(value)) {
    throw new Error("Invalid JSON object");
  }

  return value;
}

function readManifest(data: Buffer): ArtifactManifest {
  const manifest = jsonObject(parseJson(data));

  if (!isManifestHeader(manifest)) {
    throw new Error("The gateway release manifest has an unexpected format");
  }

  const artifacts = manifest.artifacts.map((entry) => {
    const record = jsonObject(entry);

    if (!isArtifactRecord(record)) {
      throw new Error("The gateway release manifest has an unexpected format");
    }

    return record;
  });

  const { schema, sourceRevision, version, releaseTag } = manifest;

  return {
    ...Object.fromEntries(Object.entries(manifest)),
    schema,
    sourceRevision,
    version,
    releaseTag,
    artifacts,
  };
}

export function verifyManifest(
  data: Buffer,
  pin: GatewayReleasePin,
  target: string,
): VerifiedManifest {
  validatePin(pin);

  if (data.length > 65_536 || sha256(data) !== pin.manifestSha256) {
    throw new Error("Manifest trusted pin mismatch");
  }

  const manifest = readManifest(data);
  validateManifestIdentity(manifest, pin);
  validateArtifactIdentities(manifest, pin);
  const record = manifest.artifacts.find((item) => item.target === target);

  if (!record) {
    throw new Error("The gateway release has no build for this platform");
  }

  return { manifest, record };
}

function validateManifestIdentity(manifest: ArtifactManifest, pin: GatewayReleasePin): void {
  if (
    manifest.schema !== 2 ||
    manifest.sourceRevision !== pin.sourceRevision ||
    manifest.version !== pin.version ||
    manifest.releaseTag !== gatewayReleaseTag(pin.version) ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== 3
  ) {
    throw new Error("The gateway release manifest has the wrong name or version");
  }
}

function validateArtifactIdentities(manifest: ArtifactManifest, pin: GatewayReleasePin): void {
  const targets = new Set([
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
  ]);

  for (const item of manifest.artifacts) {
    if (
      !targets.delete(item.target) ||
      item.schema !== 2 ||
      item.sourceRevision !== pin.sourceRevision ||
      item.version !== pin.version ||
      item.file !== `pi-gateway-${pin.version}-${item.target}.tar.gz`
    ) {
      throw new Error("The gateway release lists an unexpected file");
    }

    validateArtifactContentClaims(item);
  }
}

function validateArtifactContentClaims(item: ArtifactRecord): void {
  const sizes: [number, number][] = [
    [item.size, MAX_ARCHIVE],
    [item.binarySize, MAX_BINARY],
  ];

  for (const [size, max] of sizes) {
    if (!Number.isSafeInteger(size) || size <= 0 || size > max) {
      throw new Error("The gateway release lists an invalid file size");
    }
  }

  if (!/^[a-f0-9]{64}$/u.test(item.sha256) || !/^[a-f0-9]{64}$/u.test(item.binarySha256)) {
    throw new Error("The gateway release lists an invalid checksum");
  }
}

function text(bytes: Buffer): string {
  return bytes.subarray(0, bytes.includes(0) ? bytes.indexOf(0) : bytes.length).toString("utf8");
}

function octal(bytes: Buffer): number {
  const value = text(bytes).trim();

  if (!/^[0-7]+$/u.test(value)) {
    throw new Error("The gateway archive has a malformed header");
  }

  return Number.parseInt(value, 8);
}

export function verifyArtifact(archive: Buffer, record: ArtifactRecord): Buffer {
  if (
    archive.length !== record.size ||
    archive.length > MAX_ARCHIVE ||
    sha256(archive) !== record.sha256
  ) {
    throw new Error("Archive integrity mismatch");
  }

  const tar = gunzipSync(archive, { maxOutputLength: MAX_BINARY + 32_768 });
  const members = parseTarMembers(tar);
  const binary = members.get("pi-gateway");
  const release = members.get("release.json");

  if (!binary || !release) {
    throw new Error("The gateway archive is missing files");
  }

  validateEmbeddedMetadata(release, record);

  if (binary.length !== record.binarySize || sha256(binary) !== record.binarySha256) {
    throw new Error("Binary integrity mismatch");
  }

  validateBinaryTarget(binary, record.target);

  return binary;
}

function parseTarMembers(tar: Buffer): Map<string, Buffer> {
  const members = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = text(header.subarray(0, 100));
    const size = octal(header.subarray(124, 136));
    validateTarHeader(header, name, size, members);
    offset += 512;

    if (offset + size > tar.length) {
      throw new Error("The gateway archive is cut short");
    }

    members.set(name, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }

  if (
    members.size !== 2 ||
    tar.length - offset < 1024 ||
    !tar.subarray(offset).every((byte) => byte === 0)
  ) {
    throw new Error("The gateway archive has unexpected contents");
  }

  return members;
}

function validateTarHeader(
  header: Buffer,
  name: string,
  size: number,
  members: Map<string, Buffer>,
): void {
  const mode = octal(header.subarray(100, 108));
  const sum = [...header].reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
  validateTarFormat(header, sum);

  if (
    members.has(name) ||
    !["pi-gateway", "release.json"].includes(name) ||
    size > (name === "pi-gateway" ? MAX_BINARY : 16_384) ||
    mode !== (name === "pi-gateway" ? 0o755 : 0o644)
  ) {
    throw new Error("Unsafe archive member");
  }
}

function validateTarFormat(header: Buffer, sum: number): void {
  if (
    sum !== octal(header.subarray(148, 156)) ||
    !header.subarray(257, 263).equals(Buffer.from("ustar\0")) ||
    !header.subarray(263, 265).equals(Buffer.from("00")) ||
    ![0, 48].includes(header[156] ?? -1) ||
    text(header.subarray(157, 257)) ||
    text(header.subarray(345, 500))
  ) {
    throw new Error("Unsafe archive member");
  }
}

function validateEmbeddedMetadata(release: Buffer, record: ArtifactRecord): void {
  const metadata = jsonObject(parseJson(release));

  const {
    file: _file,
    size: _size,
    sha256: _hash,
    binarySize: _binarySize,
    binarySha256: _binaryHash,
    ...expected
  } = record;

  if (
    Object.keys(metadata).length !== Object.keys(expected).length ||
    Object.entries(expected).some(
      ([key, value]) => JSON.stringify(metadata[key]) !== JSON.stringify(value),
    )
  ) {
    throw new Error("Embedded metadata mismatch");
  }
}

function validateBinaryTarget(binary: Buffer, target: string): void {
  if (target.endsWith("apple-darwin")) {
    validateMachO(binary);
  } else {
    validateElf(binary, target);
  }
}

function validateMachO(binary: Buffer): void {
  if (
    binary.length < 32 ||
    binary.readUInt32LE(0) !== 0xfe_ed_fa_cf ||
    binary.readUInt32LE(4) !== 0x1_00_00_0c ||
    binary.readUInt32LE(12) !== 2
  ) {
    throw new Error("Wrong Mach-O target");
  }
}

function validateElf(binary: Buffer, target: string): void {
  if (
    binary.length < 64 ||
    !binary.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) ||
    binary.readUInt16LE(18) !== (target.startsWith("aarch64") ? 183 : 62) ||
    ![2, 3].includes(binary.readUInt16LE(16))
  ) {
    throw new Error("Wrong ELF target");
  }
}
