import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import { freshId } from "../adapter/transport.js";
import {
  applyLocal,
  reloadManagedLauncher,
  resetLocal,
  setupPaths,
} from "../onboarding/backend.js";
import { doctorReport } from "../onboarding/doctor.js";
import { digest } from "../onboarding/files.js";
import { ensureKey, keyAction, keyPaths, peerKeyError, savedKey } from "../onboarding/keys.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import type { LocalPlan } from "../onboarding/plan.js";
import { linkedPlan, unlinkedPlan } from "../onboarding/remote.js";
import { decodeGateway, decodeManaged, parseJson } from "../onboarding/schema.js";
import { setupCommand } from "../onboarding/setup.js";
import type { ActivatePlan } from "../onboarding/upgrade.js";
import { RETIRED_NOTICE } from "../onboarding/upgrade.js";
import { dialog, nativeAddress, nativeFixture, nativeUntil } from "./onboarding-fixtures.js";

const PEER_KEY = "ab".repeat(32);
const HEX = /^[a-f0-9]{64}$/u;
const LINK = "Link a remote computer";

const intent = {
  peerMachineId: "dev-01",
  endpoint: { mode: "connect" as const, address: "100.64.0.2:7443" },
  peerPublicKey: PEER_KEY,
};

type Profile = { readonly agent: string; client?: GatewayClient };

function client(profile: Profile): GatewayClient {
  if (profile.client === undefined) {
    throw new Error("Profile was not activated");
  }

  return profile.client;
}

function activator(profile: Profile): ActivatePlan {
  return async (plan, setup) => {
    profile.client?.close();
    const next = new GatewayClient({
      config: plan.adapter,
      peer: {
        machineId: plan.adapter.machineId,
        sessionId: freshId(),
        runtimeNonce: freshId(),
      },
      incoming: () => {
        throw new Error("Unexpected authored request");
      },
      statusChanged: () => undefined,
      ensureGateway: reloadManagedLauncher(profile.agent, plan.adapter, setup),
    });
    profile.client = next;
    await next.reconnect();
  };
}

async function requiredKey(agent: string): Promise<string> {
  const key = await savedKey(setupPaths(agent).directory);

  if (key === undefined) {
    throw new Error("This computer's key is missing");
  }

  return key;
}

function hasPeer(reply: Awaited<ReturnType<GatewayClient["discover"]>>, machine: string): boolean {
  return (
    reply.outcome.tag === "ok" &&
    "peers" in reply.outcome.value &&
    reply.outcome.value.peers.some((entry) => entry.peer.machineId === machine)
  );
}

function remoteRow(report: Awaited<ReturnType<typeof doctorReport>>) {
  return report.rows.find((row) => row.label === "Remote link");
}

function titles(ctx: ReturnType<typeof dialog>): string {
  return vi
    .mocked(ctx.ui.select)
    .mock.calls.map(([title]) => title)
    .join("\n");
}

async function retiredSetup(agent: string, executable: string) {
  const paths = setupPaths(agent);
  const plan = localPlan(defaultChoices("laptop"), paths.socket);
  const setup = await applyLocal(agent, plan, { acquire: async () => executable }, () => undefined);
  const folder = join(paths.directory, "pair-0123456789abcdef");
  await mkdir(folder, { mode: 0o700 });
  await writeFile(join(folder, "leaf.key"), "old certificate key");
  const linked = linkedPlan(plan, intent, join(folder, "leaf.key"));

  const remote = {
    machineId: intent.peerMachineId,
    endpoint: intent.endpoint,
    rootCertificates: [join(folder, "root.der")],
    certificateChain: [join(folder, "leaf.der")],
    issuerCertificates: [],
    privateKey: join(folder, "leaf.key"),
    crls: [join(folder, "root.crl")],
    revocationState: join(folder, "floor.json"),
  };

  const gateway = `${JSON.stringify({ ...linked.gateway, remote }, null, 2)}\n`;
  const adapter = `${JSON.stringify(linked.adapter, null, 2)}\n`;
  const pairing = JSON.stringify({
    version: 1,
    retired: "certificate pairing record",
  });
  await writeFile(paths.gateway, gateway);
  await writeFile(paths.adapter, adapter);
  await writeFile(join(paths.directory, "pairing.json"), pairing, {
    mode: 0o600,
  });
  await writeFile(
    paths.metadata,
    `${JSON.stringify(
      {
        ...setup,
        adapterSha256: digest(adapter),
        gatewaySha256: digest(gateway),
        pairingSha256: digest(pairing),
      },
      null,
      2,
    )}\n`,
  );

  return { paths, folder, pairing };
}

function basePlan(): LocalPlan {
  return localPlan(defaultChoices("laptop"), "/private/owned/s");
}

function remoteKeys(value: LocalPlan): Array<string> {
  return Object.keys(value.gateway.remote ?? {}).toSorted();
}

