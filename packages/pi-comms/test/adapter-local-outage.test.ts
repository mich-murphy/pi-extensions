// LOW-1 regression: local-only tools must not depend on gateway recovery.
// Test double: an owned fake Unix gateway in $TMPDIR (no native binary, provider, profile or PKI).
// It is a protocol fake only; it does not prove native gateway or platform behaviour.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EnsureGateway } from "../adapter/client.js";
import type { Configuration } from "../adapter/config.js";
import { AdapterSession } from "../adapter/session.js";
import { registerTools } from "../adapter/tools.js";
import type { Request } from "../adapter/transport.js";
import type { Frame } from "../protocol/schema.js";
import { decodeFrame, encodeFrame, frameBodyLength } from "../protocol/wire.js";

const peer = {
  machineId: "alpha",
  sessionId: "unit",
  runtimeNonce: "1".repeat(32),
};
const other = {
  machineId: "beta",
  sessionId: "sender",
  runtimeNonce: "2".repeat(32),
};
/** A peer with no configured policy for any scope. */
const stranger = {
  machineId: "gamma",
  sessionId: "reader",
  runtimeNonce: "5".repeat(32),
};
const record = {
  category: "context",
  title: "title",
  summary: "summary",
  format: "text",
  preparation: "authored",
};
const cleanups: (() => Promise<void>)[] = [];

/** Fake gateway double: grants `grants` on register and records every other request. */
function fakeGateway(path: string, grants: readonly string[], log: Request[]) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= frameBodyLength(buffer.subarray(0, 4)) + 4) {
        const total = frameBodyLength(buffer.subarray(0, 4)) + 4;
        const request = decodeFrame(buffer.subarray(0, total), "local-client");
        buffer = Buffer.from(buffer.subarray(total));
        if (request.op === "result" || request.op === "roster.event") {
          continue;
        }
        log.push(request);
        if (request.op === "register") {
          socket.write(
            encodeFrame(
              {
                v: 1,
                op: "result",
                rid: request.rid,
                forOp: "register",
                outcome: {
                  tag: "ok",
                  value: {
                    peer: {
                      ...peer,
                      sessionId: request.sessionId,
                      runtimeNonce: request.runtimeNonce,
                    },
                    scopeIds: [...grants],
                  },
                },
              },
              "adapter-delivery",
            ),
          );
        }
      }
    });
  });
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    listening,
    send: (frame: Frame) => {
      for (const socket of sockets) {
        socket.write(encodeFrame(frame, "adapter-delivery"));
      }
    },
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
/** Runtime guard for untyped seam replies: a non-null object that carries the required `key`. */
function recordWith(value: unknown, key: string, label: string): Record<string, unknown> {
  if (!isRecord(value) || !(key in value)) {
    throw new TypeError(label);
  }
  return value;
}

type Tool = { name: string; execute: unknown };
async function tool(tools: readonly Tool[], name: string, args: unknown) {
  const found = tools.find((item) => item.name === name);
  if (found === undefined || typeof found.execute !== "function") {
    throw new Error(name);
  }
  const result = recordWith(
    await Reflect.apply(found.execute, undefined, ["unit", args, new AbortController().signal]),
    "details",
    "tool result",
  );
  const details = recordWith(result.details, "value", "tool details");
  return { value: details.value, isError: result.isError === true };
}
/** Remote peer read through the real adapter inbound seam (what the gateway would forward). */
function remoteRead(
  session: AdapterSession,
  scopeId: string,
  key: string,
  from: typeof other = other,
): unknown {
  const incoming: unknown = Reflect.get(session, "incoming");
  if (typeof incoming !== "function") {
    throw new TypeError("incoming seam");
  }
  const reply = recordWith(
    Reflect.apply(incoming, session, [
      {
        v: 1,
        op: "state.get",
        rid: "9".repeat(32),
        from,
        publisher: peer,
        scopeId,
        key,
      },
    ]),
    "outcome",
    "reply",
  );
  return reply.outcome;
}

