import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Schema } from "effect";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { jsonObject, sha256 } from "../onboarding/artifact.js";
import { gatewayTarget } from "../onboarding/catalog.js";
import { parseJson } from "../onboarding/schema.js";

const repository = path.resolve(import.meta.dirname, "../../..");
const script = path.join(repository, "scripts/verify-gateway-nix.ts");
const ioHelper = path.join(repository, "scripts/verify-gateway-nix-io.ts");
const CHILD_DEADLINE_MS = 30_000;
const FAKE_STORE = `/nix/store/${"a".repeat(32)}-pi-gateway-0.1.0/bin/pi-gateway`;

type Outcome = { code: number | null; signal: string | null; stdout: string; stderr: string };

async function cli(args: Array<string>): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--no-warnings", "--import", "jiti/register", script, ...args],
      {
        cwd: repository,
        timeout: CHILD_DEADLINE_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1_048_576,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir(), LANG: "C.UTF-8" },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, signal: null, stdout, stderr });
        } else {
          const code = numericExit(error.code) ? error.code : null;
          resolve({ code, signal: error.signal ?? null, stdout, stderr });
        }
      },
    );
  });
}

async function mkfifo(filename: string): Promise<void> {
  await promisify(execFile)("mkfifo", ["-m", "0600", filename], { timeout: 5000 });
  const stat = await lstat(filename);
  expect(stat.isFIFO()).toBe(true);
}

function refused(outcome: Outcome, pattern: RegExp): void {
  expect(outcome.signal).toBeNull();
  expect(outcome.code).toBe(1);
  expect(outcome.stdout).toBe("");
  expect(outcome.stderr).toMatch(pattern);
}

const temps: Array<string> = [];
const created: Array<string> = [];

async function ownedTemp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  created.push(dir);

  return dir;
}

async function ownedRun() {
  const runnerTemp = await ownedTemp("nix-cli-test-");
  const root = await mkdtemp(path.join(runnerTemp, "gateway-nix-"));
  const stat = await lstat(root, { bigint: true });

  const identity = {
    root,
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: process.getuid?.(),
    nonce: randomBytes(16).toString("hex"),
  };

  const marker = path.join(root, "owner.json");
  await writeFile(marker, JSON.stringify(identity), { flag: "wx", mode: 0o400 });
  const record = path.join(runnerTemp, "record.json");
  const acquired = { ...identity, status: "acquired", executable: FAKE_STORE };
  await writeFile(record, JSON.stringify({ ...acquired, binarySha256: "b".repeat(64) }));
  const native = Buffer.from("authenticated native fixture bytes");
  const work = path.join(runnerTemp, "consumer");
  await mkdir(work, { mode: 0o700 });
  const fixture = path.join(work, "pi-gateway");
  await writeFile(fixture, native, { mode: 0o500 });
  const extracted = path.join(work, "extracted.json");
  await writeFile(extracted, JSON.stringify({ binarySha256: sha256(native) }));
  const common = ["--record", record, "--runner-temp", runnerTemp];

  return { runnerTemp, root, marker, record, fixture, extracted, work, native, common };
}

const numericExit = Schema.is(Schema.Number);

async function prepareRefusesExisting(plant: (out: string) => Promise<void>): Promise<string> {
  const target = gatewayTarget();
  expect(target).toBeDefined();
  const runnerTemp = await ownedTemp("nix-cli-out-");
  const out = path.join(runnerTemp, "record.json");
  await plant(out);
  const before = await lstat(out, { bigint: true });

  const outcome = await cli([
    "prepare",
    "--target",
    target ?? "",
    "--runner-temp",
    runnerTemp,
    "--out",
    out,
  ]);

  refused(
    outcome,
    /Cannot exclusively create record .*; owned Nix root .*gateway-nix-\w{6} retained/u,
  );
  const after = await lstat(out, { bigint: true });
  expect([after.ino, after.mtimeNs, after.size]).toStrictEqual([
    before.ino,
    before.mtimeNs,
    before.size,
  ]);
  const names = await readdir(runnerTemp);
  const roots = names.filter((name) => name.startsWith("gateway-nix-"));
  expect(roots).toHaveLength(1);
  const root = path.join(runnerTemp, roots[0] ?? "");
  expect(outcome.stderr).toContain(root);
  const entries = await readdir(root);
  expect(entries.toSorted()).toStrictEqual(["owner.json"]);

  return out;
}

const WRITER_CHILD = `
import { execFileSync } from "node:child_process";
import { readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createJiti } from "jiti";
const [helper, dir, kind, recordsJson] = process.argv.slice(1);
const { createRecord } = await createJiti(import.meta.url).import(helper);
const out = dir + "/record.json";
const report = { contents: [] };
const writer = await createRecord(out);
try {
  for (const record of JSON.parse(recordsJson)) {
    await writer.write(record);
    report.contents.push(await readFile(out, "utf8"));
  }
  await rename(out, dir + "/own.json");
  if (kind === "regular") await writeFile(out, "foreign\\n");
  if (kind === "symlink") {
    await writeFile(dir + "/target", "foreign\\n");
    await symlink(dir + "/target", out);
  }
  if (kind === "fifo") execFileSync("mkfifo", ["-m", "0600", out]);
  report.replaced = await writer.write({ status: "acquired" }).then(() => "accepted", (e) => e.message);
} finally {
  await writer.close();
}
report.afterClose = await writer.write({ status: "late" }).then(() => "accepted", (e) => e.code);
process.stdout.write(JSON.stringify(report));
`;

const PREPARING = [
  { status: "preparing", pad: "x".repeat(5000) },
  { status: "p" },
  { status: "preparing", pad: "y".repeat(9000) },
];

function serialized(record: Schema.Json): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

