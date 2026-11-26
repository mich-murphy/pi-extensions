import { spawn } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { acquireGateway } from "../packages/pi-peers/onboarding/acquire.js";
import {
  MAX_BINARY,
  gatewayReleaseTag,
  sha256,
  verifyManifest,
} from "../packages/pi-peers/onboarding/artifact.js";
import {
  GATEWAY_REMOTE_SETUP_CAPABILITIES,
  gatewayCatalog,
  gatewayTarget,
} from "../packages/pi-peers/onboarding/catalog.js";
import type { GatewayReleasePin } from "../packages/pi-peers/onboarding/catalog.js";
import {
  createRecord,
  currentUid,
  describeFailure,
  isPrivateDirectory,
  parseRecordJson,
  privateProfile,
  readRegular,
  requireAbsent,
  verifyGatewayVersion,
} from "./verify-gateway-nix-io.js";
import type { RecordWriter } from "./verify-gateway-nix-io.js";

const ROOT_PREFIX = "gateway-public-native-";
const ROOT_NAME = /^gateway-public-native-[A-Za-z0-9]{6}$/u;
const ACQUISITION_MS = 120_000;
const PROBE_MS = 10_000;
const CLOSE_GRACE_MS = 5000;
const MAX_JSON = 65_536;

type Root = { root: string; dev: bigint; ino: bigint; uid: number };

function requirePin(target: string): GatewayReleasePin {
  if (gatewayTarget() !== target) {
    throw new Error(`Host target ${gatewayTarget()} does not match matrix target ${target}`);
  }

  if (gatewayCatalog.native === null) {
    throw new Error(
      "Default catalog has no native pin: public native acquisition cannot be verified until the release is published and pinned",
    );
  }

  return gatewayCatalog.native;
}

async function createRoot(runnerTemp: string): Promise<Root> {
  if (!path.isAbsolute(runnerTemp)) {
    throw new Error("--runner-temp must be absolute");
  }

  const root = await mkdtemp(path.join(await realpath(runnerTemp), ROOT_PREFIX));

  try {
    const stat = await lstat(root, { bigint: true });

    if (!isPrivateDirectory(stat, currentUid())) {
      throw new Error("not a private directory");
    }

    return { root, dev: stat.dev, ino: stat.ino, uid: currentUid() };
  } catch (error) {
    throw new Error(`Fresh root ${root} not confirmed private; retained`, { cause: error });
  }
}

async function requireOwnedExecutable(
  executable: string,
  installRoot: string,
  ownedPaths: string[],
) {
  const canonical = (await realpath(executable)) === executable;

  if (!canonical || !inInstallLayout(executable, installRoot, ownedPaths)) {
    throw new Error(
      `Acquired executable ${executable} is not canonical inside the owned install root`,
    );
  }
}

function inInstallLayout(executable: string, installRoot: string, ownedPaths: string[]): boolean {
  const inside = (file: string) => path.dirname(file) === installRoot;

  return (
    path.basename(executable) === "pi-gateway" &&
    inside(path.dirname(executable)) &&
    ownedPaths.length > 0 &&
    ownedPaths.every((file) => inside(file))
  );
}

async function verifyInstalled(executable: string, pin: GatewayReleasePin, target: string) {
  const binary = await readRegular(executable, MAX_BINARY, "owned");

  const manifest = await readRegular(
    path.join(path.dirname(executable), "manifest.json"),
    MAX_JSON,
    "owned",
  );

  const { record } = verifyManifest(manifest.bytes, pin, target);
  const binarySha256 = sha256(binary.bytes);

  if (binarySha256 !== record.binarySha256 || binary.bytes.length !== record.binarySize) {
    throw new Error("Acquired binary differs from the pinned manifest record");
  }

  return {
    binarySha256,
    binarySize: binary.bytes.length,
    mode: (binary.stat.mode & 0o777n).toString(8),
  };
}

async function probeVersion(executable: string, home: string, tmp: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version", "--json"], {
      env: { HOME: home, TMPDIR: tmp, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "ignore"],
    });

    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let abandon: NodeJS.Timeout | undefined;

    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
      abandon ??= setTimeout(() => {
        child.stdout.destroy();
        child.unref();
        reject(new Error("Version probe child did not close after SIGKILL; root retained"));
      }, CLOSE_GRACE_MS);
    };

    const deadline = setTimeout(() => {
      stop(new Error("Version probe timed out"));
    }, PROBE_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_JSON) {
        stop(new Error("Version output exceeds bound"));
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", (error) => {
      if (child.pid === undefined) {
        clearTimeout(deadline);
        reject(error);
      } else {
        failure ??= error;
      }
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(abandon);

      if (failure !== undefined || code !== 0) {
        reject(failure ?? new Error(`Version probe exited with ${String(code)}`));
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
  });
}