async function modeOf(path: string): Promise<number> {
  const entry = await lstat(path);

  return entry.mode & 0o777;
}

describe("pinned link plans", () => {
  test("a linked plan writes exactly the pinned remote and grants the peer both ways", () => {
    const linked = linkedPlan(basePlan(), intent, "/keys/gateway-key.der");
    expect(linked.gateway.remote).toStrictEqual({
      machineId: "dev-01",
      endpoint: { mode: "connect", address: "100.64.0.2:7443" },
      privateKey: "/keys/gateway-key.der",
      peerPublicKey: PEER_KEY,
    });
    expect(remoteKeys(linked)).toStrictEqual([
      "endpoint",
      "machineId",
      "peerPublicKey",
      "privateKey",
    ]);
    expect(linked.gateway.policies.filter((policy) => policy.machineId === "dev-01")).toStrictEqual(
      [
        {
          machineId: "dev-01",
          scopeId: "local",
          permissions: ["discover", "push"],
          direction: "outgoing",
        },
        {
          machineId: "dev-01",
          scopeId: "local",
          permissions: ["discover", "push"],
          direction: "incoming",
        },
      ],
    );
    expect(decodeGateway(parseJson(JSON.stringify(linked.gateway)))).toStrictEqual(linked.gateway);
  });
  test("linking another computer replaces the old peer, and removing the link drops it", () => {
    const first = linkedPlan(basePlan(), intent, "/keys/gateway-key.der");
    const second = linkedPlan(first, { ...intent, peerMachineId: "dev-02" }, "/keys/k.der");
    const machines = second.adapter.policies.map((policy) => policy.machineId);
    expect(machines).toStrictEqual(["laptop", "dev-02"]);
    const removed = unlinkedPlan(second);
    expect(removed.gateway.remote).toBeUndefined();
    expect(removed.adapter.policies.map((policy) => policy.machineId)).toStrictEqual(["laptop"]);
  });
  test("a peer key is checked for encoding and for being this computer's own key", () => {
    expect(peerKeyError(` ${PEER_KEY}\n`, "cd".repeat(32))).toBeUndefined();
    expect(peerKeyError(PEER_KEY.toUpperCase(), "cd".repeat(32))).toContain("64 characters");
    expect(peerKeyError(PEER_KEY, PEER_KEY)).toContain("this computer's own key");
  });
  test("the gateway refuses a config with a CA field next to the pinned key", () => {
    const linked = linkedPlan(basePlan(), intent, "/keys/gateway-key.der");
    const mixed = {
      ...linked.gateway,
      remote: { ...linked.gateway.remote, crls: ["/c.crl"] },
    };
    expect(() => decodeGateway(parseJson(JSON.stringify(mixed)))).toThrow("crls");
  });
});

describe("this computer's key through the built gateway", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("key generate then key show return one public key; ensureKey reuses it", async () => {
    const setupDirectory = join(fixture.root, "setup");
    await mkdir(setupDirectory, { mode: 0o700 });
    const paths = keyPaths(setupDirectory);
    await expect(savedKey(setupDirectory)).resolves.toBeUndefined();
    const created = await ensureKey(fixture.executable, setupDirectory);
    expect(created).toMatch(HEX);
    const bytes = await readFile(paths.privateKey);
    await expect(
      keyAction(fixture.executable, paths.directory, "show", paths.privateKey),
    ).resolves.toBe(created);
    await expect(ensureKey(fixture.executable, setupDirectory)).resolves.toBe(created);
    await expect(readFile(paths.privateKey)).resolves.toStrictEqual(bytes);
    await expect(savedKey(setupDirectory)).resolves.toBe(created);
    await expect(modeOf(paths.directory)).resolves.toBe(0o700);
    await expect(modeOf(paths.privateKey)).resolves.toBe(0o600);
    await expect(
      keyAction(fixture.executable, paths.directory, "generate", paths.privateKey),
    ).rejects.toThrow("Command failed");
    await expect(readFile(paths.privateKey)).resolves.toStrictEqual(bytes);
  });
  test("a gateway without pinned-keys-v1 is refused before any key is written", async () => {
    const setupDirectory = join(fixture.root, "setup");
    await mkdir(setupDirectory, { mode: 0o700 });
    const executable = join(fixture.root, "old-gateway");
    const version = JSON.stringify({
      name: "pi-gateway",
      wireVersions: [2],
      capabilities: [
        "managed-on-demand-v1",
        "setup-lock-v1",
        "config-generation-v1",
        "gateway-control-v1",
        "pairing-v1",
      ],
    });
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, {
      mode: 0o500,
    });
    await expect(ensureKey(executable, setupDirectory)).rejects.toThrow("out of date");
    expect(existsSync(keyPaths(setupDirectory).privateKey)).toBe(false);
  });
});

