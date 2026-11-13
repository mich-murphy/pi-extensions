import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import type { EnsureGateway } from "../adapter/client.js";
import type { Configuration } from "../adapter/config.js";
import { createAdapterRuntime } from "../adapter/runtime.js";
import { AdapterSession, NOTICE_TYPE } from "../adapter/session.js";
import { registerTools } from "../adapter/tools.js";
import { connectTransport } from "../adapter/transport.js";
import sessionCommunication from "../index.js";
import type { Frame, Message } from "../protocol/schema.js";
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
const cleanups: (() => Promise<void>)[] = [];
type Reply = Extract<Frame, { op: "result" }>;
type Request = Exclude<Frame, { op: "result" | "roster.event" }>;
async function gateway(
  handler: (request: Request, socket: Socket) => Reply | undefined,
  holdRegistration = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "psc-"));
  const sockets = new Set<Socket>();
  let connections = 0;
  const requests: Request[] = [];
  const replies: Reply[] = [];
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= frameBodyLength(buffer.subarray(0, 4)) + 4) {
        const total = frameBodyLength(buffer.subarray(0, 4)) + 4;
        const request = decodeFrame(buffer.subarray(0, total), "local-client");
        buffer = Buffer.from(buffer.subarray(total));
        if (request.op === "result") {
          replies.push(request);
          continue;
        }
        if (request.op === "roster.event") {
          continue;
        }
        requests.push(request);
        let reply: Reply | undefined;
        if (request.op === "register" && !holdRegistration) {
          reply = {
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
                scopeIds: request.scopeIds,
              },
            },
          };
        } else {
          reply = handler(request, socket);
        }
        if (reply !== undefined) {
          socket.write(encodeFrame(reply, "adapter-delivery"));
        }
      }
    });
  });
  const socketPath = join(directory, "gateway.sock");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await rm(directory, { recursive: true, force: true });
  });
  const config: Configuration = {
    machineId: "alpha",
    socketPath,
    scopeIds: ["team"],
    label: "test",
    policies: [
      {
        machineId: "beta",
        scopeId: "team",
        permissions: ["discover", "read", "push", "interest"],
      },
    ],
  };
  return {
    config,
    connections: () => connections,
    requests,
    replies,
    raw: (bytes: Buffer) => {
      const socket = [...sockets][0];
      assert(socket);
      socket.write(bytes);
    },
    sendFrame: (frame: Frame) => {
      const socket = [...sockets][0];
      assert(socket);
      socket.write(encodeFrame(frame, "adapter-delivery"));
    },
  };
}
function authored(id = "3".repeat(32)): Message {
  return {
    id,
    kind: "update",
    content: "bounded authored content",
    format: "text",
  };
}
function binding(message: Message) {
  return {
    messageId: message.id,
    sender: peer,
    recipient: other,
    scopeId: "team",
  };
}

function lostThenDenied() {
  let sends = 0;
  return (request: Request, socket: Socket): Reply | undefined => {
    if (request.op !== "send") {
      return undefined;
    }
    sends += 1;
    if (sends === 1) {
      socket.destroy();
      return undefined;
    }
    return {
      v: 1,
      op: "result",
      rid: request.rid,
      forOp: "send",
      outcome: {
        tag: "not_admitted",
        binding: binding(request.message),
        code: "forbidden",
      },
    };
  };
}
function misbound(request: Request): Reply | undefined {
  if (request.op !== "send") {
    return undefined;
  }
  return {
    v: 1,
    op: "result",
    rid: request.rid,
    forOp: "send",
    outcome: {
      tag: "admitted",
      binding: { ...binding(request.message), messageId: "f".repeat(32) },
      correlation: "none",
    },
  };
}
function discoveryReply(request: Request): Reply | undefined {
  if (request.op !== "discover") {
    return undefined;
  }
  return {
    v: 1,
    op: "result",
    rid: request.rid,
    forOp: "discover",
    outcome: {
      tag: "ok",
      value: {
        peers: [{ peer: other, label: "other", scopeIds: request.scopeIds }],
        watching: request.watch,
      },
    },
  };
}
function releaseRegistration(fixture: Awaited<ReturnType<typeof gateway>>): void {
  const request = fixture.requests.find((item) => item.op === "register");
  assert(request?.op === "register");
  fixture.sendFrame({
    v: 1,
    op: "result",
    rid: request.rid,
    forOp: "register",
    outcome: { tag: "ok", value: { peer, scopeIds: ["team"] } },
  });
}
async function resultOf<A>(promise: Promise<A>): Promise<A | string> {
  try {
    return await promise;
  } catch (error) {
    return error instanceof Error ? error.message : "failure";
  }
}
function makeClient(config: Configuration): GatewayClient {
  return new GatewayClient({
    config,
    peer,
    incoming: () => {
      throw new Error("Unexpected inbound");
    },
    statusChanged: () => undefined,
  });
}

function missingPublication(request: Request): Reply | undefined {
  if (request.op !== "state.get") {
    return undefined;
  }
  return {
    v: 1,
    op: "result",
    rid: request.rid,
    forOp: "state.get",
    outcome: { tag: "error", code: "not_found" },
  };
}

function toolGateway(request: Request): Reply | undefined {
  if (request.op === "send") {
    return {
      v: 1,
      op: "result",
      rid: request.rid,
      forOp: "send",
      outcome: {
        tag: "admitted",
        binding: binding(request.message),
        correlation: "none",
      },
    };
  }
  if (request.op === "state.get") {
    return {
      v: 1,
      op: "result",
      rid: request.rid,
      forOp: "state.get",
      outcome: { tag: "error", code: "not_found" },
    };
  }
  if (request.op === "state.list") {
    return {
      v: 1,
      op: "result",
      rid: request.rid,
      forOp: "state.list",
      outcome: {
        tag: "ok",
        value: {
          publisher: request.publisher,
          scopeId: request.scopeId,
          revision: 0,
          items: [],
        },
      },
    };
  }
  if (request.op === "interest.add") {
    return {
      v: 1,
      op: "result",
      rid: request.rid,
      forOp: "interest.add",
      outcome: { tag: "error", code: "not_found" },
    };
  }
  if (request.op === "interest.remove") {
    return {
      v: 1,
      op: "result",
      rid: request.rid,
      forOp: "interest.remove",
      outcome: {
        tag: "ok",
        value: {
          publisher: request.publisher,
          scopeId: request.scopeId,
          work: request.work,
          active: false,
        },
      },
    };
  }
  return discoveryReply(request);
}
type CapturedTool = { name: string; execute: unknown };
async function executeTool(
  tools: readonly CapturedTool[],
  name: string,
  args: unknown,
): Promise<unknown> {
  const definition = tools.find((tool) => tool.name === name);
  assert(definition);
  // Public registration seam; these handlers do not read the optional host execution context.
  const action = definition.execute;
  assert(typeof action === "function");
  const result: unknown = await Reflect.apply(action, undefined, [
    "unit",
    args,
    new AbortController().signal,
  ]);
  assert(typeof result === "object" && result !== null && "details" in result);
  const details: unknown = result.details;
  assert(typeof details === "object" && details !== null && "value" in details);
  return details.value;
}

