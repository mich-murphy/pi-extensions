export type GatewayReleasePin = {
  sourceRevision: string;
  version: string;
  manifestSha256: string;
};

export type GatewayNixPin = Pick<GatewayReleasePin, "sourceRevision" | "version"> & {
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

export const gatewayCatalog: GatewayCatalog = {
  nix: {
    sourceRevision: "e7eafc877ff1e19934f01f69f8edd3680c826598",
    version: "0.1.1",
    narHash: "sha256-jUHlKJSGGIrRs5dhwdqM68s6zW2IZlqBwAIW5YCL8C4=",
  },
  native: {
    sourceRevision: "e7eafc877ff1e19934f01f69f8edd3680c826598",
    version: "0.1.1",
    manifestSha256: "4484725f4240c70f5c27f5b8179a877685fadb216f06deada9dc45d7e4147f51",
  },
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

export function isGatewayVersion(version: unknown): version is string {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version);
}

export function validatePin(
  pin: Pick<GatewayReleasePin, "sourceRevision" | "version"> & {
    manifestSha256?: string;
    narHash?: string;
  },
): void {
  if (
    !/^[a-f0-9]{40}$/u.test(pin.sourceRevision) ||
    !isGatewayVersion(pin.version) ||
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
    unavailableReason = "no verified gateway for this OS and CPU";
  } else if (options.nixAvailable && catalog.nix !== null) {
    preferred = "nix";
  } else if (catalog.native === null) {
    unavailableReason =
      catalog.nix === null
        ? "this pi-peers version ships no verified gateway"
        : "Nix is not installed and there is no verified download for this platform";
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
