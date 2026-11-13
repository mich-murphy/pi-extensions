import { gzipSync } from "node:zlib";
import { sha256 } from "../onboarding/artifact.js";
import type { ArtifactRecord } from "../onboarding/artifact.js";

export function fixture(
  target = "aarch64-apple-darwin",
  transformBinary: (binary: Buffer) => Buffer = (binary) => binary,
) {
  let binary: Buffer = Buffer.alloc(128);
  if (target.endsWith("darwin")) {
    binary.writeUInt32LE(0xfe_ed_fa_cf);
    binary.writeUInt32LE(0x1_00_00_0c, 4);
    binary.writeUInt32LE(2, 12);
  } else {
    Buffer.from([127, 69, 76, 70, 2, 1]).copy(binary);
    binary.writeUInt16LE(3, 16);
    binary.writeUInt16LE(target.startsWith("aarch64") ? 183 : 62, 18);
  }
  binary = transformBinary(binary);
  const metadata = artifactMetadata(target);
  const archive = tar([
    ["pi-gateway", binary, 0o755],
    ["release.json", Buffer.from(JSON.stringify(metadata)), 0o644],
  ]);
  const record: ArtifactRecord = {
    ...metadata,
    file: `pi-gateway-0.1.0-${target}.tar.gz`,
    size: archive.length,
    sha256: sha256(archive),
    binarySize: binary.length,
    binarySha256: sha256(binary),
  };
  const records = [
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
  ].map((t) => ({ ...record, ...artifactMetadata(t), file: `pi-gateway-0.1.0-${t}.tar.gz` }));
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 2,
      sourceRevision: metadata.sourceRevision,
      version: metadata.version,
      releaseTag: `pi-gateway-v${metadata.version}`,
      artifacts: records,
    }),
  );
  return {
    binary,
    archive,
    record,
    manifest,
    pin: {
      sourceRevision: metadata.sourceRevision,
      version: metadata.version,
      manifestSha256: sha256(manifest),
    },
  };
}
function artifactMetadata(target: string) {
  return {
    schema: 2,
    sourceRevision: "a".repeat(40),
    version: "0.1.0",
    target,
    testedBaseline: target.endsWith("darwin") ? "15.0" : "glibc-2.39",
    requirements: target.endsWith("darwin")
      ? { minimumMacos: "15.0" }
      : {
          requiredGlibc: "2.34",
          requiredLibgcc: "3.0",
          loader: target.startsWith("aarch64")
            ? "/lib/ld-linux-aarch64.so.1"
            : "/lib64/ld-linux-x86-64.so.2",
          neededLibraries: ["libc.so.6", "libgcc_s.so.1"],
        },
  };
}

export function tar(members: [string, Buffer, number][]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, bytes, mode] of members) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(mode.toString(8).padStart(7, "0"), 100);
    header.write(bytes.length.toString(8).padStart(11, "0"), 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write(
      `${[...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
    );
    parts.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
