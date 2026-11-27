import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolArguments } from "../adapter/tools.js";
import { freshId } from "../adapter/transport.js";
import communication from "../index.js";
import type { PeersContext } from "../index.js";
import { setupPaths } from "../onboarding/backend.js";
import type { SetupBackend } from "../onboarding/backend.js";
import { digest } from "../onboarding/files.js";
import { defaultChoices } from "../onboarding/plan.js";
import { decodeGateway, parseJson } from "../onboarding/schema.js";
import { extensionFixture } from "./extension-fixture.js";
import { dialog, nativeUntil, TAILNET, tailscaleFixture } from "./onboarding-fixtures.js";

type TestBackend = {
  backend: SetupBackend;
  description: string;
  tailscale?: string;
  restart?: () => Promise<"acknowledged" | "uncertain">;
};

function extensionHost(testBackend?: TestBackend) {
  const notifications: Array<string> = [];
  const entries: Array<string> = [];
  const answers: Array<string | undefined> = [];
  let idle = true;
  const ui = dialog(answers);

  const context: PeersContext = {
    mode: "rpc",
    hasUI: true,
    signal: undefined,
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => "/work/repo",
      getSessionName: () => undefined,
      getHeader: () => null,
    },
    ui: {
      ...ui.ui,
      notify: (message: string) => {
        notifications.push(message);
      },
      setStatus: () => undefined,
    },
  };

  const sessionId = freshId();

  const fixture = extensionFixture({
    appendEntry: (type) => {
      entries.push(type);
    },
  });

  communication(fixture.api, testBackend);

  return {
    commands: fixture.commands,
    notifications,
    unusedAnswers: () => answers.length,
    entries,
    setIdle: (value: boolean) => {
      idle = value;
    },
    event: async (type: "session_start" | "session_shutdown") =>
      fixture.event(type, { type }, context),
    command: async (args: string, next: Array<string | undefined> = []) => {
      answers.push(...next);
      const start = notifications.length;
      await fixture.command("peers", args, context);

      return notifications.slice(start);
    },
    tool: async (name: string, args: ToolArguments) => {
      const result = await fixture.tools.run(name, args);

      return result.details.value;
    },
  };
}

function identity(messages: Array<string>) {
  const status = messages.find((message) => message.includes("Exact runtime:"));

  const groups = status?.match(
    /machine=(?<machineId>[^ ]+) session=(?<sessionId>[^ ]+) nonce=(?<runtimeNonce>[^\n]+)/u,
  )?.groups;

  if (
    groups?.machineId === undefined ||
    groups.sessionId === undefined ||
    groups.runtimeNonce === undefined
  ) {
    throw new Error("Exact runtime identity unavailable");
  }

  return {
    machineId: groups.machineId,
    sessionId: groups.sessionId,
    runtimeNonce: groups.runtimeNonce,
  };
}

async function connected(host: ReturnType<typeof extensionHost>) {
  await nativeUntil(async () => {
    const messages = await host.command("status");

    return messages.some((message) => message.includes("Connected as"));
  });

  return identity(await host.command("status"));
}

async function localSetup(host: ReturnType<typeof extensionHost>) {
  await host.command("setup", ["Local only — no remote connections (recommended)", "APPLY"]);

  return { peer: await connected(host) };
}

async function relabel(host: ReturnType<typeof extensionHost>) {
  return host.command("setup", ["Label=Relabelled", "APPLY"]);
}

