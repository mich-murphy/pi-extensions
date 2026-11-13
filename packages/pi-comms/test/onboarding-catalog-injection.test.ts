import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { gatewayCatalog, gatewayTarget } from "../onboarding/catalog.js";
import type { GatewayCatalog } from "../onboarding/catalog.js";

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../..");
const setupSource = path.resolve(import.meta.dirname, "../onboarding/setup.ts");
/**
 * Owned child: fences fetch and process execution BEFORE importing the real setup.ts (acquire.ts
 * captures `globalThis.fetch` at module load), then drives one fresh local Apply through the real
 * `setupCommand` with an injected catalog. Only a read-only `nix --version` probe may execute;
 * every other exec/spawn is recorded and refused, so no Nix build, gateway start or network occurs.
 * A non-empty `archOverride` replaces `process.arch` in THIS child only, before import and setup,
 * to simulate unsupported host metadata; the Vitest process is never modified.
 */
const childScript = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";
const [setupSource, agentDir, catalogJson, sentinel, archOverride] = process.argv.slice(1);
if (archOverride !== "") {
  Object.defineProperty(process, "arch", { value: archOverride, enumerable: true, configurable: true });
}
const record = { fetches: [], allowed: [], denied: [], selects: [], notices: [], activated: 0 };
globalThis.fetch = async (input) => {
  record.fetches.push(String(input instanceof Request ? input.url : input));
  throw new Error(sentinel);
};
const deny = (name) => (file, args) => {
  record.denied.push({ name, file: String(file), args: Array.isArray(args) ? args.map(String) : [] });
  throw new Error("exec fence: " + name);
};
const original = childProcess.execFile;
const fencedExecFile = (file, args, ...rest) => {
  if (path.basename(String(file)) === "nix" && Array.isArray(args) && args.length === 1 && args[0] === "--version") {
    record.allowed.push(String(file));
    return original(file, args, ...rest);
  }
  return deny("execFile")(file, args);
};
fencedExecFile[promisify.custom] = (...parts) =>
  new Promise((resolve, reject) => {
    fencedExecFile(...parts, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
childProcess.execFile = fencedExecFile;
for (const name of ["spawn", "exec", "fork", "execFileSync", "execSync", "spawnSync"]) {
  childProcess[name] = deny(name);
}
syncBuiltinESMExports();
const jiti = createJiti(import.meta.url);
const { setupCommand } = await jiti.import(setupSource);
const answers = ["Local only — no remote connections (recommended)", "APPLY"];
const ctx = {
  mode: "rpc",
  hasUI: true,
  signal: undefined,
  ui: {
    select: async (title, options) => {
      record.selects.push(title);
      const value = answers.shift();
      return value === "APPLY" ? options.find((item) => item.startsWith("Apply —")) : value;
    },
    input: async () => undefined,
    notify: (message, level) => {
      record.notices.push({ message, level });
    },
  },
};
await setupCommand(agentDir, ctx, async () => {
  record.activated += 1;
}, undefined, undefined, { catalog: JSON.parse(catalogJson) });
console.log(JSON.stringify(record));
`;

type ChildRecord = {
  fetches: string[];
  allowed: string[];
  denied: { name: string; file: string; args: string[] }[];
  selects: string[];
  notices: { message: string; level: string }[];
  activated: number;
};

/** Runtime guard for parsed JSON: a non-null object whose fields are still individually validated. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isDenied = (value: unknown): value is ChildRecord["denied"] =>
  Array.isArray(value) &&
  value.every(
    (item: unknown) =>
      isRecord(item) &&
      typeof item.name === "string" &&
      typeof item.file === "string" &&
      isStrings(item.args),
  );
const isNotices = (value: unknown): value is ChildRecord["notices"] =>
  Array.isArray(value) &&
  value.every(
    (item: unknown) =>
      isRecord(item) && typeof item.message === "string" && typeof item.level === "string",
  );
function childRecord(stdout: string): ChildRecord {
  const value: unknown = JSON.parse(stdout);
  if (
    isRecord(value) &&
    isStrings(value.fetches) &&
    isStrings(value.allowed) &&
    isDenied(value.denied) &&
    isStrings(value.selects) &&
    isNotices(value.notices) &&
    typeof value.activated === "number"
  ) {
    return {
      fetches: value.fetches,
      allowed: value.allowed,
      denied: value.denied,
      selects: value.selects,
      notices: value.notices,
      activated: value.activated,
    };
  }
  throw new TypeError("Malformed child record");
}

/**
 * Host metadata seen by the child decides the expected outcome. Unsupported host: real discovery
 * blocks before acquisition, with no fetch or setup writes. Supported host: exactly the fenced
 * manifest fetch, then a failed Apply that installs nothing.
 */
function hostExpectation(sourceRevision: string, supported: boolean) {
  return {
    supported,
    fetches: supported
      ? [
          `https://github.com/mich-murphy/pi-extensions/releases/download/gateway-${sourceRevision}/manifest.json`,
        ]
      : [],
    warning: supported ? "Apply incomplete" : "No reviewed target",
  };
}
async function entriesIfPresent(directory: string): Promise<string[]> {
  return existsSync(directory) ? fs.readdir(directory) : [];
}

