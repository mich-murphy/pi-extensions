import { describe, expect, test } from "vitest";
import { jsonObject, sha256, verifyArtifact, verifyManifest } from "../onboarding/artifact.js";
import { fixture, tar } from "./onboarding-artifact-fixture.js";

describe("bounded authenticated artifacts", () => {
  test("accepts exact manifest and object target", () => {
    const f = fixture();
    expect(verifyManifest(f.manifest, f.pin, f.record.target).record).toStrictEqual(f.record);
    expect(verifyArtifact(f.archive, f.record)).toStrictEqual(f.binary);
  });
  test("rejects untrusted manifest before parsing", () => {
    const f = fixture();
    expect(() =>
      verifyManifest(f.manifest, { ...f.pin, manifestSha256: "0".repeat(64) }, f.record.target),
    ).toThrow("pin mismatch");
  });
  test("rejects archive digest and oversized bytes", () => {
    const f = fixture();
    expect(() => verifyArtifact(Buffer.alloc(0), f.record)).toThrow("integrity");
  });
  test.each(["../pi-gateway", "/pi-gateway", "extra"])("rejects unsafe member %s", (name) => {
    const f = fixture();
    const archive = tar([
      [name, f.binary, 0o755],
      ["release.json", Buffer.from("{}"), 0o644],
    ]);
    expect(() =>
      verifyArtifact(archive, { ...f.record, size: archive.length, sha256: sha256(archive) }),
    ).toThrow("Unsafe");
  });
  test("rejects duplicate members and corrupt embedded metadata", () => {
    const f = fixture();
    for (const members of [
      [
        ["pi-gateway", f.binary, 0o755],
        ["pi-gateway", f.binary, 0o755],
      ],
      [
        ["pi-gateway", f.binary, 0o755],
        ["release.json", Buffer.from("{}"), 0o644],
      ],
    ] as [string, Buffer, number][][]) {
      const archive = tar(members);
      expect(() =>
        verifyArtifact(archive, { ...f.record, size: archive.length, sha256: sha256(archive) }),
      ).toThrow(/.+/u);
    }
  });
  test.each([
    ["x86_64-unknown-linux-gnu", "/lib64/ld-linux-x86-64.so.2"],
    ["aarch64-unknown-linux-gnu", "/lib/ld-linux-aarch64.so.1"],
  ])("accepts authenticated Linux ABI metadata and ELF for %s", (target, loader) => {
    const f = fixture(target);
    const { record } = verifyManifest(f.manifest, f.pin, target);
    expect(record).toStrictEqual(f.record);
    expect(record.requirements).toStrictEqual({
      requiredGlibc: "2.34",
      requiredLibgcc: "3.0",
      loader,
      neededLibraries: ["libc.so.6", "libgcc_s.so.1"],
    });
    expect(verifyArtifact(f.archive, record)).toStrictEqual(f.binary);
  });
  test("accepts an authenticated ELF executable as well as a shared-object executable", () => {
    const f = fixture("x86_64-unknown-linux-gnu", (binary) => {
      binary.writeUInt16LE(2, 16);
      return binary;
    });
    expect(verifyArtifact(f.archive, f.record)).toStrictEqual(f.binary);
  });
  test.each([
    ["truncated header", (binary: Buffer) => binary.subarray(0, 63)],
    [
      "magic",
      (binary: Buffer) => {
        binary[0] = 0;
        return binary;
      },
    ],
    [
      "32-bit class",
      (binary: Buffer) => {
        binary[4] = 1;
        return binary;
      },
    ],
    [
      "big-endian encoding",
      (binary: Buffer) => {
        binary[5] = 2;
        return binary;
      },
    ],
    [
      "wrong architecture",
      (binary: Buffer) => {
        binary.writeUInt16LE(183, 18);
        return binary;
      },
    ],
    [
      "non-executable type",
      (binary: Buffer) => {
        binary.writeUInt16LE(1, 16);
        return binary;
      },
    ],
  ] as const)("rejects authenticated Linux binary with %s", (_label, transform) => {
    // Re-pin all digests and embedded metadata: this must reach the ELF check,
    // not fail earlier on an unrelated archive or metadata mismatch.
    const f = fixture("x86_64-unknown-linux-gnu", transform);
    const { record } = verifyManifest(f.manifest, f.pin, f.record.target);
    expect(() => verifyArtifact(f.archive, record)).toThrow("Wrong ELF target");
  });
  test.each([
    ["loader", "/nix/store/unreviewed/ld-linux.so"],
    ["neededLibraries", ["libunexpected.so"]],
    ["requiredGlibc", "2.40"],
    ["requiredLibgcc", null],
  ])("rejects embedded Linux %s differing from the authenticated manifest", (key, value) => {
    const f = fixture("aarch64-unknown-linux-gnu");
    const {
      file: _file,
      size: _size,
      sha256: _hash,
      binarySize: _binarySize,
      binarySha256: _binaryHash,
      ...metadata
    } = f.record;
    const archive = tar([
      ["pi-gateway", f.binary, 0o755],
      [
        "release.json",
        Buffer.from(
          JSON.stringify({
            ...metadata,
            requirements: { ...jsonObject(metadata.requirements), [key]: value },
          }),
        ),
        0o644,
      ],
    ]);
    const record = { ...f.record, size: archive.length, sha256: sha256(archive) };
    const trusted = verifyManifest(f.manifest, f.pin, record.target).manifest;
    const index = trusted.artifacts.findIndex((item) => item.target === record.target);
    trusted.artifacts[index] = record;
    const manifest = Buffer.from(JSON.stringify(trusted));
    const verified = verifyManifest(
      manifest,
      { ...f.pin, manifestSha256: sha256(manifest) },
      record.target,
    );
    expect(() => verifyArtifact(archive, verified.record)).toThrow("Embedded metadata mismatch");
  });
});