describe("verify-gateway-nix consumer CLI", () => {
  afterEach(async () => {
    await Promise.all(
      temps.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  afterAll(() => {
    const leaked = created.filter((dir) => existsSync(dir));

    if (leaked.length > 0) {
      throw new Error(`Temp directories left behind: ${leaked.join(", ")}`);
    }
  });

  describe("verify-gateway-nix CLI input hardening", () => {
    test("refuses FIFO record, owner marker, extracted record and fixture without blocking", async () => {
      const run = await ownedRun();
      const install = ["--extracted", run.extracted, "--fixture", run.fixture];

      const recordFifo = path.join(run.runnerTemp, "fifo-record.json");
      await mkfifo(recordFifo);
      const fifoRecord = ["--record", recordFifo, "--runner-temp", run.runnerTemp];
      refused(await cli(["install-fixture", ...fifoRecord, ...install]), /Refusing owned read/u);

      const extractedFifo = path.join(run.work, "fifo-extracted.json");
      await mkfifo(extractedFifo);
      refused(
        await cli([
          "install-fixture",
          ...run.common,
          "--extracted",
          extractedFifo,
          "--fixture",
          run.fixture,
        ]),
        /Refusing owned read/u,
      );

      const fixtureFifo = path.join(run.work, "fifo-gateway");
      await mkfifo(fixtureFifo);
      refused(
        await cli([
          "install-fixture",
          ...run.common,
          "--extracted",
          run.extracted,
          "--fixture",
          fixtureFifo,
        ]),
        /Refusing owned read/u,
      );

      await rm(run.marker, { force: true });
      await mkfifo(run.marker);
      refused(await cli(["cleanup", ...run.common]), /Refusing owned read/u);
      const root = await lstat(run.root);
      expect(root.isDirectory()).toBe(true);
    });

    test("refuses a fixture reached through a symlinked parent directory", async () => {
      const run = await ownedRun();
      const alias = path.join(run.runnerTemp, "alias");
      await symlink(run.work, alias);

      const outcome = await cli([
        "install-fixture",
        ...run.common,
        "--extracted",
        run.extracted,
        "--fixture",
        path.join(alias, "pi-gateway"),
      ]);

      refused(outcome, /Fixture directory is not canonical/u);
      await expect(readFile(run.fixture)).resolves.toStrictEqual(run.native);
    });

    test("cleanup removes exactly the owned root and proves it absent; forged markers are refused", async () => {
      const forged = await ownedRun();
      await chmod(forged.marker, 0o600);
      const marker = jsonObject(parseJson(await readFile(forged.marker)));
      await writeFile(
        forged.marker,
        JSON.stringify({ ...Object.fromEntries(Object.entries(marker)), nonce: "c".repeat(32) }),
      );
      refused(await cli(["cleanup", ...forged.common]), /marker does not match/u);
      expect(existsSync(forged.root)).toBe(true);

      const run = await ownedRun();
      const outcome = await cli(["cleanup", ...run.common]);
      expect(outcome).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(outcome.stdout)).toStrictEqual({ removed: run.root });
      expect(existsSync(run.root)).toBe(false);
      await expect(readFile(run.fixture)).resolves.toStrictEqual(run.native);
      expect(existsSync(run.record)).toBe(true);
    });

    test.each([
      ["regular file", async (out: string) => writeFile(out, "foreign record\n")],
      [
        "symlink to a foreign file",
        async (out: string) => {
          await writeFile(`${out}.target`, "foreign record\n");
          await symlink(`${out}.target`, out);
        },
      ],
    ])(
      "prepare never opens, follows or replaces an existing --out (%s) and names its retained root",
      async (_kind, plant) => {
        const out = await prepareRefusesExisting(plant);
        await expect(readFile(out, "utf8")).resolves.toBe("foreign record\n");
      },
    );

    test("prepare never opens an existing FIFO --out and names its retained root", async () => {
      const out = await prepareRefusesExisting(mkfifo);
      const stat = await lstat(out);
      expect(stat.isFIFO()).toBe(true);
    });
  });

  describe("verify-gateway-nix record writer after creation", () => {
    test.each([
      [
        "regular",
        async (out: string) => {
          await expect(readFile(out, "utf8")).resolves.toBe("foreign\n");
        },
      ],
      [
        "symlink",
        async (out: string) => {
          const link = await lstat(out);
          expect(link.isSymbolicLink()).toBe(true);
          await expect(readFile(out, "utf8")).resolves.toBe("foreign\n");
        },
      ],
      [
        "fifo",
        async (out: string) => {
          const fifo = await lstat(out);
          expect(fifo.isFIFO()).toBe(true);
        },
      ],
    ])(
      "rewrites at position 0 and refuses a %s replacement without touching it",
      async (kind, foreignUnchanged) => {
        const dir = await ownedTemp("nix-writer-");

        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            "--no-warnings",
            "--input-type=module",
            "-e",
            WRITER_CHILD,
            ioHelper,
            dir,
            kind,
            JSON.stringify(PREPARING),
          ],
          {
            cwd: repository,
            timeout: CHILD_DEADLINE_MS,
            killSignal: "SIGKILL",
            maxBuffer: 1_048_576,
          },
        );

        const report = jsonObject(parseJson(stdout));

        expect(report.contents).toStrictEqual(PREPARING.map((record) => serialized(record)));
        expect(report.replaced).toMatch(/Record path .*record\.json was replaced/u);
        await expect(readFile(path.join(dir, "own.json"), "utf8")).resolves.toBe(
          serialized({ status: "acquired" }),
        );
        expect(report.afterClose).toBe("EBADF");
        await foreignUnchanged(path.join(dir, "record.json"));
      },
    );
  });
});
