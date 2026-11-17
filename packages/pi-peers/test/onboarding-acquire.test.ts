import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acquireGateway } from "../onboarding/acquire.js";
import type {
  AcquisitionPlan,
  AcquisitionResult,
  AcquisitionSeams,
} from "../onboarding/acquire.js";
import { sha256 } from "../onboarding/artifact.js";
import { executableDigest } from "../onboarding/backend.js";
import { gatewayTarget } from "../onboarding/catalog.js";
import { fixture } from "./onboarding-artifact-fixture.js";

const roots: string[] = [];
const narHash = `sha256-${Buffer.alloc(32, 251).toString("base64")}`;
function requestUrl(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.href;
  }
  return url.url;
}
async function mockNixBuild(_file: string, args: string[]): Promise<string> {
  const link = args[args.indexOf("--out-link") + 1];
  if (link === undefined) {
    throw new Error("Missing build link");
  }
  await fs.symlink("/nix/store/test-pi-gateway", link);
  return "";
}
const failCompletionWrite: typeof fs.writeFile = async (filename, content, options) => {
  if (typeof filename === "string" && filename.endsWith("installed.json")) {
    throw new Error("simulated completion failure");
  }
  return fs.writeFile(filename, content, options);
};

async function setup() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pi-acquire-test-"));
  roots.push(root);
  const f = fixture(gatewayTarget());
  const plan: AcquisitionPlan = {
    approved: true,
    method: "native",
    ...f.pin,
    target: gatewayTarget() ?? "unsupported",
    installRoot: path.join(root, "install"),
    deadlineMs: Date.now() + 30_000,
  };
  const versionJson = JSON.stringify({
    name: "pi-gateway",
    version: "0.1.0",
    wireVersions: [1],
    capabilities: ["managed-on-demand-v1"],
  });
  const exec = vi.fn<AcquisitionSeams["exec"]>(async () => versionJson);
  const fetcher = vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        new Uint8Array(requestUrl(url).endsWith("manifest.json") ? f.manifest : f.archive),
      ),
  );
  return {
    root,
    f,
    plan,
    exec,
    versionJson,
    fetcher,
    options: {
      catalog: { nix: null, native: f.pin },
      seams: { fetch: fetcher, exec },
    },
  };
}
describe("approved gateway acquisition", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("authenticates download before private install and version probe", async () => {
    const s = await setup();
    const result = await acquireGateway(s.plan, s.options);
    expect(path.isAbsolute(result.executable)).toBe(true);
    await expect(fs.readFile(result.executable)).resolves.toStrictEqual(s.f.binary);
    expect(s.exec).toHaveBeenCalledWith(
      expect.stringContaining(`/.gateway-${s.plan.version}-${s.plan.sourceRevision}-native-`),
      ["--version", "--json"],
      expect.any(AbortSignal),
    );
    const stat = await fs.stat(result.executable);
    expect(stat.mode & 0o777).toBe(0o500);
  });
  test("reuses only integrity checked completed versions and repeats capability probe", async () => {
    const s = await setup();
    const installed = await acquireGateway(s.plan, s.options);
    s.fetcher.mockClear();
    await expect(acquireGateway(s.plan, s.options)).resolves.toStrictEqual(installed);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.exec).toHaveBeenCalledTimes(2);
    await fs.chmod(installed.executable, 0o700);
    await fs.writeFile(installed.executable, "corrupt");
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("integrity mismatch");
    expect(s.exec).toHaveBeenCalledTimes(2);
    await expect(fs.stat(installed.executable)).resolves.toBeDefined();
  });
  test("requires the reviewed pairing capability rather than treating the old gateway as sufficient", async () => {
    const s = await setup();
    await expect(
      acquireGateway({ ...s.plan, requiredCapabilities: ["pairing-helper-v1"] }, s.options),
    ).rejects.toThrow("capability mismatch");
  });
  test("cancels before apply with zero filesystem or fetch effects", async () => {
    const s = await setup();
    const abort = new AbortController();
    abort.abort();
    await expect(acquireGateway(s.plan, { ...s.options, signal: abort.signal })).rejects.toThrow(
      /.+/u,
    );
    await expect(fs.stat(s.plan.installRoot)).rejects.toThrow(/.+/u);
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  test("never trusts caller plan pin over shipped catalog", async () => {
    const s = await setup();
    await expect(
      acquireGateway({ ...s.plan, sourceRevision: "b".repeat(40) }, s.options),
    ).rejects.toThrow("trusted catalog");
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  test("downloads only from the exact semantic version release, not the source revision", async () => {
    const s = await setup();
    await acquireGateway(s.plan, s.options);
    const origin =
      "https://github.com/mich-murphy/pi-extensions/releases/download/pi-gateway-v0.1.0/";
    expect(s.fetcher.mock.calls.map(([url]) => requestUrl(url))).toStrictEqual([
      `${origin}manifest.json`,
      `${origin}${s.f.record.file}`,
    ]);
    expect(s.f.record.file).toBe(`pi-gateway-0.1.0-${s.plan.target}.tar.gz`);
  });
  test("fails malicious/pin-mismatched downloads without execution", async () => {
    const s = await setup();
    s.fetcher.mockImplementation(async () => new Response("malicious"));
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("pin mismatch");
    expect(s.exec).not.toHaveBeenCalled();
    await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([]);
  });
  test("authenticates archive before any executable probe", async () => {
    const s = await setup();
    s.fetcher.mockResolvedValueOnce(new Response(new Uint8Array(s.f.manifest)));
    s.fetcher.mockResolvedValueOnce(new Response(new Uint8Array(Buffer.alloc(s.f.archive.length))));
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("Archive integrity mismatch");
    expect(s.exec).not.toHaveBeenCalled();
    await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([]);
  });
  test("bounds manifest streaming and rejects expired deadlines without executing", async () => {
    const s = await setup();
    await expect(
      acquireGateway({ ...s.plan, deadlineMs: Date.now() - 1 }, s.options),
    ).rejects.toThrow("deadline");
    await expect(fs.stat(s.plan.installRoot)).rejects.toThrow(/ENOENT/u);
    s.fetcher.mockResolvedValue(new Response(new Uint8Array(Buffer.alloc(65_537))));
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("download exceeds bound");
    expect(s.exec).not.toHaveBeenCalled();
  });
  test("permits retry beside an interrupted private native attempt without sweeping unknown files", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    const abandoned = await fs.mkdtemp(
      path.join(s.plan.installRoot, `.gateway-${s.plan.version}-${s.plan.sourceRevision}-native-`),
    );
    await fs.writeFile(path.join(abandoned, "unknown"), "preserve");
    await acquireGateway(s.plan, s.options);
    await expect(fs.readFile(path.join(abandoned, "unknown"), "utf8")).resolves.toBe("preserve");
  });
  test("fails capability mismatch and cleans only owned version", async () => {
    const s = await setup();
    s.exec.mockResolvedValue("{}");
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("capability mismatch");
    await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([]);
  });
  test("cleans a failed Nix attempt and permits same-pin retry without adopting an interrupted root", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    const stale = path.join(
      s.plan.installRoot,
      `${s.plan.version}-${s.plan.sourceRevision}-nix-abandoned`,
    );
    await fs.mkdir(stale);
    await fs.writeFile(path.join(stale, "unknown"), "preserve");
    const exec = vi.fn<(file: string, args: string[], signal: AbortSignal) => Promise<string>>();
    exec.mockRejectedValueOnce(new Error("bounded build failure"));
    const plan = {
      ...s.plan,
      method: "nix" as const,
      narHash,
      nixExecutable: "/nix/store/test-nix/bin/nix",
    };
    const options = {
      catalog: { nix: { ...s.f.pin, narHash }, native: null },
      seams: {
        exec,
        fs: { ...fs, realpath: async () => "/nix/store/test-pi-gateway/bin/pi-gateway" },
      },
    };
    await expect(acquireGateway(plan, options)).rejects.toThrow("bounded build failure");
    await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([path.basename(stale)]);
    exec.mockImplementationOnce(mockNixBuild);
    exec.mockResolvedValue(s.versionJson);
    const result = await acquireGateway(plan, options);
    expect(result.ownedPaths).not.toContain(stale);
    await expect(fs.readFile(path.join(stale, "unknown"), "utf8")).resolves.toBe("preserve");
  });
  test.each([
    { narHash: `sha256-${Buffer.alloc(32).toString("base64")}` },
    { narHash: undefined },
    { narHash: "sha256-not-sri" },
    { sourceRevision: "b".repeat(40) },
  ])("rejects Nix content/revision mismatch before all effects: %j", async (override) => {
    const s = await setup();
    const exec = vi.fn<() => Promise<string>>();
    const filesystemEffect = vi.fn<() => Promise<never>>();
    const progress = vi.fn<(message: string) => void>();
    const plan = {
      ...s.plan,
      method: "nix" as const,
      narHash,
      nixExecutable: "/nix/store/test-nix/bin/nix",
      ...override,
    };
    await expect(
      // @ts-expect-error -- Deliberately malformed runtime plan includes a missing required narHash.
      acquireGateway(plan, {
        catalog: { nix: { ...s.f.pin, narHash }, native: null },
        seams: {
          exec,
          fetch: s.fetcher,
          fs: {
            ...fs,
            lstat: filesystemEffect,
            mkdir: filesystemEffect,
            mkdtemp: filesystemEffect,
          },
        },
        onProgress: progress,
      }),
    ).rejects.toThrow(/pin|trusted catalog/u);
    expect(exec).not.toHaveBeenCalled();
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(filesystemEffect).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    await expect(fs.stat(s.plan.installRoot)).rejects.toThrow(/ENOENT/u);
  });
  test("does not publish a native version when completion writing fails", async () => {
    const s = await setup();
    await expect(
      acquireGateway(s.plan, {
        ...s.options,
        seams: { ...s.options.seams, fs: { ...fs, writeFile: failCompletionWrite } },
      }),
    ).rejects.toThrow("simulated completion failure");
    await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([]);
    await expect(acquireGateway(s.plan, s.options)).resolves.toHaveProperty("executable");
  });
  test("never adopts existing installations or follows symlink roots", async () => {
    const s = await setup();
    await fs.symlink(s.root, s.plan.installRoot);
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("ancestor");
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  test("rejects untrusted redirect and oversized stream", async () => {
    const s = await setup();
    s.fetcher.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.invalid/archive" } }),
    );
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("origin");
    expect(s.exec).not.toHaveBeenCalled();
  });
  test("uses exact Nix source and dedicated out-link, not a default profile", async () => {
    const s = await setup();
    const exec = vi.fn<(file: string, args: string[], signal: AbortSignal) => Promise<string>>();
    exec.mockImplementationOnce(mockNixBuild);
    exec.mockResolvedValue(s.versionJson);
    const realpath = vi.fn<(filename: string) => Promise<string>>(
      async () => "/nix/store/test-pi-gateway/bin/pi-gateway",
    );
    const result = await acquireGateway(
      { ...s.plan, method: "nix", narHash, nixExecutable: "/nix/store/test-nix/bin/nix" },
      {
        catalog: { nix: { ...s.f.pin, narHash }, native: null },
        seams: { exec, fs: { ...fs, realpath } },
      },
    );
    expect(result.executable).toContain("/nix/store/");
    expect(exec.mock.calls[0]?.[1]).toContain(
      `github:mich-murphy/pi-extensions/${s.f.pin.sourceRevision}?narHash=${encodeURIComponent(narHash)}#pi-gateway`,
    );
    expect(exec.mock.calls[0]?.[0]).toBe("/nix/store/test-nix/bin/nix");
    expect(exec.mock.calls[0]?.[1]).toStrictEqual([
      "build",
      "--extra-experimental-features",
      "nix-command flakes",
      "--no-write-lock-file",
      "--out-link",
      expect.stringMatching(/\/result$/u),
      `github:mich-murphy/pi-extensions/${s.f.pin.sourceRevision}?narHash=${encodeURIComponent(narHash)}#pi-gateway`,
    ]);
    expect(exec.mock.calls[0]?.[1]).not.toContain("profile");
  });
});

type Setup = Awaited<ReturnType<typeof setup>>;
type Snapshot = { ino: number; mode: number; kind: string; content: string };
function kindOf(stat: { isSymbolicLink: () => boolean; isDirectory: () => boolean }): string {
  if (stat.isSymbolicLink()) {
    return "link";
  }
  return stat.isDirectory() ? "dir" : "file";
}
/** Inode, mode, kind and content of an entry (one directory level deep), never following links. */
async function snapshot(filename: string): Promise<Snapshot> {
  const stat = await fs.lstat(filename);
  let content: string;
  if (stat.isSymbolicLink()) {
    content = await fs.readlink(filename);
  } else if (stat.isDirectory()) {
    const names = await fs.readdir(filename);
    const parts = await Promise.all(
      names.toSorted().map(async (name) => {
        const child = await fs.lstat(path.join(filename, name));
        const body = child.isFile() ? await fs.readFile(path.join(filename, name), "utf8") : "";
        return `${name}:${child.ino}:${child.mode}:${body}`;
      }),
    );
    content = parts.join("|");
  } else {
    content = await fs.readFile(filename, "utf8");
  }
  return { ino: stat.ino, mode: stat.mode, kind: kindOf(stat), content };
}
function destinationOf(s: Setup): string {
  return path.join(s.plan.installRoot, `${s.plan.version}-${s.plan.sourceRevision}-native`);
}
function attemptPrefix(s: Setup): string {
  return `.gateway-${s.plan.version}-${s.plan.sourceRevision}-native-`;
}
function only<T>(items: T[]): T {
  const [item] = items;
  if (items.length !== 1 || item === undefined) {
    throw new Error("Expected exactly one item");
  }
  return item;
}
/** Fixture-owned FIFO through the trusted system mkfifo, bounded by a timeout. */
async function mkfifo(filename: string): Promise<void> {
  await promisify(execFile)("/usr/bin/mkfifo", ["-m", "600", filename], { timeout: 5000 });
}
const stagedReplacements: [string, (filename: string) => Promise<void>][] = [
  ["FIFO", mkfifo],
  ["directory", async (filename) => fs.mkdir(filename, { mode: 0o700 })],
];
/** Real open seam that swaps the staged manifest for `replace` immediately before its sync open. */
function replacingOpen(replace: (filename: string) => Promise<void>): typeof fs.open {
  let replaced = false;
  return async (filename, flags, mode) => {
    if (!replaced && String(filename).endsWith("/manifest.json")) {
      replaced = true;
      await fs.unlink(filename);
      await replace(String(filename));
    }
    return fs.open(filename, flags, mode);
  };
}
function ioError(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}
/** Real filesystem seam whose symlink runs `before` immediately ahead of the real commit. */
function commitSeam(before: (destination: string) => Promise<void>) {
  const rename = vi.fn<typeof fs.rename>(fs.rename);
  const symlink: typeof fs.symlink = async (target, destination, type) => {
    await before(String(destination));
    return fs.symlink(target, destination, type);
  };
  return { rename, fs: { ...fs, rename, symlink } };
}
/** Holds every writer at the commit boundary until `count` writers have arrived. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  const reached = Promise.withResolvers<undefined>();
  return async () => {
    arrived += 1;
    if (arrived === count) {
      reached.resolve(undefined);
    }
    await reached.promise;
  };
}
/** Real symlink(2) that then reports an I/O error, leaving the outcome uncertain to the caller. */
const symlinkThenFail: typeof fs.symlink = async (target, destination, type) => {
  await fs.symlink(target, destination, type);
  throw ioError("EIO");
};
function failingOpen(failing: string): typeof fs.open {
  return async (filename, flags, mode) => {
    if (filename === failing) {
      throw ioError("EIO");
    }
    return fs.open(filename, flags, mode);
  };
}
function abortingOpen(abort: AbortController, suffix: string): typeof fs.open {
  return async (filename, flags, mode) => {
    if (String(filename).endsWith(suffix)) {
      abort.abort();
    }
    return fs.open(filename, flags, mode);
  };
}
async function writeInstall(directory: string, s: Setup): Promise<void> {
  await fs.writeFile(path.join(directory, "pi-gateway"), s.f.binary, { mode: 0o500 });
  await fs.writeFile(path.join(directory, "manifest.json"), s.f.manifest, { mode: 0o400 });
  await fs.writeFile(
    path.join(directory, "installed.json"),
    JSON.stringify({
      sourceRevision: s.plan.sourceRevision,
      version: s.plan.version,
      executable: path.join(directory, "pi-gateway"),
    }),
    { mode: 0o400 },
  );
}
const foreignEntries: [string, (destination: string) => Promise<void>][] = [
  ["empty directory", async (destination) => fs.mkdir(destination, { mode: 0o700 })],
  ["regular file", async (destination) => fs.writeFile(destination, "foreign", { mode: 0o600 })],
  ["symlink", async (destination) => fs.symlink("foreign-target", destination)],
  [
    "non-empty directory",
    async (destination) => {
      await fs.mkdir(destination, { mode: 0o700 });
      await fs.writeFile(path.join(destination, "installed.json"), "{not json", { mode: 0o600 });
      await fs.writeFile(path.join(destination, "pi-gateway"), "foreign", { mode: 0o700 });
    },
  ],
];
/** Moves a genuine payload to a fixed expected-pattern name so only the link text is tested. */
async function movedPayload(s: Setup, payload: string): Promise<string> {
  const name = `${attemptPrefix(s)}abcdef`;
  await fs.rename(payload, path.join(s.plan.installRoot, name));
  return name;
}
const unsafeLinks: [string, (s: Setup, payload: string) => Promise<string>][] = [
  [
    "parent traversal",
    async (s, payload) =>
      `../${path.basename(s.plan.installRoot)}/${await movedPayload(s, payload)}`,
  ],
  [
    "absolute target",
    async (s, payload) => path.join(s.plan.installRoot, await movedPayload(s, payload)),
  ],
  ["foreign name", async () => "foreign-payload"],
  ["wrong suffix length", async (s) => `${attemptPrefix(s)}abc`],
  ["other pin prefix", async (s) => `.gateway-9.9.9-${s.plan.sourceRevision}-native-abcdef`],
  ["dangling expected name", async (s) => `${attemptPrefix(s)}zzzzzz`],
];

describe("exclusive native publication", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test.each(foreignEntries)(
    "preserves a %s created at the publication boundary and removes only its own attempt",
    async (_kind, create) => {
      const s = await setup();
      await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
      const seam = commitSeam(create);
      await expect(
        acquireGateway(s.plan, { ...s.options, seams: { ...s.options.seams, fs: seam.fs } }),
      ).rejects.toThrow("collision; existing state preserved");
      const before = await snapshot(destinationOf(s));
      await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([
        path.basename(destinationOf(s)),
      ]);
      expect(seam.rename).not.toHaveBeenCalled();
      // Only this attempt's own staged binary was probed; foreign content never executes.
      expect(s.exec).toHaveBeenCalledTimes(1);
      expect(s.exec.mock.calls[0]?.[0]).toContain(`/${attemptPrefix(s)}`);
      // A later acquisition still refuses to adopt, replace or merge into the foreign entry.
      await expect(acquireGateway(s.plan, s.options)).rejects.toThrow(/.+/u);
      await expect(snapshot(destinationOf(s))).resolves.toStrictEqual(before);
      expect(s.exec).toHaveBeenCalledTimes(1);
    },
  );

  test("adopts only a reauthenticated concurrent winner when both writers reach the commit", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    const seam = commitSeam(barrier(2));
    const options = { ...s.options, seams: { ...s.options.seams, fs: seam.fs } };
    const [first, second] = await Promise.all([
      acquireGateway(s.plan, options),
      acquireGateway(s.plan, options),
    ]);
    expect(first).toStrictEqual(second);
    const entries = await fs.readdir(s.plan.installRoot);
    const target = await fs.readlink(destinationOf(s));
    expect(entries.toSorted()).toStrictEqual([path.basename(destinationOf(s)), target].toSorted());
    expect(first.executable).toBe(path.join(s.plan.installRoot, target, "pi-gateway"));
    expect(first.ownedPaths).toStrictEqual([
      destinationOf(s),
      path.join(s.plan.installRoot, target),
    ]);
    // Two staged probes plus exactly one bounded reuse probe of the winner; no retry loop.
    expect(s.exec).toHaveBeenCalledTimes(3);
    expect(s.exec.mock.calls[2]?.[0]).toBe(first.executable);
    expect(s.fetcher).toHaveBeenCalledTimes(4);
    expect(seam.rename).not.toHaveBeenCalled();
  });

  test("rejects a concurrent winner whose binary fails reauthentication", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    const winners: AcquisitionResult[] = [];
    const seam = commitSeam(async () => {
      const winner = await acquireGateway(s.plan, s.options);
      winners.push(winner);
      await fs.chmod(winner.executable, 0o700);
      await fs.writeFile(winner.executable, "tampered");
    });
    await expect(
      acquireGateway(s.plan, { ...s.options, seams: { ...s.options.seams, fs: seam.fs } }),
    ).rejects.toThrow("collision; existing state preserved");
    const winner = only(winners);
    await expect(fs.readFile(winner.executable, "utf8")).resolves.toBe("tampered");
    await expect(fs.readdir(s.plan.installRoot)).resolves.toHaveLength(2);
    // The tampered binary is never executed: only the two staged attempts were probed.
    expect(s.exec).toHaveBeenCalledTimes(2);
  });

  test("retains a committed install when cancelled after the symlink and reuses it", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    const abort = new AbortController();
    const symlink: typeof fs.symlink = async (target, destination, type) => {
      await fs.symlink(target, destination, type);
      abort.abort();
    };
    const result = await acquireGateway(s.plan, {
      ...s.options,
      signal: abort.signal,
      seams: { ...s.options.seams, fs: { ...fs, symlink } },
    });
    await expect(fs.readFile(result.executable)).resolves.toStrictEqual(s.f.binary);
    s.fetcher.mockClear();
    await expect(acquireGateway(s.plan, s.options)).resolves.toStrictEqual(result);
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  test("retains link and payload when the post-commit root fsync fails", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    const open = failingOpen(s.plan.installRoot);
    await expect(
      acquireGateway(s.plan, { ...s.options, seams: { ...s.options.seams, fs: { ...fs, open } } }),
    ).rejects.toThrow("published but not yet durable");
    const target = await fs.readlink(destinationOf(s));
    s.fetcher.mockClear();
    const reused = await acquireGateway(s.plan, s.options);
    expect(reused.executable).toBe(path.join(s.plan.installRoot, target, "pi-gateway"));
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  test("retains a possibly published attempt when symlink reports an error after creating it", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    await expect(
      acquireGateway(s.plan, {
        ...s.options,
        seams: { ...s.options.seams, fs: { ...fs, symlink: symlinkThenFail } },
      }),
    ).rejects.toThrow("Uncertain gateway publication");
    const target = await fs.readlink(destinationOf(s));
    await expect(fs.readdir(s.plan.installRoot)).resolves.toHaveLength(2);
    s.fetcher.mockClear();
    const reused = await acquireGateway(s.plan, s.options);
    expect(reused.executable).toBe(path.join(s.plan.installRoot, target, "pi-gateway"));
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  test("retains its own attempt when link inspection fails after a symlink error", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    // At the commit, the owned root is moved to an owned sibling and an owned regular file takes
    // its path before symlink reports EIO. The real lstat of the destination then fails with
    // ENOTDIR for every uid, so the outcome of the commit cannot be inspected.
    const held = path.join(s.root, "held-install");
    const sentinel = "owned sentinel";
    const symlink: typeof fs.symlink = async () => {
      await fs.rename(s.plan.installRoot, held);
      await fs.writeFile(s.plan.installRoot, sentinel, { mode: 0o600, flag: "wx" });
      throw ioError("EIO");
    };
    try {
      await expect(
        acquireGateway(s.plan, {
          ...s.options,
          seams: { ...s.options.seams, fs: { ...fs, symlink } },
        }),
      ).rejects.toThrow("Uncertain gateway publication; attempt retained");
      // Nothing replaced or removed the sentinel or the held attempt while inspection was uncertain.
      await expect(fs.readFile(s.plan.installRoot, "utf8")).resolves.toBe(sentinel);
      const heldAttempt = only(await fs.readdir(held));
      await expect(fs.readFile(path.join(held, heldAttempt, "pi-gateway"))).resolves.toStrictEqual(
        s.f.binary,
      );
    } finally {
      await fs.rm(s.plan.installRoot, { force: true });
      await fs.rename(held, s.plan.installRoot);
    }
    // The outcome is unknown, so the complete owned payload is conservatively kept, never removed.
    const attempt = only(await fs.readdir(s.plan.installRoot));
    expect(attempt.startsWith(attemptPrefix(s))).toBe(true);
    await expect(
      fs.readdir(path.join(s.plan.installRoot, attempt)).then((names) => names.toSorted()),
    ).resolves.toStrictEqual(["installed.json", "manifest.json", "pi-gateway"]);
    await expect(
      fs.readFile(path.join(s.plan.installRoot, attempt, "pi-gateway")),
    ).resolves.toStrictEqual(s.f.binary);
  });

  test("refuses a completion marker whose executable aliases the link before any exec", async () => {
    const s = await setup();
    const first = await acquireGateway(s.plan, s.options);
    const payload = path.dirname(first.executable);
    const marker = path.join(payload, "installed.json");
    await fs.chmod(marker, 0o600);
    await fs.writeFile(
      marker,
      JSON.stringify({
        sourceRevision: s.plan.sourceRevision,
        version: s.plan.version,
        executable: path.join(destinationOf(s), "pi-gateway"),
      }),
    );
    await fs.chmod(marker, 0o400);
    const before = await snapshot(payload);
    s.fetcher.mockClear();
    s.exec.mockClear();
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow(
      "Existing executable identity changed",
    );
    expect(s.exec).not.toHaveBeenCalled();
    expect(s.fetcher).not.toHaveBeenCalled();
    await expect(snapshot(payload)).resolves.toStrictEqual(before);
  });

  test("removes its unpublished attempt when symlink fails without creating a link", async () => {
    const s = await setup();
    const symlink = vi.fn<typeof fs.symlink>(async () => {
      throw ioError("EACCES");
    });
    await expect(
      acquireGateway(s.plan, {
        ...s.options,
        seams: { ...s.options.seams, fs: { ...fs, symlink } },
      }),
    ).rejects.toThrow("simulated EACCES");
    expect(symlink).toHaveBeenCalledTimes(1);
    await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([]);
  });

  test("cancellation during pre-commit fsync publishes nothing and removes only its attempt", async () => {
    const s = await setup();
    const abort = new AbortController();
    const symlink = vi.fn<typeof fs.symlink>(fs.symlink);
    await expect(
      acquireGateway(s.plan, {
        ...s.options,
        signal: abort.signal,
        seams: {
          ...s.options.seams,
          fs: { ...fs, open: abortingOpen(abort, "installed.json"), symlink },
        },
      }),
    ).rejects.toThrow(/abort/iu);
    expect(symlink).not.toHaveBeenCalled();
    await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([]);
  });

  test.each(stagedReplacements)(
    "fails closed when a staged file becomes a %s before its fsync open",
    async (_kind, replace) => {
      const s = await setup();
      const symlink = vi.fn<typeof fs.symlink>(fs.symlink);
      await expect(
        acquireGateway(s.plan, {
          ...s.options,
          seams: { ...s.options.seams, fs: { ...fs, open: replacingOpen(replace), symlink } },
        }),
      ).rejects.toThrow("Unexpected staged file type or ownership");
      expect(symlink).not.toHaveBeenCalled();
      expect(s.exec).toHaveBeenCalledTimes(1);
      await expect(fs.readdir(s.plan.installRoot)).resolves.toStrictEqual([]);
    },
  );

  test("never adopts an unreferenced complete payload left by a crash before commit", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    const crashed = await fs.mkdtemp(path.join(s.plan.installRoot, attemptPrefix(s)));
    await writeInstall(crashed, s);
    const before = await snapshot(crashed);
    const result = await acquireGateway(s.plan, s.options);
    expect(result.executable.startsWith(`${crashed}/`)).toBe(false);
    expect(result.ownedPaths).not.toContain(crashed);
    await expect(snapshot(crashed)).resolves.toStrictEqual(before);
    await expect(fs.readdir(s.plan.installRoot)).resolves.toHaveLength(3);
  });

  test("reuses a legacy directory installation without migration and runtime digest still works", async () => {
    const s = await setup();
    await fs.mkdir(s.plan.installRoot, { mode: 0o700 });
    const legacy = destinationOf(s);
    await fs.mkdir(legacy, { mode: 0o700 });
    await writeInstall(legacy, s);
    const before = await snapshot(legacy);
    const result = await acquireGateway(s.plan, s.options);
    expect(result.executable).toBe(path.join(legacy, "pi-gateway"));
    expect(result.ownedPaths).toStrictEqual([legacy]);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(s.exec).toHaveBeenCalledWith(
      result.executable,
      ["--version", "--json"],
      expect.any(AbortSignal),
    );
    await expect(snapshot(legacy)).resolves.toStrictEqual(before);
    await expect(executableDigest(result.executable)).resolves.toBe(sha256(s.f.binary));
  });

  test("new installs return a regular payload executable usable by the runtime digest", async () => {
    const s = await setup();
    const result = await acquireGateway(s.plan, s.options);
    const stat = await fs.lstat(result.executable);
    expect(stat.isFile()).toBe(true);
    expect(path.basename(path.dirname(result.executable)).startsWith(attemptPrefix(s))).toBe(true);
    await expect(executableDigest(result.executable)).resolves.toBe(sha256(s.f.binary));
    const link = await fs.lstat(destinationOf(s));
    expect(link.isSymbolicLink()).toBe(true);
  });

  test.each(unsafeLinks)(
    "refuses a %s symlink without fetch, exec or mutation",
    async (_kind, targetOf) => {
      const s = await setup();
      // A genuine payload exists so only the link target decides rejection.
      const first = await acquireGateway(s.plan, s.options);
      await fs.unlink(destinationOf(s));
      const target = await targetOf(s, path.dirname(first.executable));
      await fs.symlink(target, destinationOf(s));
      const before = await snapshot(s.plan.installRoot);
      s.fetcher.mockClear();
      s.exec.mockClear();
      await expect(acquireGateway(s.plan, s.options)).rejects.toThrow(
        "Unsafe existing installation",
      );
      expect(s.fetcher).not.toHaveBeenCalled();
      expect(s.exec).not.toHaveBeenCalled();
      await expect(snapshot(s.plan.installRoot)).resolves.toStrictEqual(before);
    },
  );

  test("refuses an expected-name payload that is itself a symlink or not private", async () => {
    const s = await setup();
    const first = await acquireGateway(s.plan, s.options);
    const payload = path.dirname(first.executable);
    await fs.chmod(payload, 0o750);
    s.exec.mockClear();
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("Unsafe existing installation");
    await fs.chmod(payload, 0o700);
    const moved = path.join(s.root, "elsewhere");
    await fs.rename(payload, moved);
    await fs.symlink(moved, payload);
    await expect(acquireGateway(s.plan, s.options)).rejects.toThrow("Unsafe existing installation");
    expect(s.exec).not.toHaveBeenCalled();
    const payloadStat = await fs.lstat(payload);
    expect(payloadStat.isSymbolicLink()).toBe(true);
  });
});