async function requireEmpty(...dirs: string[]): Promise<void> {
  const entries = await Promise.all(dirs.map(async (dir) => readdir(dir)));

  if (entries.some((list) => list.length > 0)) {
    throw new Error("Private HOME or TMPDIR was modified");
  }
}

function isRootPathIn(root: string, parent: string): boolean {
  return path.dirname(root) === parent && ROOT_NAME.test(path.basename(root));
}

function isSameRootDirectory(stat: BigIntStats, owned: Root): boolean {
  return stat.dev === owned.dev && stat.ino === owned.ino && isPrivateDirectory(stat, owned.uid);
}

async function removeRoot(owned: Root, runnerTemp: string): Promise<{ removed: string }> {
  const stat = await lstat(owned.root, { bigint: true });
  const parent = await realpath(runnerTemp);

  if (!isRootPathIn(owned.root, parent) || !isSameRootDirectory(stat, owned)) {
    throw new Error(`Root ${owned.root} identity, ownership or mode changed; retained`);
  }

  await rm(owned.root, { recursive: true });
  await requireAbsent(owned.root);

  return { removed: owned.root };
}

async function verifyInRoot(
  owned: Root,
  writer: RecordWriter,
  pin: GatewayReleasePin,
  target: string,
  runnerTemp: string,
) {
  const base = {
    source: `https://github.com/mich-murphy/pi-extensions/releases/download/${gatewayReleaseTag(pin.version)}/`,
    ...pin,
    target,
    root: owned.root,
  };

  let cleanup: "retained" | "cleanup unconfirmed" | "removed" = "retained";

  try {
    await writer.write({ ...base, status: "acquiring" });
    const { home, tmp, installRoot } = await privateProfile(owned.root);

    const result = await acquireGateway(
      {
        approved: true,
        method: "native",
        ...pin,
        target,
        installRoot,
        deadlineMs: Date.now() + ACQUISITION_MS,
        requiredCapabilities: GATEWAY_REMOTE_SETUP_CAPABILITIES,
      },
      { onProgress: (message) => process.stderr.write(`${message}\n`) },
    );

    await requireOwnedExecutable(result.executable, installRoot, result.ownedPaths);
    const installed = await verifyInstalled(result.executable, pin, target);

    const version = verifyGatewayVersion(
      parseRecordJson(await probeVersion(result.executable, home, tmp)),
      pin.version,
      "Public native",
    );

    await requireEmpty(home, tmp);

    const verified = {
      ...base,
      status: "verified",
      executable: path.relative(owned.root, result.executable),
      ...installed,
      gatewayVersion: version,
    };

    await writer.write(verified);
    cleanup = "cleanup unconfirmed";
    const removed = await removeRoot(owned, runnerTemp);
    cleanup = "removed";
    const done = { ...verified, status: "cleaned", cleanup: removed };
    await writer.write(done);

    return done;
  } catch (error) {
    const failure = new Error(`Root ${owned.root}: ${cleanup}`, { cause: error });
    const retained = cleanup === "retained" ? owned.root : null;
    await recordFailure(writer, { ...base, retained, rootState: cleanup }, failure);
    throw failure;
  }
}

type FailureRecord = GatewayReleasePin & {
  target: string;
  retained: string | null;
  root?: string;
  source?: string;
  rootState?: string;
};

async function recordFailure(
  writer: RecordWriter,
  base: FailureRecord,
  cause: unknown,
): Promise<void> {
  const error = describeFailure(cause, false);

  try {
    await writer.write({ ...base, status: "failed", error });
  } catch (recordError) {
    throw new AggregateError([cause, recordError], `${error}\n  failure record not written`, {
      cause: recordError,
    });
  }
}

async function main(target: string, runnerTemp: string, out: string) {
  const pin = requirePin(target);
  const writer = await createRecord(out);

  try {
    let owned: Root;

    try {
      owned = await createRoot(runnerTemp);
    } catch (error) {
      await recordFailure(writer, { ...pin, target, retained: "see error" }, error);
      throw error;
    }

    return await verifyInRoot(owned, writer, pin, target, runnerTemp);
  } finally {
    await writer.close();
  }
}

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    "runner-temp": { type: "string" },
    out: { type: "string" },
  },
});

try {
  const { target, "runner-temp": runnerTemp, out } = values;

  if (
    target === undefined ||
    target === "" ||
    runnerTemp === undefined ||
    runnerTemp === "" ||
    out === undefined ||
    out === ""
  ) {
    throw new Error("Usage: --target T --runner-temp DIR --out RECORD");
  }

  const result = await main(target, runnerTemp, path.resolve(out));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`verify-gateway-native: ${describeFailure(error, false)}\n`);
  process.exitCode = 1;
}
