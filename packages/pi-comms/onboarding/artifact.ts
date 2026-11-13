import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { isGatewayVersion, validatePin } from "./catalog.js";
import type { GatewayReleasePin } from "./catalog.js";

export const MAX_ARCHIVE = 64 * 1024 * 1024;
export const MAX_BINARY = 128 * 1024 * 1024;
export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
/**
 * Immutable semantic release tag; a published version is never overwritten. Rejects any version
 * outside the trusted pin shape itself, so no caller can build a tag or URL path from it.
 */
export function gatewayReleaseTag(version: string): string {
  if (!isGatewayVersion(version)) {
    throw new Error("Invalid trusted gateway pin");
  }
  return `pi-gateway-v${version}`;
}
export type ArtifactRecord = {
  schema: number;
  sourceRevision: string;
  version: string;
  target: string;
  file: string;
  size: number;
  sha256: string;
  binarySize: number;
  binarySha256: string;
  [key: string]: unknown;
};
export type ArtifactManifest = {
  schema: number;
  sourceRevision: string;
  version: string;
  releaseTag: string;
  artifacts: ArtifactRecord[];
};

export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}
function isManifest(value: unknown): value is ArtifactManifest {
  const object = jsonObject(value);
  return (
    typeof object.schema === "number" &&
    typeof object.sourceRevision === "string" &&
    typeof object.version === "string" &&
    typeof object.releaseTag === "string" &&
    Array.isArray(object.artifacts) &&
    object.artifacts.every((entry: unknown) => {
      const item = jsonObject(entry);
      return (
        ["sourceRevision", "version", "target", "file", "sha256", "binarySha256"].every(
          (key) => typeof item[key] === "string",
        ) && ["schema", "size", "binarySize"].every((key) => typeof item[key] === "number")
      );
    })
  );
}

export function verifyManifest(
  data: Buffer,
  pin: GatewayReleasePin,
  target: string,
): { manifest: ArtifactManifest; record: ArtifactRecord } {
  validatePin(pin);
  if (data.length > 65_536 || sha256(data) !== pin.manifestSha256) {
    throw new Error("Manifest trusted pin mismatch");
  }
  const manifest: unknown = JSON.parse(data.toString("utf8"));
  if (!isManifest(manifest)) {
    throw new Error("Invalid release shape");
  }
  validateManifestIdentity(manifest, pin);
  validateArtifactIdentities(manifest, pin);
  const record = manifest.artifacts.find((item) => item.target === target);
  if (!record) {
    throw new Error("Missing native target");
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
    throw new Error("Invalid release identity/schema");
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
      throw new Error("Invalid artifact identity");
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
      throw new Error("Invalid artifact size");
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(item.sha256) || !/^[a-f0-9]{64}$/u.test(item.binarySha256)) {
    throw new Error("Invalid artifact digest");
  }
}

function text(bytes: Buffer): string {
  return bytes.subarray(0, bytes.includes(0) ? bytes.indexOf(0) : bytes.length).toString("utf8");
}
function octal(bytes: Buffer): number {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error("Invalid tar integer");
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
    throw new Error("Missing archive members");
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
      throw new Error("Truncated archive");
    }
    members.set(name, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  if (
    members.size !== 2 ||
    tar.length - offset < 1024 ||
    !tar.subarray(offset).every((byte) => byte === 0)
  ) {
    throw new Error("Invalid archive trailer/members");
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
  const metadata = jsonObject(JSON.parse(release.toString("utf8")));
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
