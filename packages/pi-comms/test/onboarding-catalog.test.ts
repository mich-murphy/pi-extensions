import { describe, expect, test } from "vitest";
import {
  discoverGateway,
  gatewayCatalog,
  gatewayTarget,
  validatePin,
} from "../onboarding/catalog.js";

describe("gateway trusted catalog", () => {
  test("does not invent release availability", () => {
    const empty = { nix: null, native: null };
    const linux = { platform: "linux", arch: "x64", nixAvailable: true };
    expect(discoverGateway(linux, empty).preferred).toBeUndefined();
    expect(discoverGateway(linux, empty).unavailableReason).toContain("No reviewed");
  });
  test("ships only a genuine immutable Nix pin and no unpublished native pin", () => {
    const { nix, native } = gatewayCatalog;
    expect(native).toBeNull();
    const reviewed = {
      sourceRevision: "8b894b5367657abc9dddf5d35c7bb0df62472d09",
      version: "0.1.0",
      narHash: "sha256-p6+aFd9IqmfpiyF7xzklDCwtyu2rpYKEnj0MEUMQQYs=",
    };
    expect(nix).toStrictEqual(reviewed);
    expect(() => {
      validatePin(reviewed);
    }).not.toThrow();
    const nixHost = discoverGateway({ platform: "linux", arch: "arm64", nixAvailable: true });
    expect(nixHost.preferred).toBe("nix");
    expect(nixHost.native).toBeNull();
    const noNix = discoverGateway({ platform: "darwin", arch: "arm64", nixAvailable: false });
    expect(noNix.preferred).toBeUndefined();
    expect(noNix.nix).toBeNull();
    expect(noNix.unavailableReason).toContain("no usable Nix executable");
    expect(
      discoverGateway({ platform: "darwin", arch: "x64", nixAvailable: true }).unavailableReason,
    ).toContain("No reviewed target");
  });
  test("detects supported architectures without assuming Intel Darwin", () => {
    expect(gatewayTarget("darwin", "x64")).toBeUndefined();
    expect(gatewayTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
  });
  test("prefers usable pinned Nix and exposes reviewed fallback", () => {
    const pin = {
      sourceRevision: "a".repeat(40),
      version: "0.1.0",
      manifestSha256: "b".repeat(64),
      narHash: `sha256-${Buffer.alloc(32).toString("base64")}`,
    };
    expect(
      discoverGateway(
        { platform: "linux", arch: "x64", nixAvailable: true },
        { nix: pin, native: pin },
      ).preferred,
    ).toBe("nix");
    expect(
      discoverGateway(
        { platform: "linux", arch: "x64", nixAvailable: false },
        { nix: pin, native: pin },
      ).preferred,
    ).toBe("native");
  });
  test("accepts only canonical SHA-256 SRI content pins", () => {
    const pin = { sourceRevision: "a".repeat(40), version: "0.1.0" };
    const canonical = `sha256-${Buffer.alloc(32).toString("base64")}`;
    expect(() => {
      validatePin({ ...pin, narHash: canonical });
    }).not.toThrow();
    for (const narHash of [
      "",
      "sha256-abc",
      canonical.slice(0, -1),
      `${canonical}\n`,
      canonical.replace("sha256", "sha512"),
      canonical.replace("A=", "B="),
      "0".repeat(64),
      `sha256-${Buffer.alloc(31).toString("base64")}`,
    ]) {
      expect(() => {
        validatePin({ ...pin, narHash });
      }).toThrow("Invalid trusted gateway pin");
    }
  });
  test("rejects mutable refs and malformed hashes", () => {
    expect(() => {
      validatePin({ sourceRevision: "main", version: "0.1.0" });
    }).toThrow(/.+/u);
    expect(() => {
      validatePin({ sourceRevision: "a".repeat(40), version: "0.1.0", manifestSha256: "adjacent" });
    }).toThrow(/.+/u);
  });
});
