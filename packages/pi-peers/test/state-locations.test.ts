import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfiguration } from "../adapter/config.js";
import { stateLocations } from "../adapter/locations.js";
import { isWakeNotice, NOTICE_TYPE } from "../adapter/session.js";
import { setupPaths } from "../onboarding/backend.js";
import { doctor } from "../onboarding/doctor.js";

const config = {
  machineId: "alpha",
  socketPath: "/tmp/gateway.sock",
  scopeIds: ["team"],
  label: "label",
  policies: [],
};

describe("saved-state set selection", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();

    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const fixture = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pp-loc-")));
    roots.push(root);
    vi.stubEnv("HOME", root);
    const agent = join(root, "agent");
    await mkdir(agent);

    return { root, agent };
  };

  test("neither: a fresh setup uses the current set", async () => {
    const { root, agent } = await fixture();
    const { active, ignored } = stateLocations(agent);
    expect(active.kind).toBe("current");
    expect(ignored).toBeUndefined();
    const paths = setupPaths(agent);
    expect(paths.adapter).toBe(join(agent, "pi-peers.json"));
    expect(paths.directory).toBe(join(agent, "pi-peers"));
    expect(paths.socket).toBe(join(root, ".pi", "pi-peers", active.id, "s"));
    await expect(loadConfiguration(agent)).resolves.toBeUndefined();
    const report = await doctor(agent);
    expect(report).toContain("State set: current");
    expect(report).not.toContain("legacy");
  });

  test("new only: the current set is used", async () => {
    const { agent } = await fixture();
    await writeFile(join(agent, "pi-peers.json"), JSON.stringify(config));
    expect(stateLocations(agent).active.kind).toBe("current");
    await expect(loadConfiguration(agent)).resolves.toStrictEqual(config);
  });

  test("legacy only: the whole legacy set is used, never mixed", async () => {
    const { root, agent } = await fixture();
    await mkdir(join(agent, "comms"));
    await writeFile(join(agent, "session-communication.json"), JSON.stringify(config));
    const { active, ignored } = stateLocations(agent);
    expect(active.kind).toBe("legacy");
    expect(ignored).toBeUndefined();
    const paths = setupPaths(agent);
    expect(paths.adapter).toBe(join(agent, "session-communication.json"));
    expect(paths.directory).toBe(join(agent, "comms"));
    expect(paths.socket).toBe(join(root, ".pi", "comms", active.id, "s"));
    await expect(loadConfiguration(agent)).resolves.toStrictEqual(config);
    const report = await doctor(agent);
    expect(report).toContain("State set: legacy");
    expect(report).toContain("To migrate");
  });

  test("legacy directory alone still selects the whole legacy set", async () => {
    const { agent } = await fixture();
    await mkdir(join(agent, "comms"));
    expect(setupPaths(agent).adapter).toBe(join(agent, "session-communication.json"));
  });

  test("both present: current wins and doctor warns", async () => {
    const { root, agent } = await fixture();
    await writeFile(join(agent, "session-communication.json"), JSON.stringify(config));
    await mkdir(join(agent, "pi-peers"));
    const { active, ignored } = stateLocations(agent);
    expect(active.kind).toBe("current");
    expect(ignored?.kind).toBe("legacy");
    expect(setupPaths(agent).socket).toBe(join(root, ".pi", "pi-peers", active.id, "s"));
    await expect(loadConfiguration(agent)).resolves.toBeUndefined();
    await expect(doctor(agent)).resolves.toContain("Warning: legacy state");
  });

  test("the default socket stays within the 100-byte bound for a typical home", async () => {
    const { agent } = await fixture();

    const socket = join(
      "/Users/a-typical-user-name",
      ".pi",
      "pi-peers",
      stateLocations(agent).active.id,
      "s",
    );

    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(100);
  });
});

describe("wake notice type", () => {
  test("recognises the new and the legacy message type", () => {
    expect(NOTICE_TYPE).toBe("peers-wake");
    expect(isWakeNotice("peers-wake")).toBe(true);
    expect(isWakeNotice("session-communication-wake")).toBe(true);
    expect(isWakeNotice("other")).toBe(false);
    expect(isWakeNotice(undefined)).toBe(false);
  });
});
