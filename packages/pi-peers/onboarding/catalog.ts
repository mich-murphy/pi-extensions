import { Schema } from "effect";

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

export const GATEWAY_WIRE_VERSION = 2;

export function wireMismatch(
  source: string,
  pinned: string,
  wires: Schema.Json | undefined,
): string {
  return `${source} gateway ${pinned} (pinned) speaks wire ${JSON.stringify(wires ?? null)}; this adapter needs wire ${String(GATEWAY_WIRE_VERSION)}. Tag a gateway release that speaks it and re-pin the catalog.`;
}

export const GATEWAY_MANAGED_CAPABILITY = "managed-on-demand-v1";
export const GATEWAY_LOCK_CAPABILITIES = ["setup-lock-v1"] as const;

export const GATEWAY_LOCAL_SETUP_CAPABILITIES = [
  ...GATEWAY_LOCK_CAPABILITIES,
  "config-generation-v1",
  "gateway-control-v1",
] as const;

export const GATEWAY_REMOTE_SETUP_CAPABILITIES = [
  ...GATEWAY_LOCAL_SETUP_CAPABILITIES,
  "tailscale-identity-v1",
] as const;

export const gatewayCatalog: GatewayCatalog = {
  nix: {
    sourceRevision: "a41f2bcecbc5e35da0383e5db162e8b733a1549f",
    version: "0.4.0",
    narHash: "sha256-92AiLvXj9OU7VI2aE8Hs66Qj53PQ0UmR+26cIgZfARQ=",
  },
  native: {
    sourceRevision: "a41f2bcecbc5e35da0383e5db162e8b733a1549f",
    version: "0.4.0",
    manifestSha256: "cb949acc05ca29590c689330297fdf928dd9e8a56894b73318847bebd1f35ea0",
  },
};

const targets = new Map([
  ["darwin/arm64", "aarch64-apple-darwin"],
  ["linux/arm64", "aarch64-unknown-linux-gnu"],
  ["linux/x64", "x86_64-unknown-linux-gnu"],
]);

export function gatewayTarget(platform: string = process.platform, arch: string = process.arch) {
  return targets.get(`${platform}/${arch}`);
}

export const isGatewayVersion = Schema.is(
  Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u)),
);

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
