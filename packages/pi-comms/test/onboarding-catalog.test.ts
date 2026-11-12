import { describe, expect, test } from "vitest";
import { discoverGateway, gatewayTarget, validatePin } from "../onboarding/catalog.js";

describe("gateway trusted catalog", () => {
  test("does not invent release availability", () => {
    expect(discoverGateway({ nixAvailable: true }).preferred).toBeUndefined();
    expect(discoverGateway({ nixAvailable: true }).unavailableReason).toContain("No reviewed");
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
