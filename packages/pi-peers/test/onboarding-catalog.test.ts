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
    expect(discoverGateway(linux, empty).unavailableReason).toContain("ships no verified gateway");
  });
  test("ships the genuine immutable Nix pin and the published native manifest pin", () => {
    const { nix, native } = gatewayCatalog;

    const reviewed = {
      sourceRevision: "a41f2bcecbc5e35da0383e5db162e8b733a1549f",
      version: "0.4.0",
      narHash: "sha256-92AiLvXj9OU7VI2aE8Hs66Qj53PQ0UmR+26cIgZfARQ=",
    };

    const published = {
      sourceRevision: "a41f2bcecbc5e35da0383e5db162e8b733a1549f",
      version: "0.4.0",
      manifestSha256: "cb949acc05ca29590c689330297fdf928dd9e8a56894b73318847bebd1f35ea0",
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
      expect(intel.unavailableReason).toContain("no verified gateway for this OS and CPU");
    }
  });
  test("reports a Nix-only catalog unavailable without usable Nix", () => {
    const nixOnly = { nix: gatewayCatalog.nix, native: null };

    const noNix = discoverGateway(
      { platform: "darwin", arch: "arm64", nixAvailable: false },
      nixOnly,
    );

    expect(noNix.preferred).toBeUndefined();
    expect(noNix.unavailableReason).toContain("Nix is not installed");
  });
  test("detects supported architectures without assuming Intel Darwin", () => {
    expect(gatewayTarget("darwin", "x64")).toBeUndefined();
    expect(gatewayTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
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
    }).toThrow("Invalid trusted gateway pin");
    expect(() => {
      validatePin({ sourceRevision: "a".repeat(40), version: "0.1.0", manifestSha256: "adjacent" });
    }).toThrow("Invalid trusted gateway pin");
  });
});
