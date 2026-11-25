import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { gatewayCatalog, gatewayTarget } from "../onboarding/catalog.js";
import type { GatewayCatalog } from "../onboarding/catalog.js";

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../..");
const setupSource = path.resolve(import.meta.dirname, "../onboarding/setup.ts");

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
const answers = ["APPLY"];
const ctx = {
  mode: "rpc",
  hasUI: true,
  signal: undefined,
  ui: {
    select: async (title, options) => {
      record.selects.push(title, ...options);
      const value = answers.shift();
      return value === "APPLY" ? options.find((item) => item === "Apply: Ready") : value;
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

const childRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      fetches: Schema.Array(Schema.String),
      allowed: Schema.Array(Schema.String),
      denied: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          file: Schema.String,
          args: Schema.Array(Schema.String),
        }),
      ),
      selects: Schema.Array(Schema.String),
      notices: Schema.Array(Schema.Struct({ message: Schema.String, level: Schema.String })),
      activated: Schema.Number,
    }),
  ),
);

function hostExpectation(version: string, supported: boolean) {
  return {
    supported,
    fetches: supported
      ? [
          `https://github.com/mich-murphy/pi-extensions/releases/download/pi-gateway-v${version}/manifest.json`,
        ]
      : [],
    warning: supported ? "Setup failed" : "Setup unavailable",
  };
}

async function entriesIfPresent(directory: string): Promise<string[]> {
  return existsSync(directory) ? fs.readdir(directory) : [];
}

const unsupportedArch = process.platform === "darwin" ? "x64" : "ia32";

const hostCases = [
  {
    name: "on the real host",
    arch: process.arch,
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
      const expected = hostExpectation(pin.version, supported);
      expect(record.denied).toStrictEqual([]);
      expect(record.allowed.filter((file) => path.basename(file) !== "nix")).toStrictEqual([]);
      expect(record.activated).toBe(0);
      expect(record.selects.join("\n").includes("Apply: Ready")).toBe(expected.supported);
      expect(record.fetches).toStrictEqual(expected.fetches);
      const warnings = record.notices.filter((notice) => notice.level !== "info");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain(expected.warning);
      const comms = path.join(agent, "pi-peers");
      expect(existsSync(comms)).toBe(expected.supported);
      const entries = await entriesIfPresent(comms);
      expect(entries.filter((name) => !name.startsWith("install-"))).toStrictEqual([]);

      const installed = await Promise.all(
        entries.map(async (name) => fs.readdir(path.join(comms, name))),
      );

      expect(installed.flat()).toStrictEqual([]);
      expect(existsSync(path.join(agent, "pi-peers.json"))).toBe(false);
    },
  );
});