/**
 * Darwin x64 (Intel macOS) and Linux ia32 are both outside the reviewed target table. The
 * simulated case passes its arch to the child as `archOverride`; the real-host case passes "".
 */
const unsupportedArch = process.platform === "darwin" ? "x64" : "ia32";
const hostCases = [
  {
    name: "on the real host",
    arch: process.arch as string,
    archOverride: "",
    supported: gatewayTarget() !== undefined,
  },
  {
    name: "with simulated unsupported host architecture (child-only process.arch override)",
    arch: unsupportedArch,
    archOverride: unsupportedArch,
    supported: false,
  },
];

const roots: string[] = [];

describe("setupCommand trusted catalog injection", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // An empty catalog blocks before acquisition, so it cannot detect a dropped `{ catalog }` on the
  // acquireGateway call. This non-empty native pin differs from the shipped native pin (whether
  // that is null or a published pin): it only reaches the fenced manifest fetch if selection AND
  // acquisition both use the injected catalog. Validating against the shipped catalog instead
  // rejects before any fetch. Whether the shipped native pin is currently null is owned by
  // onboarding-catalog.test.ts, not here.
  //
  // The second case keeps the real host platform but simulates unsupported host metadata by
  // overriding `process.arch` inside the owned child only. It exercises the real gatewayTarget,
  // discovery and setup Blocked path; it is simulated metadata, NOT proof on actual Intel macOS.
  test.each(hostCases)(
    "a supplied non-empty catalog is validated by real setup $name",
    { timeout: 90_000 },
    async ({ arch, archOverride, supported }) => {
      const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pc-"));
      roots.push(root);
      await fs.chmod(root, 0o700);
      const agent = path.join(root, "agent");
      const pin = {
        sourceRevision: "0123456789abcdef0123456789abcdef01234567",
        version: "0.1.0",
        manifestSha256: "c".repeat(64),
      };
      const catalog: GatewayCatalog = { nix: null, native: pin };
      expect(gatewayCatalog.native?.sourceRevision).not.toBe(pin.sourceRevision);
      expect(gatewayCatalog.native?.manifestSha256).not.toBe(pin.manifestSha256);
      // The real catalog target function agrees with the case's expected host support.
      expect(gatewayTarget(process.platform, arch) !== undefined).toBe(supported);
      const sentinel = `catalog-injection-fence-${randomBytes(12).toString("hex")}`;
      const { stdout } = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          childScript,
          setupSource,
          agent,
          JSON.stringify(catalog),
          sentinel,
          archOverride,
        ],
        {
          cwd: repository,
          env: { ...process.env, HOME: root, TMPDIR: root },
          timeout: 60_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_048_576,
        },
      );
      const record = childRecord(stdout);
      const expected = hostExpectation(pin.sourceRevision, supported);
      expect(record.denied).toStrictEqual([]);
      expect(record.allowed.filter((file) => path.basename(file) !== "nix")).toStrictEqual([]);
      expect(record.activated).toBe(0);
      expect(
        record.selects.join("\n").includes("Apply: reviewed acquisition + private config + start."),
      ).toBe(expected.supported);
      expect(record.fetches).toStrictEqual(expected.fetches);
      const warnings = record.notices.filter((notice) => notice.level === "warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(expected.warning);
      // Failed or blocked acquisition installs nothing: no configuration, ledger or install
      // descriptor, and every per-attempt install root is left empty.
      const comms = path.join(agent, "comms");
      expect(existsSync(comms)).toBe(expected.supported);
      const entries = await entriesIfPresent(comms);
      expect(entries.filter((name) => !name.startsWith("install-"))).toStrictEqual([]);
      const installed = await Promise.all(
        entries.map(async (name) => fs.readdir(path.join(comms, name))),
      );
      expect(installed.flat()).toStrictEqual([]);
      expect(existsSync(path.join(agent, "session-communication.json"))).toBe(false);
    },
  );
});
