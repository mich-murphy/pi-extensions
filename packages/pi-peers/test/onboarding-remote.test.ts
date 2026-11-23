import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import { decodeConfiguration } from "../adapter/config.js";
import { freshId } from "../adapter/transport.js";
import {
  readManaged,
  reloadManagedLauncher,
  resetLocal,
  setupPaths,
} from "../onboarding/backend.js";
import { diagnoseManaged } from "../onboarding/managed.js";
import { decodeGateway, decodePairing, decodeRecord, parseJson } from "../onboarding/schema.js";
import { setupCommand } from "../onboarding/setup.js";
import {
  dialog,
  nativeAddress,
  nativeFixture,
  nativeUntil,
  nativeIncarnation,
} from "./onboarding-fixtures.js";

type Profile = { agent: string; client?: GatewayClient };
type Pairing = ReturnType<typeof decodePairing>;
const field = (pair: Pairing, key: string): string => {
  const value = pair.output[key];
  if (typeof value !== "string") {
    throw new TypeError(`Missing public ${key}`);
  }
  return value;
};
const client = (profile: Profile): GatewayClient => {
  if (profile.client === undefined) {
    throw new Error("Native fixture was not activated");
  }
  return profile.client;
};
const pairing = async (profile: Profile) =>
  decodePairing(
    parseJson(await readFile(join(setupPaths(profile.agent).directory, "pairing.json"))),
  );
const gateway = async (profile: Profile) =>
  decodeGateway(parseJson(await readFile(setupPaths(profile.agent).gateway)));
async function remoteMaterial(profile: Profile) {
  const value = await gateway(profile);
  if (value.remote === undefined) {
    throw new Error("Remote missing");
  }
  return value.remote;
}
async function floor(profile: Profile): Promise<string> {
  const value = await remoteMaterial(profile);
  return value.revocationState;
}
async function sameEpoch(profiles: Profile[], value: number): Promise<boolean> {
  const epochs = await Promise.all(profiles.map(async (profile) => epoch(profile)));
  return epochs.every((actual) => actual === value);
}
function firstPath(paths: readonly string[]): string {
  const value = paths[0];
  if (value === undefined) {
    throw new Error("Credential path missing");
  }
  return value;
}
async function epoch(profile: Profile): Promise<number> {
  const record = decodeRecord(parseJson(await readFile(await floor(profile))));
  if (!Array.isArray(record.issuers)) {
    throw new TypeError("Floor issuers missing");
  }
  const issuer = decodeRecord(record.issuers[0]);
  if (
    !Array.isArray(issuer.number) ||
    issuer.number.length !== 1 ||
    typeof issuer.number[0] !== "number"
  ) {
    throw new Error("Unexpected fixture CRL epoch");
  }
  return issuer.number[0];
}

async function socketChanged(path: string, previous: string | undefined): Promise<boolean> {
  const current = await nativeIncarnation(path);
  return current !== undefined && current !== previous;
}

function freshPeer(current: ReturnType<typeof peerRefs>, previous: ReturnType<typeof peerRefs>) {
  const peer = current.find(
    (candidate) => !previous.some((old) => old.runtimeNonce === candidate.runtimeNonce),
  );
  if (peer === undefined) {
    throw new Error("Fresh guarded Pi missing");
  }
  return peer;
}

const ISSUER_ACTIONS = "Issuer actions";