function restoreAgentDir(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previous;
  }
}
function replyToReport(
  fixture: Awaited<ReturnType<typeof gateway>>,
  request: Extract<Request, { op: "send" }>,
  denied: boolean,
): void {
  const receipt = {
    messageId: request.message.id,
    sender: peer,
    recipient: request.to,
    scopeId: request.scopeId,
  };
  const outcome = denied
    ? {
        tag: "not_admitted" as const,
        binding: receipt,
        code: "forbidden" as const,
      }
    : {
        tag: "admitted" as const,
        binding: receipt,
        correlation: "none" as const,
      };
  fixture.sendFrame({
    v: 1,
    op: "result",
    rid: request.rid,
    forOp: "send",
    outcome,
  });
}
function extensionHost() {
  const handlers = new Map<string, unknown>();
  const commands = new Map<
    string,
    { handler: unknown; getArgumentCompletions?: (prefix: string) => unknown }
  >();
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  const context = {
    mode: "rpc",
    hasUI: true,
    sessionManager: { getSessionId: () => peer.sessionId },
    isIdle: () => true,
    ui: {
      select: async () => undefined,
      notify: (text: string) => {
        notifications.push(text);
      },
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text);
      },
    },
  };
  Reflect.apply(sessionCommunication, undefined, [
    {
      on: (name: string, handler: unknown) => {
        handlers.set(name, handler);
      },
      registerTool: () => undefined,
      registerCommand: (
        name: string,
        definition: {
          handler: unknown;
          getArgumentCompletions?: (prefix: string) => unknown;
        },
      ) => {
        commands.set(name, definition);
      },
      sendMessage: () => undefined,
    },
  ]);
  return {
    notifications,
    statuses,
    commands,
    event: async (name: string, event: unknown = {}) => {
      const handler = handlers.get(name);
      assert(typeof handler === "function");
      const result: unknown = await Reflect.apply(handler, undefined, [event, context]);
      return result;
    },
    command: async (args: string, name = "session-communication") => {
      const command = commands.get(name)?.handler;
      assert(typeof command === "function");
      const result: unknown = await Reflect.apply(command, undefined, [args, context]);
      return result;
    },
  };
}

function malformedEnsure(value: unknown): EnsureGateway {
  // Explicit JS/old-plugin seam: TS typing must not turn malformed results into legacy admission.
  const ensure = vi.fn<EnsureGateway>();
  const resolve: unknown = Reflect.get(ensure, "mockResolvedValue");
  assert(typeof resolve === "function");
  Reflect.apply(resolve, ensure, [value]);
  return ensure;
}
function registerHash(request: Request) {
  assert.equal(request.op, "register");
  if (request.op !== "register") {
    throw new Error("Expected register");
  }
  return request.expectedConfigSha256;
}
function mismatchReply(request: Request): Reply {
  assert.equal(request.op, "register");
  return {
    v: 1,
    op: "result",
    rid: request.rid,
    forOp: "register",
    outcome: { tag: "error", code: "config_mismatch" },
  };
}
function generationReply(request: Request): Reply {
  if (request.op !== "register") {
    throw new Error("Expected register");
  }
  return request.expectedConfigSha256 === "a".repeat(64)
    ? mismatchReply(request)
    : {
        v: 1,
        op: "result",
        rid: request.rid,
        forOp: "register",
        outcome: { tag: "ok", value: { peer, scopeIds: request.scopeIds } },
      };
}
function olderGatewayClose(request: Request, socket: Socket) {
  assert.equal(request.op, "register");
  assert.equal(registerHash(request), "a".repeat(64));
  socket.destroy();
  return undefined;
}
function generationEnsure(hashes: string[]) {
  return vi.fn<NonNullable<ConstructorParameters<typeof GatewayClient>[0]["ensureGateway"]>>(
    async () => ({ gatewaySha256: hashes.shift() ?? "a".repeat(64) }),
  );
}

async function expectFailure(pending: Promise<unknown>, message: string): Promise<void> {
  await expect(pending).rejects.toThrow(message);
}
async function expectPossibleFailure(pending: Promise<unknown>): Promise<void> {
  await expect(pending).rejects.toMatchObject({ possible: true });
}
function holdRegister(
  first: () => void,
  second: (value: { request: Request; socket: Socket }) => void,
) {
  return (request: Request, socket: Socket): undefined => {
    if (registerHash(request) === "a".repeat(64)) {
      first();
    } else {
      second({ request, socket });
    }
    return undefined;
  };
}
function signalDiscover(received: () => void) {
  return (request: Request): undefined => {
    if (request.op === "discover") {
      received();
    }
    return undefined;
  };
}

