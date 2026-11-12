import { execFile } from "node:child_process";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_ARCHIVE,
  MAX_BINARY,
  sha256,
  jsonObject,
  verifyArtifact,
  verifyManifest,
} from "./artifact.js";
import {
  GATEWAY_WIRE_VERSION,
  GATEWAY_MANAGED_CAPABILITY,
  gatewayCatalog,
  gatewayTarget,
  validatePin,
} from "./catalog.js";
import type { GatewayCatalog, GatewayNixPin, GatewayReleasePin } from "./catalog.js";

export type AcquisitionPlanCommon = Readonly<{
  /** Only a reviewed Apply may construct this value. Cancellation before Apply does not call acquisition. */
  approved: true;
  target: string;
  installRoot: string;
  deadlineMs: number;
  /** Absolute technical-discovery result; never resolve a project executable from PATH. */
  nixExecutable?: string;
  /** Additional capabilities required by the reviewed flow (for example pairing helpers). */
  requiredCapabilities?: readonly string[];
}>;
export type AcquisitionPlanNix = AcquisitionPlanCommon &
  Readonly<GatewayNixPin & { method: "nix" }>;
export type AcquisitionPlanNative = AcquisitionPlanCommon &
  Readonly<GatewayReleasePin & { method: "native" }>;
export type AcquisitionPlan = AcquisitionPlanNix | AcquisitionPlanNative;
export type AcquisitionResult = {
  executable: string;
  ownedPaths: string[];
  recoveryEffects: string[];
  sourceRevision: string;
  version: string;
};
export type AcquisitionSeams = {
  fs: Omit<typeof fs, "realpath"> & { realpath: (filename: string) => Promise<string> };
  fetch: typeof globalThis.fetch;
  exec: (file: string, args: string[], signal: AbortSignal) => Promise<string>;
};
const production: AcquisitionSeams = {
  fs,
  fetch: globalThis.fetch,
  exec: async (file, args, signal) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        {
          signal,
          maxBuffer: 65_536,
          timeout: 600_000,
          windowsHide: true,
          env: {
            HOME: os.homedir(),
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            TMPDIR: os.tmpdir(),
            LANG: "C.UTF-8",
          },
        },
        (error, stdout) => {
          if (error) {
            reject(new Error("Gateway command failed", { cause: error }));
          } else {
            resolve(stdout);
          }
        },
      );
    }),
};
export async function discoverNixExecutable(): Promise<string | undefined> {
  const candidates = [
    "/nix/var/nix/profiles/default/bin/nix",
    "/run/current-system/sw/bin/nix",
    "/usr/bin/nix",
    "/usr/local/bin/nix",
  ];
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await fs.access(candidate, 1);
        const absolute = await fs.realpath(candidate);
        const version = await production.exec(absolute, ["--version"], AbortSignal.timeout(3000));
        return /^nix \([^\n)]+\) \d/u.test(version) ? absolute : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return results.find((result) => result !== undefined);
}
async function download(
  url: string,
  maximum: number,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Buffer> {
  // GitHub redirects release assets to its authenticated CDN. No arbitrary redirects.
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    validateDownloadOrigin(current);
    // eslint-disable-next-line no-await-in-loop -- Ordered redirect/stream/ancestor steps cannot run concurrently.
    const response = await fetcher(current, { signal, redirect: "manual", credentials: "omit" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      // eslint-disable-next-line no-await-in-loop -- Ordered redirect/stream/ancestor steps cannot run concurrently.
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (location === null || location.length === 0) {
        throw new Error("Missing release redirect");
      }
      current = new URL(location, current).href;
      continue;
    }
    return readBoundedResponse(response, maximum, signal);
  }
  throw new Error("Too many artifact redirects");
}
function validateDownloadOrigin(url: string): void {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    ![
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(parsed.hostname) ||
    parsed.port
  ) {
    throw new Error("Untrusted artifact origin");
  }
}
async function readBoundedResponse(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new Error("Artifact download unavailable or oversized");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      // eslint-disable-next-line no-await-in-loop -- Ordered redirect/stream/ancestor steps cannot run concurrently.
      const item = await reader.read();
      if (item.done) {
        break;
      }
      size += item.value.length;
      if (size > maximum) {
        throw new Error("Artifact download exceeds bound");
      }
      parts.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(parts);
}
async function privateRoot(root: string, io: AcquisitionSeams["fs"]): Promise<void> {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === path.parse(root).root) {
    throw new Error("Install root must be an approved absolute private path");
  }
  // Do not follow user-controlled directory symlinks into unrelated state.
  let current = path.parse(root).root;
  for (const component of root.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    // eslint-disable-next-line no-await-in-loop -- Validate ancestors in path order before descending.
    await ensureSafeAncestor(current, io);
  }
  const stat = await io.lstat(root);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("Install root must be private and owned by this account");
  }
}
async function ensureSafeAncestor(current: string, io: AcquisitionSeams["fs"]): Promise<void> {
  try {
    const stat = await io.lstat(current);
    validateAncestorStat(stat);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    await io.mkdir(current, { mode: 0o700 });
  }
}
async function boundedOwnedFile(
  filename: string,
  maximum: number,
  io: AcquisitionSeams["fs"],
): Promise<Buffer> {
  const handle = await io.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > maximum) {
      throw new Error("Unsafe installed file");
    }
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) {
      throw new Error("Installed file changed during read");
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export type AcquisitionOptions = {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  seams?: Partial<AcquisitionSeams>;
  catalog?: GatewayCatalog;
};

export async function acquireGateway(
  approvedPlan: AcquisitionPlan,
  options: AcquisitionOptions = {},
): Promise<AcquisitionResult> {
  const plan = Object.freeze({
    ...approvedPlan,
    requiredCapabilities: Object.freeze([...(approvedPlan.requiredCapabilities ?? [])]),
  });
  const io = { ...production, ...options.seams };
  const catalog = options.catalog ?? gatewayCatalog;
  validateAcquisitionPlan(plan, catalog);
  const signal = acquisitionSignal(plan, options.signal);
  // All validation/cancellation above is side-effect free.
  options.onProgress?.("Preparing private gateway installation");
  await privateRoot(plan.installRoot, io.fs);
  const installation = await prepareInstallation(plan, io.fs);
  const { destination, created, previousExecutable } = installation;
  const { installDirectory } = installation;
  try {
    signal.throwIfAborted();
    const executable =
      plan.method === "nix"
        ? await acquireNix(plan, destination, io, signal, options.onProgress)
        : await acquireNative(plan, installation, io, signal, options.onProgress);
    if (previousExecutable !== undefined && previousExecutable !== executable) {
      throw new Error("Existing executable identity changed");
    }
    signal.throwIfAborted();
    await probeGateway(executable, plan, io, signal);
    const finalExecutable = await publishInstallation(
      plan,
      installation,
      executable,
      io.fs,
      signal,
    );
    return completedAcquisition(plan, finalExecutable, destination);
  } catch (error) {
    if (created) {
      await io.fs.rm(installDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

function validateAcquisitionPlan(plan: AcquisitionPlan, catalog: GatewayCatalog): void {
  validatePin(plan);
  const trusted = plan.method === "nix" ? catalog.nix : catalog.native;
  if (!plan.approved || !trusted || plan.target !== gatewayTarget()) {
    throw new Error("Acquisition plan does not match trusted catalog/host");
  }
  if (
    trusted.sourceRevision !== plan.sourceRevision ||
    trusted.version !== plan.version ||
    !matchesContentPin(plan, catalog)
  ) {
    throw new Error("Acquisition plan does not match trusted catalog/host");
  }
}
function matchesContentPin(plan: AcquisitionPlan, catalog: GatewayCatalog): boolean {
  if (plan.method === "native") {
    return catalog.native?.manifestSha256 === plan.manifestSha256;
  }
  return typeof plan.narHash === "string" && catalog.nix?.narHash === plan.narHash;
}

function acquisitionSignal(plan: AcquisitionPlan, externalSignal?: AbortSignal): AbortSignal {
  if (
    !Number.isSafeInteger(plan.deadlineMs) ||
    plan.deadlineMs <= Date.now() ||
    plan.deadlineMs - Date.now() > 3_600_000
  ) {
    throw new Error("Invalid acquisition deadline");
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(plan.deadlineMs - Date.now()),
    ...(externalSignal ? [externalSignal] : []),
  ]);
  signal.throwIfAborted();
  return signal;
}

type Installation = {
  destination: string;
  created: boolean;
  installDirectory: string;
  previousExecutable: string | undefined;
};
async function prepareInstallation(
  plan: AcquisitionPlan,
  io: AcquisitionSeams["fs"],
): Promise<Installation> {
  if (plan.method === "nix") {
    const destination = await io.mkdtemp(
      path.join(plan.installRoot, `${plan.version}-${plan.sourceRevision}-nix-`),
    );
    return {
      destination,
      installDirectory: destination,
      created: true,
      previousExecutable: undefined,
    };
  }
  const destination = path.join(plan.installRoot, `${plan.version}-${plan.sourceRevision}-native`);
  const existing = await io.lstat(destination).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (existing !== null) {
    const previousExecutable = await verifyExistingInstallation(plan, destination, io);
    return { destination, installDirectory: destination, created: false, previousExecutable };
  }
  const installDirectory = await io.mkdtemp(path.join(plan.installRoot, ".pending-gateway-"));
  return { destination, installDirectory, created: true, previousExecutable: undefined };
}
async function verifyExistingInstallation(
  plan: AcquisitionPlanNative,
  destination: string,
  io: AcquisitionSeams["fs"],
): Promise<string> {
  const stat = await io.lstat(destination);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  ) {
    throw new Error("Unsafe existing installation");
  }
  // A missing/invalid completion record means interrupted ownership. Never repair or remove implicitly.
  const markerBytes = await boundedOwnedFile(path.join(destination, "installed.json"), 16_384, io);
  const marker = jsonObject(JSON.parse(markerBytes.toString("utf8")));
  if (marker.sourceRevision !== plan.sourceRevision || marker.version !== plan.version) {
    throw new Error("Existing install identity mismatch; inspect owned state before recovery");
  }
  if (typeof marker.executable !== "string") {
    throw new TypeError("Invalid completion marker");
  }
  return marker.executable;
}

async function acquireNix(
  plan: AcquisitionPlanNix,
  destination: string,
  io: AcquisitionSeams,
  signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<string> {
  const nix = trustedNixExecutable(plan.nixExecutable);
  await io.fs.writeFile(
    path.join(destination, "acquisition-intent.json"),
    JSON.stringify({
      sourceRevision: plan.sourceRevision,
      version: plan.version,
      method: "nix",
      narHash: plan.narHash,
    }),
    { flag: "wx", mode: 0o400 },
  );
  const link = path.join(destination, "result");
  onProgress?.("Building pinned Nix gateway (cache misses may take several minutes)");
  await io.exec(
    nix,
    [
      "build",
      "--extra-experimental-features",
      "nix-command flakes",
      "--no-write-lock-file",
      "--out-link",
      link,
      `github:mich-murphy/pi-extensions/${plan.sourceRevision}?narHash=${encodeURIComponent(plan.narHash)}#pi-gateway`,
    ],
    signal,
  );
  const executable = await io.fs.realpath(path.join(link, "bin/pi-gateway"));
  if (!executable.startsWith("/nix/store/") || !executable.endsWith("/bin/pi-gateway")) {
    throw new Error("Unexpected Nix output");
  }
  return executable;
}
async function acquireNative(
  plan: AcquisitionPlanNative,
  installation: Installation,
  io: AcquisitionSeams,
  signal: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<string> {
  const { destination, installDirectory, created } = installation;
  const origin = `https://github.com/mich-murphy/pi-extensions/releases/download/gateway-${plan.sourceRevision}/`;
  onProgress?.("Downloading and authenticating pinned native gateway");
  const bytes = created
    ? await download(`${origin}manifest.json`, 65_536, signal, io.fetch)
    : await boundedOwnedFile(path.join(destination, "manifest.json"), 65_536, io.fs);
  const { record } = verifyManifest(
    bytes,
    {
      sourceRevision: plan.sourceRevision,
      version: plan.version,
      manifestSha256: plan.manifestSha256 ?? "",
    },
    plan.target,
  );
  const executable = path.join(installDirectory, "pi-gateway");
  if (created) {
    const archive = await download(`${origin}${record.file}`, MAX_ARCHIVE, signal, io.fetch);
    const binary = verifyArtifact(archive, record);
    await io.fs.writeFile(executable, binary, { flag: "wx", mode: 0o500 });
    await io.fs.writeFile(path.join(installDirectory, "manifest.json"), bytes, {
      flag: "wx",
      mode: 0o400,
    });
  } else {
    const binary = await boundedOwnedFile(executable, MAX_BINARY, io.fs);
    if (binary.length !== record.binarySize || sha256(binary) !== record.binarySha256) {
      throw new Error("Existing binary integrity mismatch");
    }
  }
  return executable;
}

async function probeGateway(
  executable: string,
  plan: AcquisitionPlan,
  io: AcquisitionSeams,
  signal: AbortSignal,
): Promise<void> {
  const version = jsonObject(
    JSON.parse(await io.exec(executable, ["--version", "--json"], signal)),
  );
  const capabilities = version.capabilities;
  const wires = version.wireVersions;
  if (
    version.name !== "pi-gateway" ||
    version.version !== plan.version ||
    !Array.isArray(wires) ||
    !wires.includes(GATEWAY_WIRE_VERSION) ||
    !Array.isArray(capabilities) ||
    ![GATEWAY_MANAGED_CAPABILITY, ...(plan.requiredCapabilities ?? [])].every((capability) =>
      capabilities.includes(capability),
    )
  ) {
    throw new Error("Gateway ABI/capability mismatch");
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function validateAncestorStat(stat: Stats): void {
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.uid !== 0 && stat.uid !== uid) ||
    ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))
  ) {
    throw new Error("Unsafe install ancestor");
  }
}

function trustedNixExecutable(nix: string | undefined): string {
  if (
    nix === undefined ||
    nix.length === 0 ||
    !path.isAbsolute(nix) ||
    path.normalize(nix) !== nix ||
    !(
      nix.startsWith("/nix/store/") ||
      [
        "/usr/bin/nix",
        "/usr/local/bin/nix",
        "/nix/var/nix/profiles/default/bin/nix",
        "/run/current-system/sw/bin/nix",
      ].includes(nix)
    )
  ) {
    throw new Error("No trusted system Nix executable");
  }
  return nix;
}

async function publishInstallation(
  plan: AcquisitionPlan,
  installation: Installation,
  executable: string,
  io: AcquisitionSeams["fs"],
  signal: AbortSignal,
): Promise<string> {
  const { destination, installDirectory, created } = installation;
  const finalExecutable =
    plan.method === "native" ? path.join(destination, "pi-gateway") : executable;
  if (created) {
    await io.writeFile(
      path.join(installDirectory, "installed.json"),
      JSON.stringify({
        sourceRevision: plan.sourceRevision,
        version: plan.version,
        executable: finalExecutable,
      }),
      { flag: "wx", mode: 0o400 },
    );
  }
  if (created && plan.method === "native") {
    signal.throwIfAborted();
    await io.rename(installDirectory, destination);
  }
  return finalExecutable;
}

function completedAcquisition(
  plan: AcquisitionPlan,
  executable: string,
  destination: string,
): AcquisitionResult {
  return {
    executable,
    ownedPaths: [destination],
    recoveryEffects:
      plan.method === "nix"
        ? [
            "Dedicated per-attempt Nix result GC root retained; no default profile changed. Interrupted older attempts are not adopted or removed and do not block retry.",
          ]
        : [],
    sourceRevision: plan.sourceRevision,
    version: plan.version,
  };
}
