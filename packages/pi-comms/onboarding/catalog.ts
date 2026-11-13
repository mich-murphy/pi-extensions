/** Trusted extension metadata, never populated from a downloaded checksum. */
export type GatewayReleasePin = {
  sourceRevision: string;
  version: string;
  manifestSha256: string;
};

export type GatewayNixPin = Pick<GatewayReleasePin, "sourceRevision" | "version"> & {
  /** Canonical SHA-256 SRI of the reviewed source tree, not a downloaded checksum. */
  narHash: string;
};

export type GatewayCatalog = {
  nix: GatewayNixPin | null;
  native: GatewayReleasePin | null;
};

export const GATEWAY_WIRE_VERSION = 1;
export const GATEWAY_MANAGED_CAPABILITY = "managed-on-demand-v1";
export const GATEWAY_LOCK_CAPABILITIES = ["setup-lock-v1"] as const;
export const GATEWAY_LOCAL_SETUP_CAPABILITIES = [
  ...GATEWAY_LOCK_CAPABILITIES,
  "config-generation-v1",
  "gateway-control-v1",
] as const;
export const GATEWAY_REMOTE_SETUP_CAPABILITIES = [
  ...GATEWAY_LOCAL_SETUP_CAPABILITIES,
  "pairing-v1",
] as const;

// Nix: reviewed immutable producer commit; its NAR hash was derived independently from a
// local `git archive` of that revision (never from a downloaded self-reported hash). This
// catalog commit is necessarily a descendant of the pinned revision.
// Native: deliberately unavailable until the release is published and its manifest is pinned.
export const gatewayCatalog: GatewayCatalog = {
  nix: {
    sourceRevision: "8b894b5367657abc9dddf5d35c7bb0df62472d09",
    version: "0.1.0",
    narHash: "sha256-p6+aFd9IqmfpiyF7xzklDCwtyu2rpYKEnj0MEUMQQYs=",
  },
  native: null,
};

export function gatewayTarget(
  platform = process.platform as string,
  arch = process.arch as string,
): string | undefined {
  return (
    {
      "darwin/arm64": "aarch64-apple-darwin",
      "linux/arm64": "aarch64-unknown-linux-gnu",
      "linux/x64": "x86_64-unknown-linux-gnu",
    } as Record<string, string>
  )[`${platform}/${arch}`];
}

export function validatePin(
  pin: Pick<GatewayReleasePin, "sourceRevision" | "version"> & {
    manifestSha256?: string;
    narHash?: string;
  },
): void {
  if (
    !/^[a-f0-9]{40}$/u.test(pin.sourceRevision) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(pin.version) ||
    (pin.manifestSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(pin.manifestSha256)) ||
    (pin.narHash !== undefined &&
      (!/^sha256-[A-Za-z0-9+/]{43}=$/u.test(pin.narHash) ||
        `sha256-${Buffer.from(pin.narHash.slice(7), "base64").toString("base64")}` !== pin.narHash))
  ) {
    throw new Error("Invalid trusted gateway pin");
  }
}

export function discoverGateway(
  options: { platform?: string; arch?: string; nixAvailable: boolean },
  catalog = gatewayCatalog,
) {
  const target = gatewayTarget(options.platform, options.arch);
  let preferred: "nix" | "native" | undefined;
  let unavailableReason: string | undefined;
  if (target === undefined) {
    unavailableReason = "No reviewed target for this OS/architecture";
  } else if (options.nixAvailable && catalog.nix !== null) {
    preferred = "nix";
  } else if (catalog.native === null) {
    unavailableReason =
      catalog.nix === null
        ? "No reviewed immutable gateway source or published artifact pin is shipped"
        : "Pinned Nix source exists, but no usable Nix executable or published native fallback is available";
  } else {
    preferred = "native";
  }
  return {
    target,
    preferred,
    nix: target !== undefined && options.nixAvailable ? catalog.nix : null,
    native: target === undefined ? null : catalog.native,
    unavailableReason,
  };
}