describe("default extension factory native setup/upgrade/reset wiring", () => {
  let fixture: Awaited<ReturnType<typeof tailscaleFixture>>;
  let agent: string;
  let host: ReturnType<typeof extensionHost>;
  beforeEach(async () => {
    fixture = await tailscaleFixture(defaultChoices(hostname()).machineId);
    agent = join(fixture.root, "agent");
    vi.stubEnv("HOME", fixture.root);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    host = extensionHost({
      backend: { acquire: async () => fixture.executable },
      description: "Explicit immutable native TEST fixture",
    });
  });
  afterEach(async () => {
    await host.event("session_shutdown");
    await nativeUntil(async () => !existsSync(setupPaths(agent).socket));
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });
  test("Pi's API-only default-factory invocation stays inert without configuration", async () => {
    const production = extensionHost();
    await production.event("session_start");
    const messages = await production.command("status");
    expect(production.commands.has("peers")).toBe(true);
    expect(production.commands.has("session-communication")).toBe(false);
    expect(messages.join("\n")).toContain("not enabled");
    expect(existsSync(agent)).toBe(false);
    await production.event("session_shutdown");
  });
  test("a reviewed edit replaces THIS idle runtime and loses only its reviewed volatile state", async () => {
    const before = await localSetup(host);
    expect(host.entries).toContain("peers-report");
    await host.command("setup", ["Keep and reconnect"]);
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
    await host.command("setup", ["Link a remote computer", "Back", "Back"]);
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
    const messages = await relabel(host);
    expect(messages.join("\n")).toContain("Settings changed");
    const after = await connected(host);
    expect(after.runtimeNonce).not.toBe(before.peer.runtimeNonce);
    expect(after.machineId).toBe(before.peer.machineId);
    expect(after.sessionId).toBe(before.peer.sessionId);
  });
  test("busy Pi refuses reviewed replacement after staging and retains its original nonce", async () => {
    const before = await localSetup(host);
    host.setIdle(false);
    const messages = await relabel(host);
    expect(messages.join("\n")).toContain("is busy and was not replaced");
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
  });
  test("linking saves the Tailscale endpoint and keeps this runtime until the gateway restarts", async () => {
    const linking = extensionHost({
      backend: { acquire: async () => fixture.executable },
      description: "Explicit immutable native TEST fixture",
      tailscale: fixture.tailscale,
      restart: async () => "uncertain",
    });
    await linking.command("setup", ["Local only — no remote connections (recommended)", "APPLY"]);
    const before = await connected(linking);
    const messages = await linking.command("setup", [
      "Link a remote computer",
      "Connection=Connect to another computer",
      `Other computer=${TAILNET.other}`,
      "APPLY",
    ]);
    expect(messages.join("\n")).toContain("Settings saved but not active yet");
    const gateway = decodeGateway(parseJson(await readFile(setupPaths(agent).gateway)));
    expect(gateway.remote).toStrictEqual({
      endpoint: { mode: "connect", address: `${TAILNET.otherAddress}:7443` },
      tailscale: fixture.tailscale,
    });
    await expect(connected(linking)).resolves.toStrictEqual(before);
    await linking.event("session_shutdown");
  });
  test("reset with nothing configured says so without asking for Apply or writing", async () => {
    const messages = await host.command("reset", ["APPLY"]);
    expect(messages.join("\n")).toContain("Nothing to reset");
    expect(host.unusedAnswers()).toBe(1);
    expect(messages.join("\n")).not.toContain("Reset refused");
    expect(existsSync(setupPaths(agent).directory)).toBe(false);
    const status = await host.command("status");
    expect(status.join("\n")).toContain("not enabled");
  });
  test("reset treats a pi-peers path that is a regular file as nothing to reset", async () => {
    await mkdir(agent, { recursive: true });
    await writeFile(join(agent, "pi-peers"), "not a directory\n");
    const messages = await host.command("reset", ["APPLY"]);
    expect(messages.join("\n")).toContain("Nothing to reset");
  });
  test("a corrupt reset ledger is refused without quoting its content", async () => {
    const before = await localSetup(host);
    await writeFile(
      join(setupPaths(agent).directory, "reset.json"),
      '{"path": /Users/secret-owner/private}',
      { mode: 0o600 },
    );
    const replies = await host.command("reset", ["APPLY"]);
    const messages = replies.join("\n");
    expect(messages).toContain("Reset failed: the record of an earlier reset is damaged");
    expect(messages).toContain("Nothing was turned off");
    expect(messages).not.toContain("secret-owner");
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
  });
  test("reset cancellation keeps current runtime; approved reset disables participation and disposes it", async () => {
    const before = await localSetup(host);
    await host.command("reset", ["Back"]);
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
    const messages = await host.command("reset", ["APPLY"]);
    expect(messages.join("\n")).toContain("Peers turned off");
    expect(existsSync(setupPaths(agent).adapter)).toBe(false);
    await nativeUntil(async () => !existsSync(setupPaths(agent).socket));
    const status = await host.command("status");
    expect(status.join("\n")).toContain("participation disabled");
  });
  test("changed owned configuration makes reset refuse before closing the existing runtime", async () => {
    const before = await localSetup(host);
    const path = setupPaths(agent).adapter;
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
    const messages = await host.command("reset", ["APPLY"]);
    expect(messages.join("\n")).toContain("Reset failed: pi-peers.json was edited by hand");
    expect(messages.join("\n")).toContain("Nothing was turned off");
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
  });
  test("already-disabled interrupted reset failure still truthfully disposes this runtime", async () => {
    await localSetup(host);
    const paths = setupPaths(agent);
    const adapter = await readFile(paths.adapter);
    const backup = `${paths.adapter}.disabled-fixture`;
    await rename(paths.adapter, backup);
    await writeFile(
      join(paths.directory, "reset.json"),
      JSON.stringify([
        { path: paths.adapter, backup, sha256: digest(adapter) },
        {
          path: paths.gateway,
          backup: `${paths.gateway}.disabled-fixture`,
          sha256: "0".repeat(64),
        },
      ]),
      { mode: 0o600 },
    );
    const messages = await host.command("reset", ["APPLY"]);
    expect(messages.join("\n")).toContain("Reset failed: peers is off, but cleanup did not finish");
    expect(existsSync(paths.adapter)).toBe(false);
    await nativeUntil(async () => !existsSync(paths.socket));
    const status = await host.command("status");
    expect(status.join("\n")).toContain("participation disabled");
  });
});
