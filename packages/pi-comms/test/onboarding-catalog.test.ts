import { describe, expect, test } from "vitest";
import { gatewayReleaseTag } from "../onboarding/artifact.js";
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
  test("ships the genuine immutable Nix pin and the published native manifest pin", () => {
    const { nix, native } = gatewayCatalog;
    const reviewed = {
      sourceRevision: "8b894b5367657abc9dddf5d35c7bb0df62472d09",
      version: "0.1.0",
      narHash: "sha256-p6+aFd9IqmfpiyF7xzklDCwtyu2rpYKEnj0MEUMQQYs=",
    };
    const published = {
      sourceRevision: "8b894b5367657abc9dddf5d35c7bb0df62472d09",
      version: "0.1.0",
      manifestSha256: "04620bae0f5fc038f4e9c2d6ee93c2e13d071109adc1536a901b3110b81965db",
    };
    expect(nix).toStrictEqual(reviewed);
    expect(native).toStrictEqual(published);
    expect(() => {
      validatePin(reviewed);
      validatePin(published);
    }).not.toThrow();
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "arm64"],
      ["linux", "x64"],
    ] as const) {
      const nixHost = discoverGateway({ platform, arch, nixAvailable: true });
      expect(nixHost.preferred).toBe("nix");
      expect(nixHost.nix).toStrictEqual(reviewed);
      expect(nixHost.native).toStrictEqual(published);
      const noNix = discoverGateway({ platform, arch, nixAvailable: false });
      expect(noNix.preferred).toBe("native");
      expect(noNix.nix).toBeNull();
      expect(noNix.native).toStrictEqual(published);
      expect(noNix.unavailableReason).toBeUndefined();
    }
    for (const nixAvailable of [true, false]) {
      const intel = discoverGateway({ platform: "darwin", arch: "x64", nixAvailable });
      expect(intel.preferred).toBeUndefined();
      expect(intel.native).toBeNull();
      expect(intel.unavailableReason).toContain("No reviewed target");
    }
  });
  test("reports a Nix-only catalog unavailable without usable Nix", () => {
    const nixOnly = { nix: gatewayCatalog.nix, native: null };
    const noNix = discoverGateway(
      { platform: "darwin", arch: "arm64", nixAvailable: false },
      nixOnly,
    );
    expect(noNix.preferred).toBeUndefined();
    expect(noNix.unavailableReason).toContain("no usable Nix executable");
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
  test("rejects non-semver versions in pins and release tags alike", () => {
    const pin = { sourceRevision: "a".repeat(40), manifestSha256: "b".repeat(64) };
    for (const version of [
      "",
      "0.1",
      "v0.1.0",
      "0.1.0\n",
      "0.1.0\nx",
      " 0.1.0",
      "0.1.0/../x",
      "0.1.0/x",
      "0.1.0-a/b",
      "0.1.0?x",
      "0.1.0#x",
      "0.1.0%2F",
      "0.1.0-",
    ]) {
      expect(() => {
        validatePin({ ...pin, version });
      }).toThrow("Invalid trusted gateway pin");
      expect(() => gatewayReleaseTag(version)).toThrow("Invalid trusted gateway pin");
    }
    expect(gatewayReleaseTag("0.1.0")).toBe("pi-gateway-v0.1.0");
    expect(gatewayReleaseTag("1.2.3-rc.1")).toBe("pi-gateway-v1.2.3-rc.1");
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
