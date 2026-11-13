import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { jsonObject, sha256 } from "../onboarding/artifact.js";
import { gatewayTarget } from "../onboarding/catalog.js";

/**
 * The real `scripts/verify-gateway-nix.ts` CLI, each run in its own Node child with a hard
 * deadline outside the Vitest worker. No Nix, network or provider is reached: every case is
 * refused, or (cleanup) succeeds, before any Nix child process could start.
 */
const repository = path.resolve(import.meta.dirname, "../../..");
const script = path.join(repository, "scripts/verify-gateway-nix.ts");
const ioHelper = path.join(repository, "scripts/verify-gateway-nix-io.ts");
/** A blocking FIFO open would hang until this deadline; a correct refusal takes well under it. */
const CHILD_DEADLINE_MS = 30_000;
const FAKE_STORE = `/nix/store/${"a".repeat(32)}-pi-gateway-0.1.0/bin/pi-gateway`;

type Outcome = { code: number | null; signal: string | null; stdout: string; stderr: string };

async function cli(args: string[]): Promise<Outcome> {
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
          const code = typeof error.code === "number" ? error.code : null;
          resolve({ code, signal: error.signal ?? null, stdout, stderr });
        }
      },
    );
  });
}

async function mkfifo(filename: string): Promise<void> {
  await promisify(execFile)("mkfifo", ["-m", "0600", filename], { timeout: 5000 });
  const stat = await fs.lstat(filename);
  expect(stat.isFIFO()).toBe(true);
}

function refused(outcome: Outcome, pattern: RegExp): void {
  // Not killed at the deadline: a prompt, explained refusal.
  expect(outcome.signal).toBeNull();
  expect(outcome.code).toBe(1);
  expect(outcome.stdout).toBe("");
  expect(outcome.stderr).toMatch(pattern);
}

/** Temps still to drain after the current case, and every exact temp this run made. */
const temps: string[] = [];
const created: string[] = [];

/** A fresh, canonical temp directory owned by this run and drained after each case. */
async function ownedTemp(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  created.push(dir);
  return dir;
}

/** A canonical RUNNER_TEMP holding one owned root, marker and acquired record, as `prepare` writes. */
async function ownedRun() {
  const runnerTemp = await ownedTemp("nix-cli-test-");
  const root = await fs.mkdtemp(path.join(runnerTemp, "gateway-nix-"));
  const stat = await fs.lstat(root, { bigint: true });
  const identity = {
    root,
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: process.getuid?.(),
    nonce: randomBytes(16).toString("hex"),
  };
  const marker = path.join(root, "owner.json");
  await fs.writeFile(marker, JSON.stringify(identity), { flag: "wx", mode: 0o400 });
  const record = path.join(runnerTemp, "record.json");
  const acquired = { ...identity, status: "acquired", executable: FAKE_STORE };
  await fs.writeFile(record, JSON.stringify({ ...acquired, binarySha256: "b".repeat(64) }));
  const native = Buffer.from("authenticated native fixture bytes");
  const work = path.join(runnerTemp, "consumer");
  await fs.mkdir(work, { mode: 0o700 });
  const fixture = path.join(work, "pi-gateway");
  await fs.writeFile(fixture, native, { mode: 0o500 });
  const extracted = path.join(work, "extracted.json");
  await fs.writeFile(extracted, JSON.stringify({ binarySha256: sha256(native) }));
  const common = ["--record", record, "--runner-temp", runnerTemp];
  return { runnerTemp, root, marker, record, fixture, extracted, work, native, common };
}

/** Plants a foreign `--out`, runs `prepare`, and proves the refusal touched nothing but its own root. */
async function prepareRefusesExisting(plant: (out: string) => Promise<unknown>): Promise<string> {
  const target = gatewayTarget();
  expect(target).toBeDefined();
  const runnerTemp = await ownedTemp("nix-cli-out-");
  const out = path.join(runnerTemp, "record.json");
  await plant(out);
  const before = await fs.lstat(out, { bigint: true });

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
  const after = await fs.lstat(out, { bigint: true });
  expect([after.ino, after.mtimeNs, after.size]).toStrictEqual([
    before.ino,
    before.mtimeNs,
    before.size,
  ]);
  // The owned root and marker exist; no private HOME/TMPDIR was ever made, so no child ran.
  const names = await fs.readdir(runnerTemp);
  const roots = names.filter((name) => name.startsWith("gateway-nix-"));
  expect(roots).toHaveLength(1);
  const root = path.join(runnerTemp, roots[0] ?? "");
  expect(outcome.stderr).toContain(root);
  const entries = await fs.readdir(root);
  expect(entries.toSorted()).toStrictEqual(["owner.json"]);
  return out;
}

/**
 * Owned Node child (hard deadline, outside the Vitest worker) for the record writer the CLI uses: create, write preparing records of varying
 * length, then rename the created file aside and plant a foreign entry at the visible path.
 */