describe("public adapter transport and notice accounting", () => {
  afterEach(async () => {
    for (const close of cleanups.splice(0).toReversed()) {
      await close();
    }
  });
  test.each([
    undefined,
    null,
    {},
    { gatewaySha256: undefined },
    { gatewaySha256: "A".repeat(64) },
    { gatewaySha256: "a".repeat(63) },
    { gatewaySha256: 123 },
  ])(
    "a supplied ensure returning malformed snapshot %j fails before any connection or register",
    async (value) => {
      const fixture = await gateway(() => undefined);
      const client = new GatewayClient({
        config: fixture.config,
        peer,
        ensureGateway: malformedEnsure(value),
        incoming: () => {
          throw new Error("Unexpected request");
        },
        statusChanged: () => undefined,
      });
      try {
        await expect(client.reconnect()).rejects.toThrow("protocol_error");
        expect(fixture.connections()).toBe(0);
        expect(fixture.requests).toHaveLength(0);
        expect(client.status()).toMatchObject({
          connected: false,
          status: "activation_unconfirmed",
          scopes: [],
        });
      } finally {
        client.close();
      }
    },
  );
  test("reviewed-control fresh reconnect cannot return the still-open old registration and coalesces callers", async () => {
    const fixture = await gateway(() => undefined);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<{ gatewaySha256: string }>();
    const ensureGateway = vi
      .fn<EnsureGateway>()
      .mockResolvedValueOnce({ gatewaySha256: "a".repeat(64) })
      .mockImplementation(async () => {
        entered.resolve(undefined);
        return release.promise;
      });
    const session = new AdapterSession(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => undefined,
      () => undefined,
      ensureGateway,
    );
    try {
      await session.reconnect();
      const state = session.state;
      expect(session.status().connected).toBe(true);
      // Models ACK before the old server delivers any disconnect. It never closes it itself.
      let completed = false;
      const fresh = session.reconnect(true).then(() => {
        completed = true;
        return undefined;
      });
      await entered.promise;
      const concurrent = [session.reconnect(), session.reconnect(), session.reconnect()];
      expect(completed).toBe(false);
      expect(session.status()).toMatchObject({ connected: false, scopes: [] });
      expect(fixture.requests).toHaveLength(1);
      release.resolve({ gatewaySha256: "b".repeat(64) });
      await Promise.all([fresh, ...concurrent]);
      expect(ensureGateway).toHaveBeenCalledTimes(2);
      expect(fixture.connections()).toBe(2);
      expect(fixture.requests.map(registerHash)).toStrictEqual(["a".repeat(64), "b".repeat(64)]);
      expect(fixture.requests).toStrictEqual([
        expect.objectContaining({ runtimeNonce: peer.runtimeNonce, sessionId: peer.sessionId }),
        expect.objectContaining({ runtimeNonce: peer.runtimeNonce, sessionId: peer.sessionId }),
      ]);
      expect(session.state).toBe(state);
      // Passive/control-free repair retains the healthy registration.
      await session.reconnect();
      expect(ensureGateway).toHaveBeenCalledTimes(2);
    } finally {
      session.close();
    }
  });
  test("a second explicit fresh boundary cancels the first fresh episode and requires its newer metadata", async () => {
    const fixture = await gateway(() => undefined);
    const firstFresh = Promise.withResolvers<{ gatewaySha256: string }>();
    const secondFresh = Promise.withResolvers<{ gatewaySha256: string }>();
    const entered = Promise.withResolvers<undefined>();
    const ensureGateway = vi
      .fn<EnsureGateway>()
      .mockResolvedValueOnce({ gatewaySha256: "a".repeat(64) })
      .mockImplementationOnce(async () => firstFresh.promise)
      .mockImplementation(async () => {
        entered.resolve(undefined);
        return secondFresh.promise;
      });
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => undefined,
    });
    try {
      await client.reconnect();
      const superseded = expectFailure(client.reconnect(undefined, true), "cancelled");
      // A second separately reviewed control changes saved metadata again.
      let completed = false;
      const latest = client.reconnect(undefined, true).then(() => {
        completed = true;
        return undefined;
      });
      await entered.promise;
      await superseded;
      firstFresh.resolve({ gatewaySha256: "b".repeat(64) });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(completed).toBe(false);
      expect(client.status()).toMatchObject({ connected: false, scopes: [] });
      expect(fixture.requests.map(registerHash)).toStrictEqual(["a".repeat(64)]);
      const passive = client.reconnect();
      secondFresh.resolve({ gatewaySha256: "c".repeat(64) });
      await Promise.all([latest, passive]);
      expect(fixture.requests.map(registerHash)).toStrictEqual(["a".repeat(64), "c".repeat(64)]);
      expect(ensureGateway).toHaveBeenCalledTimes(3);
      expect(client.status().connected).toBe(true);
    } finally {
      client.close();
    }
  });
  test("fresh registration mismatch stays pending after exactly six guarded attempts, never old success", async () => {
    const reply = vi
      .fn<(request: Request) => Reply | undefined>()
      .mockImplementationOnce(generationReply)
      .mockImplementation(mismatchReply);
    const fixture = await gateway(reply, true);
    const ensureGateway = generationEnsure([
      "b".repeat(64),
      ...Array.from({ length: 6 }, () => "a".repeat(64)),
    ]);
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => undefined,
    });
    try {
      await client.reconnect();
      await expect(client.reconnect(undefined, true)).rejects.toThrow("unavailable");
      expect(ensureGateway).toHaveBeenCalledTimes(7);
      expect(fixture.requests.map(registerHash)).toStrictEqual([
        "b".repeat(64),
        ...Array.from({ length: 6 }, () => "a".repeat(64)),
      ]);
      expect(client.status()).toMatchObject({
        connected: false,
        scopes: [],
        status: "activation_pending",
      });
    } finally {
      client.close();
    }
  });
  test("fresh reconnect fences an in-flight ensure and its stale finally cannot clear the new attempt", async () => {
    const fixture = await gateway(() => undefined);
    const old = Promise.withResolvers<{ gatewaySha256: string }>();
    const next = Promise.withResolvers<{ gatewaySha256: string }>();
    const entered = Promise.withResolvers<undefined>();
    const ensureGateway = vi
      .fn<EnsureGateway>()
      .mockImplementationOnce(async () => old.promise)
      .mockImplementation(async () => {
        entered.resolve(undefined);
        return next.promise;
      });
    const statusChanged = vi.fn<() => void>();
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged,
    });
    try {
      const prior = expectFailure(client.reconnect(), "cancelled");
      const fresh = client.reconnect(undefined, true);
      await entered.promise;
      await prior;
      // This ensure deliberately ignores its aborted signal and fails late.
      old.reject(new Error("stale metadata failure"));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(statusChanged).toHaveBeenCalledTimes(1); // only the explicit fence
      const tool = client.request({
        v: 1,
        op: "discover",
        rid: "f".repeat(32),
        scopeIds: ["team"],
        watch: false,
      });
      // The fake server leaves discover pending; only its connection preflight is relevant.
      const toolResult = expectFailure(tool, "cancelled");
      next.resolve({ gatewaySha256: "b".repeat(64) });
      await fresh;
      expect(ensureGateway).toHaveBeenCalledTimes(2);
      expect(
        fixture.requests
          .filter((request) => request.op === "register")
          .map((request) => registerHash(request)),
      ).toStrictEqual(["b".repeat(64)]);
      client.close();
      await toolResult;
      expect(client.status().connected).toBe(false);
    } finally {
      client.close();
    }
  });
  test("fresh reconnect cancels a pending register and stale disconnect/finally cannot disturb its successor", async () => {
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<{ request: Request; socket: Socket }>();
    const fixture = await gateway(
      holdRegister(() => {
        first.resolve(undefined);
      }, second.resolve),
      true,
    );
    const ensureGateway = generationEnsure(["a".repeat(64), "b".repeat(64)]);
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => undefined,
    });
    try {
      const prior = expectFailure(client.reconnect(), "cancelled");
      await first.promise;
      const fresh = client.reconnect(undefined, true);
      const registration = await second.promise;
      await prior;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const concurrent = client.reconnect();
      expect(client.status()).toMatchObject({ connected: false, scopes: [] });
      const reply = generationReply(registration.request);
      assert.notEqual(reply, undefined);
      registration.socket.write(encodeFrame(reply, "adapter-delivery"));
      await Promise.all([fresh, concurrent]);
      expect(client.status()).toMatchObject({ connected: true, scopes: ["team"] });
      expect(ensureGateway).toHaveBeenCalledTimes(2);
      expect(fixture.requests.map(registerHash)).toStrictEqual(["a".repeat(64), "b".repeat(64)]);
    } finally {
      client.close();
    }
  });
  test.each([true, false])(
    "old discover failure (watch=%s) cannot clear a new generation's watch/cache",
    async (watch) => {
      const entered = Promise.withResolvers<undefined>();
      const handler = vi
        .fn<(request: Request) => Reply | undefined>()
        .mockImplementationOnce(() => {
          entered.resolve(undefined);
          return undefined;
        })
        .mockImplementation(discoveryReply);
      const fixture = await gateway(handler);
      const ensureGateway = generationEnsure(["a".repeat(64), "b".repeat(64)]);
      const client = new GatewayClient({
        config: fixture.config,
        peer,
        ensureGateway,
        incoming: () => {
          throw new Error("Unexpected request");
        },
        statusChanged: () => undefined,
      });
      try {
        await client.reconnect();
        const old = expectFailure(client.discover(["team"], watch), "cancelled");
        await entered.promise;
        const fresh = client.reconnect(undefined, true);
        // Install synchronously before the old request's rejection continuation runs.
        const latest = client.discover(["team"], true);
        await old;
        await fresh;
        await expect(latest).resolves.toMatchObject({
          outcome: { tag: "ok", value: { peers: [{ peer: other }], watching: true } },
        });
        expect(client.status().watching).toBe(true);
        const requests = fixture.requests.length;
        await expect(client.discover(["team"], true)).resolves.toMatchObject({
          outcome: { tag: "ok", value: { peers: [{ peer: other }], watching: true } },
        });
        expect(fixture.requests).toHaveLength(requests); // new watch/cache survived, no extra discovery
        expect(ensureGateway).toHaveBeenCalledTimes(2);
      } finally {
        client.close();
      }
    },
  );
  test("lifetime close fences a late successful ensure before any socket or status publication", async () => {
    const fixture = await gateway(() => undefined);
    const pending = Promise.withResolvers<{ gatewaySha256: string }>();
    const ensureGateway = vi.fn<EnsureGateway>(async () => pending.promise);
    const statusChanged = vi.fn<() => void>();
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged,
    });
    const result = expectFailure(client.reconnect(), "cancelled");
    client.close();
    const notifications = statusChanged.mock.calls.length;
    pending.resolve({ gatewaySha256: "a".repeat(64) });
    await result;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(fixture.connections()).toBe(0);
    expect(fixture.requests).toHaveLength(0);
    expect(statusChanged).toHaveBeenCalledTimes(notifications);
    expect(client.status()).toMatchObject({ connected: false, scopes: [] });
  });
  test("fresh metadata refusal disconnects old trust and does not replay uncertain application work", async () => {
    const received = Promise.withResolvers<undefined>();
    const fixture = await gateway(
      signalDiscover(() => {
        received.resolve(undefined);
      }),
    );
    const ensureGateway = vi
      .fn<EnsureGateway>()
      .mockResolvedValue({ gatewaySha256: "a".repeat(64) });
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => undefined,
    });
    try {
      await client.reconnect();
      const work = expectPossibleFailure(
        client.request({
          v: 1,
          op: "discover",
          rid: "e".repeat(32),
          scopeIds: ["team"],
          watch: false,
        }),
      );
      await received.promise;
      ensureGateway.mockRejectedValue(new Error("narrowed grants incompatible"));
      await expect(client.reconnect(undefined, true)).rejects.toThrow(
        "narrowed grants incompatible",
      );
      await work;
      expect(client.status()).toMatchObject({
        connected: false,
        scopes: [],
        status: "activation_unconfirmed",
      });
      expect(fixture.requests.map((request) => request.op)).toStrictEqual(["register", "discover"]);
      expect(ensureGateway).toHaveBeenCalledTimes(2);
    } finally {
      client.close();
    }
  });
  test("manual registration omits a generation fingerprint", async () => {
    const fixture = await gateway(() => undefined);
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => undefined,
    });
    try {
      await client.reconnect();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).not.toHaveProperty("expectedConfigSha256");
    } finally {
      client.close();
    }
  });
  test("each bounded connection attempt uses only its own ensure snapshot hash", async () => {
    const hashes = ["a".repeat(64), "b".repeat(64)];
    const fixture = await gateway(generationReply, true);
    const ensureGateway = generationEnsure(hashes);
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => undefined,
    });
    try {
      await client.reconnect();
      expect(ensureGateway).toHaveBeenCalledTimes(2);
      expect(fixture.requests.map(registerHash)).toStrictEqual(["a".repeat(64), "b".repeat(64)]);
      expect(client.status()).toMatchObject({
        connected: true,
        status: "connected",
        scopes: ["team"],
      });
    } finally {
      client.close();
    }
  });
  test("generation mismatch exhausts one bounded episode with distinct pending status and no control replay", async () => {
    const fixture = await gateway(mismatchReply, true);
    const ensureGateway = generationEnsure(["a".repeat(64)]);
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => undefined,
    });
    try {
      await expect(client.reconnect()).rejects.toThrow("unavailable");
      expect(ensureGateway).toHaveBeenCalledTimes(6);
      expect(fixture.requests.map((request) => request.op)).toStrictEqual(
        Array.from({ length: 6 }, () => "register"),
      );
      expect(client.status()).toMatchObject({
        connected: false,
        status: "activation_pending",
        scopes: [],
      });
    } finally {
      client.close();
    }
  });
  test("an older gateway closing guarded register never triggers unguarded fallback or passive control", async () => {
    const fixture = await gateway(olderGatewayClose, true);
    const ensureGateway = generationEnsure(["a".repeat(64)]);
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => undefined,
    });
    try {
      await expect(client.reconnect()).rejects.toThrow("unavailable");
      expect(ensureGateway).toHaveBeenCalledTimes(6);
      expect(fixture.requests.map(registerHash)).toStrictEqual(
        Array.from({ length: 6 }, () => "a".repeat(64)),
      );
      expect(client.status()).toMatchObject({
        connected: false,
        status: "activation_unconfirmed",
        scopes: [],
      });
    } finally {
      client.close();
    }
  });
  test("public extension registration is inert without config, reports failures, and disposes enabled lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "psc-extension-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const host = extensionHost();
    cleanups.push(async () => {
      await host.event("session_shutdown");
      restoreAgentDir(previous);
      await rm(directory, { recursive: true, force: true });
    });
    await host.event("session_start");
    expect(host.notifications).toStrictEqual([]);
    expect([...host.commands.keys()]).toStrictEqual(["comms", "session-communication"]);
    expect(host.commands.get("comms")?.getArgumentCompletions?.("re")).toStrictEqual([
      { value: "reconnect", label: "reconnect" },
      { value: "reset", label: "reset" },
    ]);
    await host.command("");
    expect(host.notifications.at(-1)).toContain("not enabled");
    const legacyStatus = host.notifications.at(-1);
    await host.command("status", "comms");
    expect(host.notifications.at(-1)).toBe(legacyStatus);
    await host.command("doctor", "comms");
    expect(host.notifications.at(-1)).toContain(directory);
    expect(host.notifications.at(-1)).toContain("new sessions will not enable participation");
    await host.command("setup", "comms");
    expect(host.notifications.at(-1)).toContain("Cancelled");
    await host.command("status extra", "comms");
    expect(host.notifications.at(-1)).toContain("Usage: /comms");
    await host.command("invalid");
    expect(host.notifications.at(-1)).toContain("Usage:");
    await host.command("reconnect");
    await host.event("message_end", { message: { role: "custom" } });
    await host.event("agent_before_settle", { entries: [] });
    await host.event("agent_settled");
    await host.event("session_compact");
    await host.event("session_compact_failed", { aborted: true });
    await host.event("session_shutdown");
    await writeFile(join(directory, "session-communication.json"), "invalid");
    await host.event("session_start");
    expect(host.statuses.at(-1)).toContain("configuration/startup failed");
    await host.command("doctor", "comms");
    expect(host.notifications.at(-1)).toContain("invalid JSON");
    expect(host.notifications.at(-1)).toContain(directory);
    await host.command("status");
    expect(host.notifications.at(-1)).toContain("Check <agent dir>/session-communication.json");
    expect(host.notifications.at(-1)).toContain("then /comms reconnect");
    await writeFile(
      join(directory, "session-communication.json"),
      JSON.stringify({
        machineId: "alpha",
        socketPath: join(directory, "down"),
        scopeIds: ["team"],
        label: "Pi",
        policies: [],
      }),
    );
    await host.event("session_start");
    await host.command("doctor", "comms");
    expect(host.notifications.at(-1)).toContain("Configuration: valid");
    expect(host.notifications.at(-1)).toContain("absent or inaccessible");
    expect(host.notifications.at(-1)).not.toContain("connected ·");
    await host.event("session_shutdown");
    const fixture = await gateway(discoveryReply);
    await writeFile(join(directory, "session-communication.json"), JSON.stringify(fixture.config));
    await host.event("session_start");
    await expect.poll(() => fixture.requests.length).toBe(1);
    await host.command("reconnect", "comms");
    expect(host.notifications.at(-1)).toContain("Session communication: enabled");
    await rm(join(directory, "session-communication.json"));
    await host.command("doctor", "comms");
    expect(host.notifications.at(-1)).toContain("missing on disk");
    expect(host.notifications.at(-1)).toContain("existing runtime may still be active");
    expect(host.notifications.at(-1)).toContain("Session communication: enabled");
    expect(host.notifications.at(-1)).not.toContain("participation is off");
    expect(host.statuses.at(-1)).toBeUndefined();
    await host.event("message_end", { message: { role: "custom" } });
    await host.event("agent_before_settle", { entries: [] });
    await host.event("agent_settled");
    await host.event("session_compact");
    await host.event("session_compact_failed", { aborted: true });
    await host.event("session_shutdown");
    await host.event("session_shutdown");
    await host.command("status");
    expect(host.notifications.at(-1)).toBe(
      "Session communication: not enabled · runtime unavailable\nRemote config snapshot: missing disk configuration; any old runtime may still be active.",
    );
    expect(host.notifications.at(-1)).not.toContain("Session communication: enabled");
  });
  test("public tools share the scoped runtime and reserve report fanout before publication", async () => {
    const fixture = await gateway(toolGateway);
    const current: { session?: AdapterSession } = {};
    const tools: CapturedTool[] = [];
    registerTools(
      {
        registerTool: (definition) => {
          tools.push({
            name: definition.name,
            execute: definition.execute.bind(definition),
          });
        },
      },
      () => current.session,
    );
    await expect(executeTool(tools, "session_take", {})).resolves.toMatchObject({
      tag: "error",
      code: "unavailable",
    });
    const owned = await createAdapterRuntime(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => ({ isIdle: () => true, ui: { setStatus: () => undefined } }),
    );
    cleanups.push(async () => {
      await owned.dispose();
    });
    current.session = owned.session;
    await expect.poll(() => owned.session.client.status().connected).toBe(true);
    await expect(executeTool(tools, "session_peers", {})).resolves.toMatchObject({
      peers: [{ peer: other }],
    });
    await expect(
      executeTool(tools, "session_send", {
        to: other,
        scopeId: "team",
        message: { kind: "request", content: "request", format: "text" },
      }),
    ).resolves.toMatchObject({ outcome: { tag: "admitted" } });
    await expect(
      executeTool(tools, "session_send", {
        to: peer,
        scopeId: "team",
        message: { kind: "update", content: "denied", format: "text" },
      }),
    ).resolves.toMatchObject({
      outcome: { tag: "not_admitted", code: "forbidden" },
    });
    await expect(executeTool(tools, "session_take", {})).resolves.toMatchObject({ messages: [] });
    const record = {
      category: "context",
      title: "title",
      summary: "summary",
      format: "text",
      preparation: "authored",
    };
    await expect(
      executeTool(tools, "session_state", {
        action: "put",
        scopeId: "team",
        key: "notes",
        record,
      }),
    ).resolves.toMatchObject({ tag: "ok" });
    await expect(
      executeTool(tools, "session_state", {
        action: "remove",
        scopeId: "team",
        key: "notes",
      }),
    ).resolves.toMatchObject({ tag: "ok" });
    await expect(
      executeTool(tools, "session_state", {
        action: "get",
        publisher: other,
        scopeId: "team",
        key: "notes",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ tag: "error", code: "not_found" });
    await expect(
      executeTool(tools, "session_state", {
        action: "list",
        publisher: other,
        scopeId: "team",
      }),
    ).resolves.toMatchObject({ tag: "ok" });
    await expect(
      executeTool(tools, "session_state", {
        action: "list",
        publisher: peer,
        scopeId: "team",
      }),
    ).resolves.toMatchObject({ code: "forbidden" });
    await expect(
      executeTool(tools, "session_state", {
        action: "remove",
        scopeId: "other",
        key: "notes",
      }),
    ).resolves.toMatchObject({ code: "unavailable" });
    const work = { kind: "request", origin: peer, requestId: "8".repeat(32) };
    await expect(
      executeTool(tools, "session_interest", {
        action: "add",
        publisher: other,
        scopeId: "team",
        work,
      }),
    ).resolves.toMatchObject({ code: "not_found" });
    await expect(
      executeTool(tools, "session_interest", {
        action: "remove",
        publisher: other,
        scopeId: "team",
        work,
      }),
    ).resolves.toMatchObject({ tag: "ok" });
    await expect(
      executeTool(tools, "session_interest", {
        action: "add",
        publisher: peer,
        scopeId: "team",
        work,
      }),
    ).resolves.toMatchObject({ code: "forbidden" });
    const report = {
      scopeId: "team",
      key: "work",
      record: { ...record, category: "work", work, status: "in_progress" },
      notify: "selected",
      recipients: [other],
    };
    const release = owned.session.client.reservePushes(8);
    assert(release);
    const revision = owned.session.state.stats().revision;
    await expect(executeTool(tools, "session_report", report)).resolves.toMatchObject({
      tag: "error",
      code: "overloaded",
      resource: "operations",
    });
    expect(owned.session.state.stats().revision).toBe(revision);
    release();
    await expect(executeTool(tools, "session_report", report)).resolves.toMatchObject({
      tag: "ok",
      value: { pushes: [{ outcome: { tag: "admitted" } }] },
    });
    expect(owned.session.client.status().operations).toBe(0);
    await expect(
      executeTool(tools, "session_send", {
        to: other,
        scopeId: "team",
        message: {
          kind: "request",
          content: "invalid",
          format: "text",
          unexpected: true,
        },
      }),
    ).resolves.toMatchObject({
      tag: "error",
      code: "invalid_input",
      note: "The session request is invalid. Check the tool arguments and configured scopes. No delivery or work-completion claim. Unknown sends must not be retried as a new message ID.",
    });
  });
  test("report commits once, holds all eight logical slots across four-wide partial delivery, then releases", async () => {
    const fixture = await gateway(() => undefined);
    const session = new AdapterSession(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => undefined,
      () => undefined,
    );
    cleanups.push(async () => {
      session.close();
    });
    await session.start();
    const recipients = Array.from({ length: 8 }, (_, index) => ({
      ...other,
      sessionId: `recipient-${index}`,
    }));
    const pending = session.report({
      scopeId: "team",
      key: "report",
      notify: "selected",
      recipients,
      record: {
        category: "work",
        title: "bounded report",
        summary: "authored terminal result",
        format: "text",
        preparation: "authored",
        status: "completed",
        work: { kind: "publication", publisher: peer, key: "report" },
      },
    });
    await expect
      .poll(() => fixture.requests.filter((request) => request.op === "send").length)
      .toBe(4);
    expect(session.state.stats().revision).toBe(1);
    expect(session.client.status().operations).toBe(8);
    await expect(
      session.report({
        scopeId: "team",
        key: "unused",
        notify: "selected",
        recipients,
        record: {
          category: "context",
          title: "not published",
          summary: "not work",
          format: "text",
          preparation: "authored",
        },
      }),
    ).resolves.toMatchObject({
      tag: "error",
      code: "overloaded",
      resource: "operations",
    });
    await expect(session.send(other, "team", authored())).resolves.toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
    });
    const firstBatch = fixture.requests.filter((request) => request.op === "send");
    for (const [index, request] of firstBatch.entries()) {
      replyToReport(fixture, request, index === 0);
    }
    await expect
      .poll(() => fixture.requests.filter((request) => request.op === "send").length)
      .toBe(8);
    expect(session.client.status().operations).toBe(8);
    const secondBatch = fixture.requests.filter((request) => request.op === "send").slice(4);
    for (const request of secondBatch) {
      replyToReport(fixture, request, false);
    }
    const result = await pending;
    expect(result).toMatchObject({
      tag: "ok",
      value: { publication: { revision: 1 } },
    });
    assert(result.tag === "ok");
    expect(result.value.pushes).toHaveLength(8);
    expect(result.value.pushes[0]).toMatchObject({
      outcome: { tag: "not_admitted", code: "forbidden" },
    });
    expect(session.state.stats().revision).toBe(1);
    expect(session.client.status().operations).toBe(0);
    await expect(
      session.report({
        scopeId: "team",
        key: "unused",
        notify: "interested",
        record: {
          category: "context",
          title: "invalid report",
          summary: "not work",
          format: "text",
          preparation: "authored",
        },
      }),
    ).resolves.toMatchObject({ tag: "error" });
    expect(session.client.status().operations).toBe(0);
  });
  test("shared registration survives initiating caller cancellation", async () => {
    const fixture = await gateway(discoveryReply, true);
    const client = makeClient(fixture.config);
    cleanups.push(async () => {
      client.close();
    });
    const abort = new AbortController();
    const first = resultOf(
      client.request(
        {
          v: 1,
          op: "discover",
          rid: "a".repeat(32),
          scopeIds: ["team"],
          watch: false,
        },
        abort.signal,
      ),
    );
    await expect.poll(() => fixture.requests.length).toBe(1);
    const second = resultOf(
      client.request({
        v: 1,
        op: "discover",
        rid: "b".repeat(32),
        scopeIds: ["team"],
        watch: false,
      }),
    );
    abort.abort();
    releaseRegistration(fixture);
    await expect(first).resolves.toContain("cancelled");
    await expect(second).resolves.toMatchObject({
      forOp: "discover",
      outcome: { tag: "ok" },
    });
  });
  test("each connection waiter honors its own deadline without cancelling registration", async () => {
    const fixture = await gateway(discoveryReply, true);
    const client = makeClient(fixture.config);
    cleanups.push(async () => {
      client.close();
    });
    const first = resultOf(
      client.request({
        v: 1,
        op: "discover",
        rid: "a".repeat(32),
        scopeIds: ["team"],
        watch: false,
      }),
    );
    await expect.poll(() => fixture.requests.length).toBe(1);
    const short = resultOf(
      client.request(
        {
          v: 1,
          op: "discover",
          rid: "b".repeat(32),
          scopeIds: ["team"],
          watch: false,
        },
        undefined,
        performance.now() + 20,
      ),
    );
    // The registration is still held, so only the waiter's own deadline can settle `short`: if it
    // ignored the deadline this await would hang and the test would fail on its timeout.
    const shortOutcome = await short;
    releaseRegistration(fixture);
    await first;
    expect(shortOutcome).toContain("unavailable");
  });
  test("an initializing watch never returns a premature cached snapshot or different scopes", async () => {
    const fixture = await gateway(() => undefined);
    const client = makeClient(fixture.config);
    cleanups.push(async () => {
      client.close();
    });
    const first = client.discover(["team"], true);
    await expect
      .poll(() => fixture.requests.filter((request) => request.op === "discover").length)
      .toBe(1);
    const same = await client.discover(["team"], true);
    const different = await client.discover(["other"], true);
    const request = fixture.requests.find((item) => item.op === "discover");
    assert(request);
    const reply = discoveryReply(request);
    assert(reply);
    fixture.sendFrame(reply);
    await first;
    expect(same).toMatchObject({
      outcome: { tag: "error", code: "overloaded", resource: "watch" },
    });
    expect(different).toMatchObject({
      outcome: { tag: "error", code: "overloaded", resource: "watch" },
    });
    const ready = await client.discover(["team"], true);
    expect(ready).toMatchObject({
      outcome: {
        tag: "ok",
        value: { peers: [{ peer: other }], watching: true },
      },
    });
    await expect(client.discover(["other"], true)).resolves.toMatchObject({
      outcome: { tag: "error", code: "overloaded", resource: "watch" },
    });
  });
  test("keeps message identity and uncertainty when a lost receipt is followed by denial", async () => {
    const fixture = await gateway(lostThenDenied());
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      incoming: () => {
        throw new Error("Unexpected inbound");
      },
      statusChanged: () => undefined,
    });
    cleanups.push(async () => {
      client.close();
    });
    const result = await client.send(other, "team", authored());
    expect(result.tag).toBe("unknown");
    const attempts = fixture.requests.filter((request) => request.op === "send");
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((request) => request.message.id)).size).toBe(1);
    expect(new Set(attempts.map((request) => request.rid)).size).toBe(2);
  });
  test("rejects a misbound admitted receipt without retrying malformed protocol", async () => {
    const fixture = await gateway(misbound);
    const client = new GatewayClient({
      config: fixture.config,
      peer,
      incoming: () => {
        throw new Error("Unexpected inbound");
      },
      statusChanged: () => undefined,
    });
    cleanups.push(async () => {
      client.close();
    });
    const result = await client.send(other, "team", authored());
    expect(result).toMatchObject({ tag: "unknown", code: "protocol_error" });
    expect(fixture.requests.filter((request) => request.op === "send")).toHaveLength(1);
  });
  test("transfers FIFO payloads once, retains receipts, and retires only exact identified notices", async () => {
    const fixture = await gateway(() => undefined);
    const notices: { customType: string; details?: unknown }[] = [];
    const wakes: unknown[] = [];
    let idle = false;
    const session: AdapterSession = new AdapterSession(
      fixture.config,
      peer,
      {
        sendMessage: (message, options) => {
          notices.push(message);
          wakes.push(options);
        },
      },
      () => ({ isIdle: () => idle, ui: { setStatus: () => undefined } }),
      () => {
        session.pumpIdle();
      },
    );
    cleanups.push(async () => {
      session.close();
    });
    await session.start();
    const message = authored();
    fixture.sendFrame({
      v: 1,
      op: "deliver",
      rid: "4".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      message,
    });
    await expect.poll(() => session.state.stats().inboxMessages).toBe(1);
    expect(notices).toHaveLength(0);
    const boundary = session.beforeSettle({ entries: [] });
    expect(boundary?.continue).toBe(true);
    expect(session.beforeSettle({ entries: [] })).toBeUndefined();
    session.settled();
    idle = true;
    fixture.sendFrame({
      v: 1,
      op: "deliver",
      rid: "5".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      message: authored("6".repeat(32)),
    });
    await expect.poll(() => notices.length).toBe(1);
    // The notice is what wakes an idle Pi: it must start a turn, steered into the session.
    expect(wakes).toStrictEqual([{ triggerTurn: true, deliverAs: "steer" }]);
    session.observed({
      role: "custom",
      customType: NOTICE_TYPE,
      details: { noticeId: "wrong" },
    });
    expect(session.status().notice).toBe("submitted_unobserved");
    const taken = session.take(8);
    expect(taken.messages.map((delivery) => delivery.message.id)).toStrictEqual([
      message.id,
      "6".repeat(32),
    ]);
    expect(session.take(8).messages).toHaveLength(0);
    expect(session.state.stats().receipts).toBe(2);
    expect(session.status().notice).toBe("submitted_unobserved");
    session.observed({
      role: "custom",
      customType: NOTICE_TYPE,
      details: notices[0]?.details,
    });
    expect(session.status().notice).toBe("none");
    fixture.sendFrame({
      v: 1,
      op: "deliver",
      rid: "7".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      message,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(session.state.stats().inboxMessages).toBe(0);
    expect(notices).toHaveLength(1);
  });
  test("watch events update only the live scoped snapshot and invalidation permits a fresh watch", async () => {
    const fixture = await gateway(discoveryReply);
    const client = makeClient(fixture.config);
    cleanups.push(async () => {
      client.close();
    });
    await client.discover(["team"], true);
    const request = fixture.requests.find((item) => item.op === "discover");
    assert(request);
    fixture.sendFrame({
      v: 1,
      op: "roster.event",
      rid: "f".repeat(32),
      event: { tag: "remove", peer: other },
    });
    fixture.sendFrame({
      v: 1,
      op: "roster.event",
      rid: request.rid,
      event: { tag: "remove", peer: other },
    });
    await expect
      .poll(async () => client.discover(["team"], true))
      .toMatchObject({ outcome: { value: { peers: [] } } });
    fixture.sendFrame({
      v: 1,
      op: "roster.event",
      rid: request.rid,
      event: {
        tag: "upsert",
        peer: { peer: other, label: "changed", scopeIds: ["team"] },
      },
    });
    await expect
      .poll(async () => client.discover(["team"], true))
      .toMatchObject({ outcome: { value: { peers: [{ label: "changed" }] } } });
    fixture.sendFrame({
      v: 1,
      op: "roster.event",
      rid: request.rid,
      event: { tag: "invalidated", reason: "policy_changed" },
    });
    await expect.poll(() => client.status().watching).toBe(false);
    await client.discover(["team"], true);
    expect(fixture.requests.filter((item) => item.op === "discover")).toHaveLength(2);
    const release = client.reservePushes(8);
    assert(release);
    expect(client.reservePushes(1)).toBeUndefined();
    expect(client.reservePushes(0)).toBeUndefined();
    expect(client.reservePushes(9)).toBeUndefined();
    await expect(client.send(other, "team", authored())).resolves.toMatchObject({
      tag: "not_admitted",
      code: "overloaded",
    });
    release();
    release();
    expect(client.status().operations).toBe(0);
    client.close();
    expect(client.reservePushes(1)).toBeUndefined();
    await expect(client.send(other, "team", authored())).resolves.toMatchObject({
      code: "cancelled",
    });
    await expect(
      client.request({
        v: 1,
        op: "discover",
        rid: "e".repeat(32),
        scopeIds: ["team"],
        watch: false,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
  test("failed watches release ownership and malformed scope events close the connection", async () => {
    const fixture = await gateway(discoveryReply);
    const client = makeClient(fixture.config);
    cleanups.push(async () => {
      client.close();
    });
    await expect(client.discover(["team"], true, AbortSignal.abort())).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(client.status().watching).toBe(false);
    await client.discover(["team"], true);
    const request = fixture.requests.find((item) => item.op === "discover");
    assert(request);
    fixture.sendFrame({
      v: 1,
      op: "roster.event",
      rid: request.rid,
      event: {
        tag: "upsert",
        peer: { peer: other, label: "bad scope", scopeIds: ["private"] },
      },
    });
    await expect.poll(() => client.status().status).toBe("protocol_error");
    await expect(
      client.request(
        {
          v: 1,
          op: "discover",
          rid: "e".repeat(32),
          scopeIds: ["team"],
          watch: false,
        },
        undefined,
        performance.now() - 1,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  test("transport bounds pending slots, aborts waits, discards stale results and fails malformed frames", async () => {
    const fixture = await gateway(() => undefined, true);
    const disconnected: string[] = [];
    const connection = await connectTransport({
      socketPath: fixture.config.socketPath,
      deadline: performance.now() + 60_000,
      incoming: () => {
        throw new Error("unsupported");
      },
      event: () => undefined,
      disconnected: (code) => {
        disconnected.push(code);
      },
      validateReply: () => undefined,
    });
    cleanups.push(async () => {
      connection.close();
    });
    const abort = new AbortController();
    const pending = Array.from({ length: 8 }, async (_, index) =>
      resultOf(
        connection.request(
          {
            v: 1,
            op: "discover",
            rid: index.toString(16).repeat(32),
            scopeIds: ["team"],
            watch: false,
          },
          performance.now() + 60_000,
          abort.signal,
        ),
      ),
    );
    expect(connection.pendingCount()).toBe(8);
    await expect(
      connection.request({ v: 1, op: "close", rid: "a".repeat(32) }, performance.now() + 60_000),
    ).rejects.toMatchObject({ code: "overloaded", possible: false });
    abort.abort();
    await expect(Promise.all(pending)).resolves.toStrictEqual(
      Array.from({ length: 8 }, () => "Session communication cancelled"),
    );
    expect(connection.pendingCount()).toBe(0);
    await expect(
      connection.request(
        { v: 1, op: "close", rid: "a".repeat(32) },
        performance.now() + 60_000,
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      connection.request({ v: 1, op: "close", rid: "a".repeat(32) }, performance.now() - 1),
    ).rejects.toMatchObject({ code: "unavailable" });
    // The deadline runs on a fake clock that moves only once the gateway holds the request, so the
    // write has completed and the failure must say the request may have been delivered.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const unanswered = connection
        .request({ v: 1, op: "close", rid: "b".repeat(32) }, performance.now() + 10)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await expect
        .poll(() => fixture.requests.some((item) => item.rid === "b".repeat(32)))
        .toBe(true);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      vi.advanceTimersByTime(10);
      await expect(unanswered).resolves.toMatchObject({
        code: "unavailable",
        possible: true,
      });
    } finally {
      vi.useRealTimers();
    }
    fixture.sendFrame({
      v: 1,
      op: "result",
      rid: "b".repeat(32),
      forOp: "close",
      outcome: { tag: "ok", value: {} },
    });
    fixture.raw(Buffer.from([0, 0, 0, 0]));
    await expect.poll(() => disconnected).toEqual(["protocol_error"]);
    await expect(
      connection.request({ v: 1, op: "close", rid: "c".repeat(32) }, performance.now() + 60_000),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  test("session_state get puts expectedRevision on the wire only when the caller supplied one", async () => {
    const fixture = await gateway(missingPublication);
    const current: { session?: AdapterSession } = {};
    const tools: CapturedTool[] = [];
    registerTools(
      {
        registerTool: (definition) => {
          tools.push({
            name: definition.name,
            execute: definition.execute.bind(definition),
          });
        },
      },
      () => current.session,
    );
    const owned = await createAdapterRuntime(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => ({ isIdle: () => true, ui: { setStatus: () => undefined } }),
    );
    cleanups.push(async () => {
      await owned.dispose();
    });
    current.session = owned.session;
    await expect.poll(() => owned.session.client.status().connected).toBe(true);
    const get = {
      action: "get",
      publisher: other,
      scopeId: "team",
      key: "notes",
    };
    await executeTool(tools, "session_state", { ...get, expectedRevision: 7 });
    await executeTool(tools, "session_state", { ...get, expectedRevision: 0 });
    await executeTool(tools, "session_state", get);
    const sent = fixture.requests.filter((request) => request.op === "state.get");
    expect(sent.map((request) => request.expectedRevision)).toStrictEqual([7, 0, undefined]);
    expect(sent.map((request) => "expectedRevision" in request)).toStrictEqual([true, true, false]);
  });
  test("adapter answers a state.get whose expectedRevision differs from the current publication with revision_mismatch", async () => {
    const fixture = await gateway(() => undefined);
    const session = new AdapterSession(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => ({ isIdle: () => true, ui: { setStatus: () => undefined } }),
      () => undefined,
    );
    cleanups.push(async () => {
      session.close();
    });
    await session.start();
    expect(
      session.state.publish({
        scopeId: "team",
        key: "report",
        record: {
          category: "context",
          title: "report",
          summary: "summary",
          format: "text",
          preparation: "authored",
        },
      }),
    ).toMatchObject({ tag: "ok" });
    const ask = (rid: string, expectedRevision: number) => {
      fixture.sendFrame({
        v: 1,
        op: "state.get",
        rid,
        from: other,
        publisher: peer,
        scopeId: "team",
        key: "report",
        expectedRevision,
      });
    };
    ask("a".repeat(32), 1);
    ask("b".repeat(32), 2);
    await expect.poll(() => fixture.replies.length).toBe(2);
    expect(fixture.replies[0]?.outcome).toMatchObject({ tag: "ok" });
    expect(fixture.replies[1]?.outcome).toStrictEqual({
      tag: "error",
      code: "revision_mismatch",
    });
  });
  test("adapter serves read/interest controls without wakes, including wrong-runtime routing", async () => {
    const fixture = await gateway(() => undefined);
    const notices: unknown[] = [];
    const session = new AdapterSession(
      fixture.config,
      peer,
      {
        sendMessage: (value) => {
          notices.push(value);
        },
      },
      () => ({ isIdle: () => true, ui: { setStatus: () => undefined } }),
      () => undefined,
    );
    cleanups.push(async () => {
      session.close();
    });
    await session.start();
    const work = {
      kind: "publication" as const,
      publisher: peer,
      key: "report",
    };
    expect(
      session.state.publish({
        scopeId: "team",
        key: "report",
        record: {
          category: "work",
          title: "report",
          summary: "summary",
          format: "text",
          preparation: "authored",
          work,
        },
      }),
    ).toMatchObject({ tag: "ok" });
    fixture.sendFrame({
      v: 1,
      op: "state.get",
      rid: "a".repeat(32),
      from: other,
      publisher: peer,
      scopeId: "team",
      key: "report",
      expectedRevision: 1,
    });
    fixture.sendFrame({
      v: 1,
      op: "state.list",
      rid: "b".repeat(32),
      from: other,
      publisher: peer,
      scopeId: "team",
    });
    fixture.sendFrame({
      v: 1,
      op: "interest.add",
      rid: "c".repeat(32),
      from: other,
      publisher: peer,
      scopeId: "team",
      work,
    });
    fixture.sendFrame({
      v: 1,
      op: "interest.remove",
      rid: "d".repeat(32),
      from: other,
      publisher: peer,
      scopeId: "team",
      work,
    });
    fixture.sendFrame({
      v: 1,
      op: "state.list",
      rid: "e".repeat(32),
      from: other,
      publisher: other,
      scopeId: "team",
    });
    await expect.poll(() => fixture.replies.length).toBe(5);
    expect(fixture.replies.slice(0, 4).every((reply) => reply.outcome.tag === "ok")).toBe(true);
    expect(fixture.replies[4]).toMatchObject({
      outcome: { tag: "error", code: "no_route" },
    });
    expect(notices).toHaveLength(0);
    session.afterCompaction(true);
    session.afterCompaction();
    session.afterCompaction();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(notices).toHaveLength(0);
    fixture.raw(Buffer.from(encodeFrame({ v: 1, op: "ping", rid: "f".repeat(32) }, "remote-link")));
    await expect.poll(() => session.client.status().connected).toBe(false);
    session.close();
    session.afterCompaction();
    expect(session.beforeSettle({ entries: [] })).toBeUndefined();
  });
});