/** `managed: false` builds a manually configured runtime: no ensureGateway hook at all. */
async function setup(grants: readonly string[], managed = true) {
  const directory = await mkdtemp(join(tmpdir(), "pc-outage-"));
  const path = join(directory, "g.sock");
  const log: Request[] = [];
  const state = { server: fakeGateway(path, grants, log) };
  await state.server.listening;
  const config: Configuration = {
    machineId: "alpha",
    socketPath: path,
    scopeIds: ["team", "extra"],
    label: "t",
    policies: [
      {
        machineId: "beta",
        scopeId: "team",
        permissions: ["discover", "read", "push", "interest"],
      },
      { machineId: "beta", scopeId: "extra", permissions: ["read"] },
    ],
  };
  const ensure = vi.fn<EnsureGateway>(async () => ({
    gatewaySha256: "a".repeat(64),
  }));
  const session = new AdapterSession(
    config,
    peer,
    { sendMessage: () => undefined },
    () => undefined,
    () => undefined,
    managed ? ensure : undefined,
  );
  cleanups.push(async () => {
    session.close();
    await state.server.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const tools: Tool[] = [];
  registerTools(
    {
      registerTool: (definition) => {
        tools.push({
          name: definition.name,
          execute: definition.execute.bind(definition),
        });
      },
    },
    () => session,
  );
  await session.start();
  expect(session.client.status().connected).toBe(true);
  const outage = async () => {
    await state.server.stop();
    await vi.waitFor(
      () => {
        expect(session.client.status().connected).toBe(false);
      },
      { timeout: 5000 },
    );
    // Let the single passive post-disconnect episode settle before measuring tool behaviour.
    await vi.waitFor(
      () => {
        expect(session.client.status().operations).toBe(0);
      },
      { timeout: 10_000 },
    );
  };
  const restore = async (next: readonly string[]) => {
    state.server = fakeGateway(path, next, log);
    await state.server.listening;
  };
  return {
    session,
    tools,
    ensure,
    log,
    outage,
    restore,
    server: () => state.server,
  };
}

describe("managed outage: local tools stay available, remote tools stay fail-closed", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });
  test("admitted inbox is taken immediately during outage, once, without ensure or network", async () => {
    const fx = await setup(["team"]);
    fx.server().send({
      v: 1,
      op: "deliver",
      rid: "4".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      message: {
        id: "3".repeat(32),
        kind: "update",
        content: "c",
        format: "text",
      },
    });
    await vi.waitFor(() => {
      expect(fx.session.state.stats().inboxMessages).toBe(1);
    });
    await fx.outage();
    const ensureBefore = fx.ensure.mock.calls.length;
    const requestsBefore = fx.log.length;
    // Causal proof: the take succeeds before any restoration, with no ensure or gateway request.
    const taken = await tool(fx.tools, "session_take", {});
    expect(taken).toMatchObject({
      isError: false,
      value: { messages: [{ message: { id: "3".repeat(32) } }] },
    });
    await expect(tool(fx.tools, "session_take", {})).resolves.toMatchObject({
      value: { messages: [] },
    });
    expect(fx.ensure.mock.calls).toHaveLength(ensureBefore);
    expect(fx.log).toHaveLength(requestsBefore);
  }, 30_000);

  test("own put/remove offline use configured scopes only; exposure still needs current grants", async () => {
    const fx = await setup(["team"]);
    const put = async (scopeId: string, key: string) =>
      tool(fx.tools, "session_state", { action: "put", scopeId, key, record });
    // Connected: gateway did not grant "extra", so mutation there is refused (effective grants).
    await expect(put("extra", "k")).resolves.toMatchObject({
      isError: true,
      value: { code: "unavailable" },
    });
    await fx.outage();
    const ensureBefore = fx.ensure.mock.calls.length;
    const requestsBefore = fx.log.length;
    await expect(put("extra", "k")).resolves.toMatchObject({
      isError: false,
      value: { tag: "ok" },
    });
    await expect(put("team", "t")).resolves.toMatchObject({
      isError: false,
      value: { tag: "ok" },
    });
    // Unconfigured scope stays denied offline.
    await expect(put("zzz", "k")).resolves.toMatchObject({
      value: { tag: "error", code: "forbidden" },
    });
    await expect(
      tool(fx.tools, "session_state", {
        action: "remove",
        scopeId: "zzz",
        key: "k",
      }),
    ).resolves.toMatchObject({ value: { tag: "error", code: "forbidden" } });
    expect(fx.ensure.mock.calls).toHaveLength(ensureBefore);
    expect(fx.log).toHaveLength(requestsBefore);
    // Offline: nothing is remotely readable without current effective grants.
    expect(remoteRead(fx.session, "team", "t")).toMatchObject({
      tag: "error",
      code: "forbidden",
    });
    expect(remoteRead(fx.session, "extra", "k")).toMatchObject({
      tag: "error",
      code: "forbidden",
    });
    // Remote read tool keeps its guarded recovery preflight and fails closed while down.
    await expect(
      tool(fx.tools, "session_state", {
        action: "list",
        publisher: other,
        scopeId: "team",
      }),
    ).resolves.toMatchObject({ isError: true, value: { code: "unavailable" } });
    expect(fx.ensure.mock.calls.length).toBeGreaterThan(ensureBefore);
    // Recovery grants only "team": the offline "extra" publication stays unreadable.
    await fx.restore(["team"]);
    await expect(fx.session.reconnect()).resolves.toBeUndefined();
    expect(remoteRead(fx.session, "extra", "k")).toMatchObject({
      tag: "error",
      code: "forbidden",
    });
    expect(remoteRead(fx.session, "team", "t")).toMatchObject({ tag: "ok" });
    await fx.outage();
    await expect(
      tool(fx.tools, "session_state", {
        action: "remove",
        scopeId: "team",
        key: "t",
      }),
    ).resolves.toMatchObject({
      isError: false,
      value: { tag: "ok", value: { removed: true } },
    });
    // No application or control frame was ever replayed: the gateway saw only registrations.
    expect(fx.log.every((request) => request.op === "register")).toBe(true);
  }, 30_000);

  test("scope denied while connected, written offline, becomes readable only after a later grant", async () => {
    const fx = await setup(["team"]);
    const put = async () =>
      tool(fx.tools, "session_state", {
        action: "put",
        scopeId: "extra",
        key: "k",
        record,
      });
    await expect(put()).resolves.toMatchObject({
      isError: true,
      value: { code: "unavailable" },
    });
    await fx.outage();
    await expect(put()).resolves.toMatchObject({
      isError: false,
      value: { tag: "ok" },
    });
    expect(remoteRead(fx.session, "extra", "k")).toMatchObject({
      tag: "error",
      code: "forbidden",
    });
    // Approved trade-off: a later registration that grants "extra" exposes the offline write to
    // readers the read policy allows, with no further action by the owner.
    await fx.restore(["team", "extra"]);
    await expect(fx.session.reconnect()).resolves.toBeUndefined();
    expect(fx.session.client.effectiveScopes().has("extra")).toBe(true);
    expect(remoteRead(fx.session, "extra", "k")).toMatchObject({
      tag: "ok",
      value: { scopeId: "extra", publication: { key: "k" } },
    });
    // The read policy still applies: a peer without a policy for "extra" stays denied.
    expect(remoteRead(fx.session, "extra", "k", stranger)).toMatchObject({
      tag: "error",
      code: "forbidden",
    });
    expect(fx.log.every((request) => request.op === "register")).toBe(true);
  }, 30_000);

  test("manually configured runtime (no ensureGateway): offline local tools work, peer reads fail closed", async () => {
    const fx = await setup(["team"], false);
    fx.server().send({
      v: 1,
      op: "deliver",
      rid: "6".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      message: {
        id: "7".repeat(32),
        kind: "update",
        content: "c",
        format: "text",
      },
    });
    await vi.waitFor(() => {
      expect(fx.session.state.stats().inboxMessages).toBe(1);
    });
    await fx.outage();
    const requestsBefore = fx.log.length;
    const state = async (args: Record<string, unknown>) => tool(fx.tools, "session_state", args);
    await expect(tool(fx.tools, "session_take", {})).resolves.toMatchObject({
      isError: false,
      value: { messages: [{ message: { id: "7".repeat(32) } }] },
    });
    await expect(tool(fx.tools, "session_take", {})).resolves.toMatchObject({
      value: { messages: [] },
    });
    await expect(
      state({ action: "put", scopeId: "team", key: "t", record }),
    ).resolves.toMatchObject({ isError: false, value: { tag: "ok" } });
    await expect(
      state({ action: "put", scopeId: "extra", key: "k", record }),
    ).resolves.toMatchObject({ isError: false, value: { tag: "ok" } });
    await expect(state({ action: "put", scopeId: "zzz", key: "k", record })).resolves.toMatchObject(
      { value: { tag: "error", code: "forbidden" } },
    );
    await expect(state({ action: "remove", scopeId: "zzz", key: "k" })).resolves.toMatchObject({
      value: { tag: "error", code: "forbidden" },
    });
    expect(remoteRead(fx.session, "team", "t")).toMatchObject({
      tag: "error",
      code: "forbidden",
    });
    expect(remoteRead(fx.session, "extra", "k")).toMatchObject({
      tag: "error",
      code: "forbidden",
    });
    await expect(state({ action: "remove", scopeId: "team", key: "t" })).resolves.toMatchObject({
      isError: false,
      value: { tag: "ok", value: { removed: true } },
    });
    expect(fx.session.state.stats().publications).toBe(1);
    // No ensure hook was ever given or called, and the local tools sent nothing.
    expect(fx.ensure).not.toHaveBeenCalled();
    expect(fx.log).toHaveLength(requestsBefore);
    expect(fx.session.client.status().connected).toBe(false);
  }, 30_000);

  test("closed session fails closed for local tools", async () => {
    const fx = await setup(["team"]);
    fx.session.close();
    await expect(tool(fx.tools, "session_take", {})).resolves.toMatchObject({
      isError: true,
      value: { code: "cancelled" },
    });
    await expect(
      tool(fx.tools, "session_state", {
        action: "put",
        scopeId: "team",
        key: "k",
        record,
      }),
    ).resolves.toMatchObject({ isError: true, value: { code: "cancelled" } });
    expect(fx.session.state.stats().publications).toBe(0);
  });
});