describe("guided remote actions with actual native crypto and loopback mTLS", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let profiles: Profile[];
  let creator: Profile;
  let joiner: Profile;
  let address: string;
  async function command(profile: Profile, answers: string[]) {
    await setupCommand(
      profile.agent,
      dialog(answers),
      async (plan, setup) => {
        if (profile.client !== undefined) {
          throw new Error("Maintenance unexpectedly replaced runtime");
        }
        profile.client = new GatewayClient({
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
        await profile.client.reconnect();
      },
      {
        backend: { acquire: async () => fixture.executable },
        description: "Explicit immutable native TEST backend, not production acquisition",
      },
      async (fresh) => {
        await client(profile).reconnect(undefined, fresh);
      },
    );
  }
  async function linked() {
    const cp = await pairing(creator);
    const jp = await pairing(joiner);
    await command(creator, [
      ISSUER_ACTIONS,
      "Issue peer CSR",
      `Request file=${field(jp, "requestPath")}`,
      `Request SHA256=${field(jp, "requestSha256")}`,
      "APPLY",
    ]);
    await command(joiner, [
      "Import public bundle",
      `Bundle file=${field(cp, "bundlePath")}`,
      `Root SHA256=${field(cp, "rootSha256")}`,
      "APPLY",
    ]);
    await nativeUntil(async () => (await epoch(creator)) === 2 && (await epoch(joiner)) === 2);
    await nativeUntil(async () =>
      hasPeer(await client(creator).discover(["local"], false), "join-peer"),
    );
  }
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    profiles = [];
    creator = { agent: join(fixture.root, "creator") };
    joiner = { agent: join(fixture.root, "joiner") };
    profiles.push(creator, joiner);
    address = await nativeAddress();
    await command(creator, [
      "Mode=One remote peer",
      "Trust=Create new pair",
      "Peer machine=join-peer",
      "Connection=Listen for peer",
      `Address=${address}`,
      "APPLY",
    ]);
    const cp = await pairing(creator);
    await command(joiner, [
      "Mode=One remote peer",
      "Trust=Join a pair",
      `Offer file=${field(cp, "offerPath")}`,
      `Root SHA256=${field(cp, "rootSha256")}`,
      "Connection=Connect to peer",
      `Address=${address}`,
      "APPLY",
    ]);
  });
  afterEach(async () => {
    for (const profile of profiles) {
      profile.client?.close();
    }
    await nativeUntil(async () =>
      profiles.every((profile) => !existsSync(setupPaths(profile.agent).socket)),
    );
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });
  test("native diagnostics distinguish configured from degraded credentials without changing live floors", async () => {
    await nativeUntil(async () => (await epoch(creator)) === 1);
    const config = decodeConfiguration(
      parseJson(await readFile(setupPaths(creator.agent).adapter)),
    );
    const setup = await requiredManaged(creator, config);
    const material = await remoteMaterial(creator);
    const path = material.revocationState;
    const before = await readFile(path);
    await expect(diagnoseManaged(setup)).resolves.toContain("Remote config snapshot: configured");
    await rm(firstPath(material.crls));
    await expect(diagnoseManaged(setup)).resolves.toContain("Remote config snapshot: degraded");
    await expect(readFile(path)).resolves.toStrictEqual(before);
    expect(client(creator).status().connected).toBe(true);
  });
  test("issue auto-imports issuer bundle and activates its new CRL without manual creator import", async () => {
    const before = await remoteMaterial(creator);
    await linked();
    const after = await remoteMaterial(creator);
    expect(after.crls).not.toStrictEqual(before.crls);
    await expect(epoch(creator)).resolves.toBe(2);
    await expect(client(joiner).discover(["local"], false)).resolves.toMatchObject({
      outcome: { tag: "ok" },
    });
  });
  test("renew auto-activates issuer and both Pi identities remain unchanged after peer import", async () => {
    await linked();
    const before = peerRefs(await client(creator).discover(["local"], false));
    const cp = await pairing(creator);
    const jp = await pairing(joiner);
    await command(creator, [
      ISSUER_ACTIONS,
      "Renew leaves and CRL",
      `Request file=${field(jp, "requestPath")}`,
      `Request SHA256=${field(jp, "requestSha256")}`,
      "APPLY",
    ]);
    await command(joiner, [
      "Import public bundle",
      `Bundle file=${field(cp, "bundlePath")}`,
      `Root SHA256=${field(cp, "rootSha256")}`,
      "APPLY",
    ]);
    await nativeUntil(async () => sameEpoch([creator, joiner], 3));
    await nativeUntil(async () =>
      hasPeer(await client(creator).discover(["local"], false), "join-peer"),
    );
    expect(peerRefs(await client(creator).discover(["local"], false))).toStrictEqual(before);
  });
  test("revoke auto-imports its CRL, restarts and removes the revoked remote peer", async () => {
    await linked();
    await command(creator, [ISSUER_ACTIONS, "Revoke a leaf", "Machine=join-peer", "APPLY"]);
    await nativeUntil(async () => (await epoch(creator)) === 3);
    await nativeUntil(
      async () => !hasPeer(await client(creator).discover(["local"], false), "join-peer"),
    );
    expect(client(joiner).status().connected).toBe(true);
  });
  test("pending re-pair join removes old trust, keeps local connected and retains old floors", async () => {
    await linked();
    const oldFloor = await floor(joiner);
    const before = await readFile(oldFloor);
    const prior = field(await pairing(creator), "rootSha256");
    await command(creator, [
      "Re-pair with new root",
      "Trust=Create new pair",
      "Peer machine=join-peer",
      "Connection=Listen for peer",
      `Address=${address}`,
      "APPLY",
    ]);
    const cp = await pairing(creator);
    expect(field(cp, "rootSha256")).not.toBe(prior);
    const oldSocket = await nativeIncarnation(setupPaths(joiner.agent).socket);
    expect(oldSocket).toBeDefined();
    await command(joiner, [
      "Re-pair with new root",
      "Trust=Join a pair",
      `Offer file=${field(cp, "offerPath")}`,
      `Root SHA256=${field(cp, "rootSha256")}`,
      "Connection=Connect to peer",
      `Address=${address}`,
      "APPLY",
    ]);
    const pending = await gateway(joiner);
    expect(pending.remote).toBeUndefined();
    await nativeUntil(async () => socketChanged(setupPaths(joiner.agent).socket, oldSocket));
    await nativeUntil(async () => client(joiner).status().connected);
    expect(client(joiner).status().connected).toBe(true);
    await expect(readFile(oldFloor)).resolves.toStrictEqual(before);
    await expect(client(joiner).discover(["local"], false)).resolves.toMatchObject({
      outcome: { tag: "ok" },
    });
  });
  test("re-pair Join targeting another local identity refuses before consent or trust withdrawal", async () => {
    await linked();
    const cp = await pairing(creator);
    const offer = decodeRecord(parseJson(await readFile(field(cp, "offerPath"))));
    const wrong = join(fixture.root, "wrong-target-offer.json");
    await writeFile(wrong, JSON.stringify({ ...offer, peerMachineId: "another-local" }));
    const paths = setupPaths(joiner.agent);
    const owned = [
      paths.adapter,
      paths.metadata,
      paths.gateway,
      join(paths.directory, "pairing.json"),
      await floor(joiner),
    ];
    const before = await Promise.all(owned.map(async (path) => readFile(path)));
    const entries = await readdir(paths.directory);
    const ctx = dialog([
      "Re-pair with new root",
      "Trust=Join a pair",
      `Offer file=${wrong}`,
      `Root SHA256=${field(cp, "rootSha256")}`,
      "Connection=Connect to peer",
      `Address=${address}`,
      "APPLY",
    ]);
    await setupCommand(
      joiner.agent,
      ctx,
      async () => {
        throw new Error("Must not replace runtime");
      },
      undefined,
      async () => client(joiner).reconnect(),
    );
    const offered = vi.mocked(ctx.ui.select).mock.calls.flatMap(([, options]) => options);
    expect(offered).toContain(
      "Re-pair: Invalid: the offer is for another-local, not this computer",
    );
    expect(offered).not.toContain("Re-pair: Ready");
    await expect(Promise.all(owned.map(async (path) => readFile(path)))).resolves.toStrictEqual(
      before,
    );
    await expect(readdir(paths.directory)).resolves.toStrictEqual(entries);
    expect(client(joiner).status().connected).toBe(true);
  });
  test("reset with linked survivor then same-policy fresh root never admits new Pi under old trust", async () => {
    await linked();
    const old = await pairing(creator);
    const oldClient = client(creator);
    const oldRoster = peerRefs(await oldClient.discover(["local"], false));
    await resetLocal(creator.agent);
    const fresh = { agent: creator.agent };
    profiles.push(fresh);
    await command(fresh, [
      "Mode=One remote peer",
      "Trust=Create new pair",
      "Peer machine=join-peer",
      "Connection=Listen for peer",
      `Address=${address}`,
      "APPLY",
    ]);
    const next = await pairing(fresh);
    expect(field(next, "rootSha256")).not.toBe(field(old, "rootSha256"));
    await nativeUntil(
      async () => !hasPeer(await client(fresh).discover(["local"], false), "join-peer"),
    );
    const newRoster = peerRefs(await client(fresh).discover(["local"], false));
    const target = freshPeer(newRoster, oldRoster);
    const sent = await client(joiner).send(target, "local", {
      id: freshId(),
      kind: "update",
      content: "old-root must not reach new Pi",
      format: "text",
    });
    expect(sent).toMatchObject({ tag: "not_admitted", code: "no_route" });
    expect(client(fresh).status().connected).toBe(true);
    oldClient.close();
  });
  test("existing-material staging accepts an existing floor held by the active original gateway", async () => {
    const cp = await pairing(creator);
    const material = await remoteMaterial(creator);
    const path = material.revocationState;
    await nativeUntil(async () => (await epoch(creator)) === 1);
    const before = await readFile(path);
    const external = { agent: join(fixture.root, "existing") };
    profiles.push(external);
    await command(external, [
      "Mode=One remote peer",
      "Trust=Use existing files",
      "Peer machine=join-peer",
      "Connection=Connect to peer",
      `Address=${address}`,
      `Root certificate=${firstPath(material.rootCertificates)}`,
      `Leaf certificate=${firstPath(material.certificateChain)}`,
      `Private key path=${material.privateKey}`,
      `Revocation list=${firstPath(material.crls)}`,
      `Revocation floor file=${path}`,
      "Floor=Existing",
      `Root SHA256=${field(cp, "rootSha256")}`,
      "APPLY",
    ]);
    const actual = await remoteMaterial(external);
    expect(actual.revocationState).toBe(path);
    await expect(readFile(path)).resolves.toStrictEqual(before);
    expect(client(creator).status().connected).toBe(true);
    expect(client(external).status().connected).toBe(true);
  });
});
function peerRefs(reply: Awaited<ReturnType<GatewayClient["discover"]>>) {
  if (reply.outcome.tag !== "ok" || !("peers" in reply.outcome.value)) {
    throw new Error("Native discovery unavailable");
  }
  return reply.outcome.value.peers
    .map((entry) => entry.peer)
    .toSorted((a, b) => a.machineId.localeCompare(b.machineId));
}
function hasPeer(
  reply: Awaited<ReturnType<GatewayClient["discover"]>>,
  machineId: string,
): boolean {
  return peerRefs(reply).some((peer) => peer.machineId === machineId);
}

async function requiredManaged(profile: Profile, config: ReturnType<typeof decodeConfiguration>) {
  const result = await readManaged(profile.agent, config);
  if (result === undefined) {
    throw new Error("Expected owned fixture metadata");
  }
  return result;
}