const WRITER_CHILD = `
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createJiti } from "jiti";
const [helper, dir, kind, recordsJson] = process.argv.slice(1);
const { createRecord } = await createJiti(import.meta.url).import(helper);
const out = dir + "/record.json";
const report = { contents: [] };
const writer = await createRecord(out);
try {
  for (const record of JSON.parse(recordsJson)) {
    await writer.write(record);
    report.contents.push(await fs.readFile(out, "utf8"));
  }
  await fs.rename(out, dir + "/own.json");
  if (kind === "regular") await fs.writeFile(out, "foreign\\n");
  if (kind === "symlink") {
    await fs.writeFile(dir + "/target", "foreign\\n");
    await fs.symlink(dir + "/target", out);
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

function serialized(record: object): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

// One top-level describe, so every case in this module drains its temps after it runs.
describe("verify-gateway-nix consumer CLI", () => {
  // Only the exact paths this run recorded are removed; nothing is matched by prefix.
  afterEach(async () => {
    await Promise.all(
      temps.splice(0).map(async (dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  // Proof by exact name, not by prefix: no directory this run created is left behind.
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

      await fs.rm(run.marker, { force: true });
      await mkfifo(run.marker);
      refused(await cli(["cleanup", ...run.common]), /Refusing owned read/u);
      // Refused, so the owned root is retained.
      const root = await fs.lstat(run.root);
      expect(root.isDirectory()).toBe(true);
    });

    test("refuses a fixture reached through a symlinked parent directory", async () => {
      const run = await ownedRun();
      const alias = path.join(run.runnerTemp, "alias");
      await fs.symlink(run.work, alias);
      const outcome = await cli([
        "install-fixture",
        ...run.common,
        "--extracted",
        run.extracted,
        "--fixture",
        path.join(alias, "pi-gateway"),
      ]);
      refused(outcome, /Fixture directory is not canonical/u);
      await expect(fs.readFile(run.fixture)).resolves.toStrictEqual(run.native);
    });

    test("cleanup removes exactly the owned root and proves it absent; forged markers are refused", async () => {
      const forged = await ownedRun();
      await fs.chmod(forged.marker, 0o600);
      const marker = jsonObject(JSON.parse(await fs.readFile(forged.marker, "utf8")));
      await fs.writeFile(forged.marker, JSON.stringify({ ...marker, nonce: "c".repeat(32) }));
      refused(await cli(["cleanup", ...forged.common]), /marker does not match/u);
      expect(existsSync(forged.root)).toBe(true);

      const run = await ownedRun();
      const outcome = await cli(["cleanup", ...run.common]);
      expect(outcome).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(outcome.stdout)).toStrictEqual({ removed: run.root });
      expect(existsSync(run.root)).toBe(false);
      // Only the root went: the record and fixture beside it are untouched.
      await expect(fs.readFile(run.fixture)).resolves.toStrictEqual(run.native);
      expect(existsSync(run.record)).toBe(true);
    });

    test.each([
      ["regular file", async (out: string) => fs.writeFile(out, "foreign record\n")],
      [
        "symlink to a foreign file",
        async (out: string) => {
          await fs.writeFile(`${out}.target`, "foreign record\n");
          await fs.symlink(`${out}.target`, out);
        },
      ],
    ])(
      "prepare never opens, follows or replaces an existing --out (%s) and names its retained root",
      async (_kind, plant) => {
        const out = await prepareRefusesExisting(plant);
        await expect(fs.readFile(out, "utf8")).resolves.toBe("foreign record\n");
      },
    );

    test("prepare never opens an existing FIFO --out and names its retained root", async () => {
      const out = await prepareRefusesExisting(mkfifo);
      const stat = await fs.lstat(out);
      expect(stat.isFIFO()).toBe(true);
    });
  });

  describe("verify-gateway-nix record writer after creation", () => {
    test.each([
      [
        "regular",
        async (out: string) => {
          await expect(fs.readFile(out, "utf8")).resolves.toBe("foreign\n");
        },
      ],
      [
        "symlink",
        async (out: string) => {
          const link = await fs.lstat(out);
          expect(link.isSymbolicLink()).toBe(true);
          await expect(fs.readFile(out, "utf8")).resolves.toBe("foreign\n");
        },
      ],
      [
        "fifo",
        async (out: string) => {
          const fifo = await fs.lstat(out);
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
        const report = jsonObject(JSON.parse(stdout));

        // Longer, shorter, longer: every visible file is exactly the last record, no suffix or holes.
        expect(report.contents).toStrictEqual(PREPARING.map((record) => serialized(record)));
        expect(report.replaced).toMatch(/Record path .*record\.json was replaced/u);
        // Only the retained descriptor's own file received the update; it was closed in `finally`.
        await expect(fs.readFile(path.join(dir, "own.json"), "utf8")).resolves.toBe(
          serialized({ status: "acquired" }),
        );
        expect(report.afterClose).toBe("EBADF");
        await foreignUnchanged(path.join(dir, "record.json"));
      },
    );
  });
});
