import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { acquireGateway } from "../onboarding/acquire.js";
import type { AcquisitionPlan } from "../onboarding/acquire.js";
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
  const exec = vi.fn<() => Promise<string>>(async () =>
    JSON.stringify({
      name: "pi-gateway",
      version: "0.1.0",
      wireVersions: [1],
      capabilities: ["managed-on-demand-v1"],
    }),
  );
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
      expect.stringContaining(".pending-gateway-"),
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
    const abandoned = await fs.mkdtemp(path.join(s.plan.installRoot, ".pending-gateway-"));
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
    exec.mockResolvedValue(await s.exec());
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
    exec.mockResolvedValue(await s.exec());
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
