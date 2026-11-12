import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { freshId } from "../adapter/transport.js";
import communication from "../index.js";
import { setupPaths } from "../onboarding/backend.js";
import type { SetupBackend } from "../onboarding/backend.js";
import { digest } from "../onboarding/files.js";
import { decodeRecord } from "../onboarding/schema.js";
import { dialog, nativeAddress, nativeFixture, nativeUntil } from "./onboarding-fixtures.js";

function extensionHost(testBackend?: { backend: SetupBackend; description: string }) {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, unknown>();
  const notifications: string[] = [];
  const answers: (string | undefined)[] = [];
  let idle = true;
  const ui = dialog(answers);
  const context = {
    mode: "rpc",
    hasUI: true,
    signal: undefined,
    isIdle: () => idle,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      ...ui.ui,
      notify: (message: string) => {
        notifications.push(message);
      },
      setStatus: () => undefined,
    },
  };
  const sessionId = freshId();
  const api = {
    on: (name: string, handler: unknown) => {
      handlers.set(name, handler);
    },
    registerTool: (definition: { name: string; execute: unknown }) => {
      tools.set(definition.name, definition.execute);
    },
    registerCommand: (name: string, definition: { handler: unknown }) => {
      commands.set(name, definition.handler);
    },
    sendMessage: () => undefined,
  };
  Reflect.apply(communication, undefined, testBackend === undefined ? [api] : [api, testBackend]);
  return {
    commands,
    notifications,
    setIdle: (value: boolean) => {
      idle = value;
    },
    event: async (name: string) => invoke(handlers.get(name), [{}, context]),
    command: async (args: string, next: (string | undefined)[] = []) => {
      answers.push(...next);
      const start = notifications.length;
      await invoke(commands.get("comms"), [args, context]);
      return notifications.slice(start);
    },
    tool: async (name: string, args: unknown) => {
      const result = decodeRecord(
        await invoke(tools.get(name), ["fixture", args, undefined, undefined, context]),
      );
      return decodeRecord(decodeRecord(result.details).value);
    },
  };
}
async function invoke(handler: unknown, args: unknown[]): Promise<unknown> {
  if (typeof handler !== "function") {
    throw new TypeError("Unregistered fixture callback");
  }
  const result: unknown = await Reflect.apply(handler, undefined, args);
  return result;
}

function identity(messages: string[]) {
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
    return messages.some((message) => message.includes("enabled · connected"));
  });
  return identity(await host.command("status"));
}
async function localPublication(host: ReturnType<typeof extensionHost>) {
  await host.command("setup", ["Local only — no remote connections (recommended)", "APPLY"]);
  const peer = await connected(host);
  await host.tool("session_state", {
    action: "put",
    scopeId: "local",
    key: "kept",
    record: {
      category: "context",
      title: "Before upgrade",
      summary: "Owned volatile publication",
      content: "retain unless reviewed replacement",
      format: "text",
      preparation: "authored",
    },
  });
  const get = { action: "get", scopeId: "local", key: "kept", publisher: peer };
  return { peer, get, value: await host.tool("session_state", get) };
}
async function upgrade(host: ReturnType<typeof extensionHost>) {
  const address = await nativeAddress();
  return host.command("setup", [
    "Add one remote peer",
    "Create a new trusted pair",
    "upgrade-peer",
    "Listen for peer",
    address,
    "APPLY",
  ]);
}

describe("default extension factory native setup/upgrade/reset wiring", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let agent: string;
  let host: ReturnType<typeof extensionHost>;
  beforeEach(async () => {
    fixture = await nativeFixture();
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
    expect(production.commands.has("comms")).toBe(true);
    expect(production.commands.has("session-communication")).toBe(true);
    expect(messages.join("\n")).toContain("not enabled");
    expect(existsSync(agent)).toBe(false);
    await production.event("session_shutdown");
  });
  test("reviewed local-to-remote upgrade replaces THIS idle runtime and loses only its reviewed volatile state", async () => {
    const before = await localPublication(host);
    await host.command("setup", ["Keep and reconnect"]);
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
    await host.command("setup", ["Add one remote peer", "Cancel"]);
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
    const cancelledAddress = await nativeAddress();
    await host.command("setup", [
      "Add one remote peer",
      "Create a new trusted pair",
      "upgrade-peer",
      "Listen for peer",
      cancelledAddress,
      "Cancel — no changes",
    ]);
    await expect(host.tool("session_state", before.get)).resolves.toStrictEqual(before.value);
    const messages = await upgrade(host);
    expect(messages.join("\n")).toContain("this Pi runtime explicitly replaced");
    const after = await connected(host);
    expect(after.runtimeNonce).not.toBe(before.peer.runtimeNonce);
    expect(after.machineId).toBe(before.peer.machineId);
    expect(after.sessionId).toBe(before.peer.sessionId);
    await expect(
      host.tool("session_state", { ...before.get, publisher: after }),
    ).resolves.toMatchObject({ tag: "error", code: "not_found" });
  });
  test("busy Pi refuses reviewed replacement after staging and retains its original nonce/publication", async () => {
    const before = await localPublication(host);
    host.setIdle(false);
    const messages = await upgrade(host);
    expect(messages.join("\n")).toContain("this Pi is busy and was not replaced");
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
    await expect(host.tool("session_state", before.get)).resolves.toStrictEqual(before.value);
  });
  test("reset cancellation keeps current runtime; approved reset disables participation and disposes it", async () => {
    const before = await localPublication(host);
    await host.command("reset", ["Cancel — no changes"]);
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
    const messages = await host.command("reset", ["APPLY"]);
    expect(messages.join("\n")).toContain("Participation disabled");
    expect(existsSync(setupPaths(agent).adapter)).toBe(false);
    await nativeUntil(async () => !existsSync(setupPaths(agent).socket));
    const status = await host.command("status");
    expect(status.join("\n")).toContain("participation disabled");
  });
  test("changed owned configuration makes reset refuse before closing the existing runtime", async () => {
    const before = await localPublication(host);
    const path = setupPaths(agent).adapter;
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from("\n")]));
    const messages = await host.command("reset", ["APPLY"]);
    expect(messages.join("\n")).toContain("Reset refused before disabling participation");
    await expect(connected(host)).resolves.toStrictEqual(before.peer);
    await expect(host.tool("session_state", before.get)).resolves.toStrictEqual(before.value);
  });
  test("already-disabled interrupted reset failure still truthfully disposes this runtime", async () => {
    await localPublication(host);
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
    expect(messages.join("\n")).toContain("participation is disabled on disk");
    expect(existsSync(paths.adapter)).toBe(false);
    await nativeUntil(async () => !existsSync(paths.socket));
    const status = await host.command("status");
    expect(status.join("\n")).toContain("participation disabled");
  });
});