describe("migrating a certificate-era setup", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let agent: string;
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "agent");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("setup says the link is retired, re-links with keys and keeps the old files", async () => {
    const { paths, folder, pairing } = await retiredSetup(agent, fixture.executable);
    const supplied = {
      backend: { acquire: async () => fixture.executable },
      description: "TEST",
    };
    const activate = vi.fn<ActivatePlan>();

    const shown = dialog([undefined, undefined]);
    await setupCommand(agent, shown, activate, supplied);
    expect(titles(shown)).toContain(RETIRED_NOTICE);
    expect(titles(shown)).toContain("pair-*");
    expect(titles(shown)).toContain("can be deleted");
    const retired = remoteRow(await doctorReport(agent));
    expect(retired?.level).toBe("error");
    expect(retired?.value).toContain("This link uses retired certificates. Link again with keys");

    await setupCommand(agent, dialog([LINK, "APPLY"]), activate, supplied);
    const own = await requiredKey(agent);
    const linked = dialog([LINK, `Peer public key=${PEER_KEY}`, "APPLY"]);
    await setupCommand(agent, linked, activate, supplied);
    expect(linked.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Linked with dev-01"),
      "info",
    );
    expect(activate).toHaveBeenCalledOnce();

    const gateway = decodeGateway(parseJson(await readFile(paths.gateway)));
    expect(gateway.remote).toStrictEqual({
      machineId: "dev-01",
      endpoint: { mode: "connect", address: "100.64.0.2:7443" },
      privateKey: keyPaths(paths.directory).privateKey,
      peerPublicKey: PEER_KEY,
    });
    await expect(readFile(join(folder, "leaf.key"), "utf8")).resolves.toBe("old certificate key");
    await expect(readFile(join(paths.directory, "pairing.json"), "utf8")).resolves.toBe(pairing);
    expect(decodeManaged(parseJson(await readFile(paths.metadata))).pairingSha256).toBe(
      digest(pairing),
    );

    const pinned = remoteRow(await doctorReport(agent));
    expect(pinned?.value).toContain("Trust: pinned");
    expect(pinned?.value).toContain(`This computer's public key: ${own}`);
    await expect(resetLocal(agent)).resolves.toBeDefined();
    expect(existsSync(folder)).toBe(true);
    expect(existsSync(keyPaths(paths.directory).privateKey)).toBe(true);
  });
});

describe("two setups linked by pinned keys on loopback", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let alpha: Profile;
  let beta: Profile;

  async function command(profile: Profile, answers: Array<string>): Promise<void> {
    await setupCommand(
      profile.agent,
      dialog(answers),
      activator(profile),
      {
        backend: { acquire: async () => fixture.executable },
        description: "TEST",
      },
      async (fresh) => {
        await client(profile).reconnect(undefined, fresh);
      },
    );
  }

  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    alpha = { agent: join(fixture.root, "alpha") };
    beta = { agent: join(fixture.root, "beta") };
  });
  afterEach(async () => {
    alpha.client?.close();
    beta.client?.close();
    await nativeUntil(
      async () =>
        !existsSync(setupPaths(alpha.agent).socket) && !existsSync(setupPaths(beta.agent).socket),
      20_000,
    );
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  }, 30_000);

  test("each side enters the other's key and both see each other", async () => {
    const address = await nativeAddress();
    await command(alpha, ["Machine=alpha", "APPLY"]);
    await command(beta, ["Machine=beta", "APPLY"]);
    await command(alpha, [LINK, "APPLY"]);
    await command(beta, [LINK, "APPLY"]);
    const alphaKey = await requiredKey(alpha.agent);
    const betaKey = await requiredKey(beta.agent);
    expect(alphaKey).not.toBe(betaKey);
    await command(alpha, [
      LINK,
      "Peer machine=beta",
      "Connection=Listen for peer",
      `Address=${address}`,
      `Peer public key=${betaKey}`,
      "APPLY",
    ]);
    await command(beta, [
      LINK,
      "Peer machine=alpha",
      "Connection=Connect to peer",
      `Address=${address}`,
      `Peer public key=${alphaKey}`,
      "APPLY",
    ]);
    await nativeUntil(
      async () => hasPeer(await client(alpha).discover(["local"], false), "beta"),
      20_000,
    );
    await nativeUntil(
      async () => hasPeer(await client(beta).discover(["local"], false), "alpha"),
      20_000,
    );
    const remote = decodeGateway(parseJson(await readFile(setupPaths(beta.agent).gateway))).remote;
    expect(remote).toStrictEqual({
      machineId: "alpha",
      endpoint: { mode: "connect", address },
      privateKey: keyPaths(setupPaths(beta.agent).directory).privateKey,
      peerPublicKey: alphaKey,
    });
  }, 90_000);
});
