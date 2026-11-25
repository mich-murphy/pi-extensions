import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import type { EnsureGateway } from "../adapter/client.js";
import type { Configuration } from "../adapter/config.js";
import { sessionHandle } from "../adapter/handles.js";
import { statusSummary } from "../adapter/presentation.js";
import { createAdapterRuntime } from "../adapter/runtime.js";
import { AdapterSession, NOTICE_TYPE } from "../adapter/session.js";
import { registerTools } from "../adapter/tools.js";
import type { ToolArguments, ToolValue } from "../adapter/tools.js";
import { connectTransport } from "../adapter/transport.js";
import type { PeersContext } from "../index.js";
import sessionCommunication from "../index.js";
import type { Frame, Message } from "../protocol/schema.js";
import { decodeFrame, encodeFrame, frameBodyLength } from "../protocol/wire.js";
import { toolRecorder } from "./adapter-tool-fixture.js";
import { extensionFixture } from "./extension-fixture.js";

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

type SentNotice = Parameters<ExtensionAPI["sendMessage"]>;

type SessionHolder = { session?: AdapterSession };

type Reply = Extract<Frame, { op: "result" }>;

type Request = Exclude<Frame, { op: "result" | "roster.event" | "link.state" }>;

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

        if (request.op === "roster.event" || request.op === "link.state") {
          continue;
        }

        requests.push(request);
        let reply: Reply | undefined;

        if (request.op === "register" && !holdRegistration) {
          reply = {
            v: 2,
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
        permissions: ["discover", "push"],
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
    drop: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
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
      v: 2,
      op: "result",
      rid: request.rid,
      forOp: "send",
      outcome: {
        tag: "not_admitted",
        messageId: request.message.id,
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
    v: 2,
    op: "result",
    rid: request.rid,
    forOp: "send",
    outcome: {
      tag: "admitted",
      messageId: "f".repeat(32),
      correlation: "none",
      durable: false,
    },
  };
}

function discoveryReply(request: Request): Reply | undefined {
  if (request.op !== "discover") {
    return undefined;
  }

  return {
    v: 2,
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
    v: 2,
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

function unroutedGateway(request: Request): Reply | undefined {
  if (request.op !== "send") {
    return toolGateway(request);
  }

  return {
    v: 2,
    op: "result",
    rid: request.rid,
    forOp: "send",
    outcome: { tag: "not_admitted", messageId: request.message.id, code: "no_route" },
  };
}

function toolGateway(request: Request): Reply | undefined {
  if (request.op === "send") {
    return {
      v: 2,
      op: "result",
      rid: request.rid,
      forOp: "send",
      outcome: {
        tag: "admitted",
        messageId: request.message.id,
        correlation: "none",
        durable: false,
      },
    };
  }

  return discoveryReply(request);
}

async function executeTool(
  fixture: ReturnType<typeof toolRecorder>,
  name: string,
  args: ToolArguments,
): Promise<ToolValue> {
  const result = await fixture.run(name, args);

  return result.details.value;
}

async function acceptedProbe(fixture: Awaited<ReturnType<typeof gateway>>): Promise<void> {
  const before = fixture.connections();
  const probe = createConnection(fixture.config.socketPath);
  cleanups.push(async () => {
    probe.destroy();
  });
  await expect.poll(() => fixture.connections()).toBeGreaterThan(before);
}

async function flaggedResult(
  fixture: ReturnType<typeof toolRecorder>,
  name: string,
  args: ToolArguments,
) {
  const result = await fixture.run(name, args);
  const { value } = result.details;

  return {
    isError: result.isError === true,
    value,
    note: "note" in value ? value.note : undefined,
  };
}

function restoreAgentDir(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function extensionHost(select: PeersContext["ui"]["select"] = async () => undefined) {
  const fixture = extensionFixture();
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];

  const context: PeersContext = {
    mode: "rpc",
    hasUI: true,
    signal: undefined,
    sessionManager: {
      getSessionId: () => peer.sessionId,
      getCwd: () => "/work/repo",
      getSessionName: () => undefined,
      getHeader: () => null,
    },
    isIdle: () => true,
    ui: {
      select,
      input: async () => undefined,
      notify: (text) => {
        notifications.push(text);
      },
      setStatus: (_key, text) => {
        statuses.push(text);
      },
    },
  };

  sessionCommunication(fixture.api);

  return {
    notifications,
    statuses,
    commands: fixture.commands,
    event: async <Name extends Parameters<typeof fixture.event>[0]>(
      name: Name,
      payload: Parameters<typeof fixture.event<Name>>[1],
    ) => fixture.event(name, payload, context),
    command: async (args: string, name = "peers") => fixture.command(name, args, context),
  };
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
    v: 2,
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
        v: 2,
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

async function expectFailure<Value>(pending: Promise<Value>, message: string): Promise<void> {
  await expect(pending).rejects.toThrow(message);
}

async function expectPossibleFailure<Value>(pending: Promise<Value>): Promise<void> {
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

const olderGatewayAnswers = {
  "closes the connection": (_request: Request, socket: Socket) => {
    socket.destroy();
  },
  "answers in wire v1": (request: Request, socket: Socket) => {
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        op: "result",
        rid: request.rid,
        forOp: "register",
        outcome: { tag: "error", code: "forbidden" },
      }),
    );

    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length);
    socket.write(Buffer.concat([prefix, body]));
  },
};

describe("an older gateway still running", () => {
  test.each(Object.entries(olderGatewayAnswers))(
    "a register it %s says the gateway is older and to restart it with Setup",
    async (_name, answer) => {
      const fixture = await gateway((request, socket) => {
        answer(request, socket);

        return undefined;
      }, true);

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
      await expect(session.reconnect()).rejects.toThrow("Session communication");
      expect(session.status().status).toBe("gateway_outdated");
      const summary = statusSummary(session.status(), "enabled", { inMenu: true });
      expect(summary.headline).toBe("The running gateway is an older version");
      expect(summary.next).toBe("Choose Setup to restart it.");
      expect(fixture.requests.filter((request) => request.op === "gateway.restart")).toHaveLength(
        0,
      );
    },
  );
});

describe("public adapter transport and notice accounting", () => {
  afterEach(async () => {
    for (const close of cleanups.splice(0).toReversed()) {
      await close();
    }
  });
  test.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
    ["an undefined digest", { gatewaySha256: undefined }],
    ["an uppercase digest", { gatewaySha256: "A".repeat(64) }],
    ["a short digest", { gatewaySha256: "a".repeat(63) }],
    ["a numeric digest", { gatewaySha256: 123 }],
  ] as const)(
    "a supplied ensure returning malformed snapshot (%s) fails before any connection or register",
    async (_label, value) => {
      const fixture = await gateway(() => undefined);

      const client = new GatewayClient({
        config: fixture.config,
        peer,
        ensureGateway: async () => value,
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
      old.reject(new Error("stale metadata failure"));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(statusChanged).toHaveBeenCalledTimes(1);

      const tool = client.request({
        v: 2,
        op: "discover",
        rid: "f".repeat(32),
        scopeIds: ["team"],
        watch: false,
      });

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
        expect(fixture.requests).toHaveLength(requests);
        expect(ensureGateway).toHaveBeenCalledTimes(2);
      } finally {
        client.close();
      }
    },
  );
  test("a fresh fence publishes only disconnected: the old transport's synchronous disconnect callback is already stale", async () => {
    const fixture = await gateway(() => undefined);
    const held = Promise.withResolvers<{ gatewaySha256: string }>();

    const ensureGateway = vi
      .fn<EnsureGateway>()
      .mockResolvedValueOnce({ gatewaySha256: "a".repeat(64) })
      .mockImplementation(async () => held.promise);

    const published: string[] = [];

    const client: GatewayClient = new GatewayClient({
      config: fixture.config,
      peer,
      ensureGateway,
      incoming: () => {
        throw new Error("Unexpected request");
      },
      statusChanged: () => {
        published.push(client.status().status);
      },
    });

    try {
      await client.reconnect();
      published.length = 0;
      const fresh = expectFailure(client.reconnect(undefined, true), "cancelled");
      expect(published).toStrictEqual(["disconnected"]);
      client.close();
      await fresh;
    } finally {
      client.close();
    }
  });
  test("menu failures never quote a system error, which may hold a path or file content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "psc-quote-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;

    const host = extensionHost(async () => {
      throw new Error("EACCES: permission denied, open '/private/secret/pi-peers.json'");
    });

    cleanups.push(async () => {
      restoreAgentDir(previous);
      await rm(directory, { recursive: true, force: true });
    });
    await host.command("setup");
    expect(host.notifications).toStrictEqual([
      "The peers menu could not open. Run /peers doctor to check your files.",
    ]);
  });
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
    await acceptedProbe(fixture);
    expect(fixture.connections()).toBe(1);
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
          v: 2,
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
  test("an older gateway closing guarded register is reported as outdated and never triggers unguarded fallback or passive control", async () => {
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
        status: "gateway_outdated",
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
      await host.event("session_shutdown", { type: "session_shutdown" });
      restoreAgentDir(previous);
      await rm(directory, { recursive: true, force: true });
    });
    await host.event("session_start", { type: "session_start" });
    expect(host.notifications).toStrictEqual([]);
    expect([...host.commands.keys()]).toStrictEqual(["peers"]);
    expect(host.commands.get("peers")?.getArgumentCompletions?.("re")).toStrictEqual([
      { value: "reconnect", label: "reconnect", description: "Retry connecting this Pi" },
      { value: "reset", label: "reset", description: "Disable peers for this agent directory" },
    ]);
    await host.command("status");
    expect(host.notifications.at(-1)).toContain("not enabled");
    const legacyStatus = host.notifications.at(-1);
    await host.command("status", "peers");
    expect(host.notifications.at(-1)).toBe(legacyStatus);
    await host.command("doctor", "peers");
    expect(host.notifications.at(-1)).toContain(directory);
    expect(host.notifications.at(-1)).toContain(
      "pi-peers.json is missing on disk; new sessions will not connect",
    );
    await host.command("setup", "peers");
    expect(host.notifications.at(-1)).toContain("Cancelled");
    await host.command("status extra", "peers");
    expect(host.notifications.at(-1)).toContain("Usage: /peers");
    await host.command("invalid");
    expect(host.notifications.at(-1)).toContain("Usage:");
    await host.command("reconnect");
    await host.event("message_end", { type: "message_end", message: { role: "custom" } });
    await host.event("agent_before_settle", { type: "agent_before_settle", entries: [] });
    await host.event("agent_settled", { type: "agent_settled" });
    await host.event("session_compact", { type: "session_compact" });
    await host.event("session_compact_failed", { type: "session_compact_failed", aborted: true });
    await host.event("session_shutdown", { type: "session_shutdown" });
    await writeFile(join(directory, "pi-peers.json"), "invalid");
    await host.event("session_start", { type: "session_start" });
    expect(host.statuses.at(-1)).toBe("peers ✕ setup failed");
    await host.command("doctor", "peers");
    expect(host.notifications.at(-1)).toContain("invalid JSON");
    expect(host.notifications.at(-1)).toContain(directory);
    await host.command("status");
    expect(host.notifications.at(-1)).toContain("configuration or startup failed");
    await writeFile(
      join(directory, "pi-peers.json"),
      JSON.stringify({
        machineId: "alpha",
        socketPath: join(directory, "down"),
        scopeIds: ["team"],
        label: "Pi",
        policies: [],
      }),
    );
    await host.event("session_start", { type: "session_start" });
    await host.command("doctor", "peers");
    expect(host.notifications.at(-1)).toContain("Configuration: valid");
    expect(host.notifications.at(-1)).toContain("absent or inaccessible");
    expect(host.notifications.at(-1)).not.toContain("connected ·");
    await host.event("session_shutdown", { type: "session_shutdown" });
    const fixture = await gateway(discoveryReply);
    await writeFile(join(directory, "pi-peers.json"), JSON.stringify(fixture.config));
    await host.event("session_start", { type: "session_start" });
    await expect.poll(() => fixture.requests.length).toBe(1);
    await host.command("reconnect", "peers");
    expect(host.notifications.at(-1)).toContain("Connected as");
    await rm(join(directory, "pi-peers.json"));
    await host.command("doctor", "peers");
    expect(host.notifications.at(-1)).toContain("missing on disk");
    expect(host.notifications.at(-1)).toContain("This session may still be connected");
    expect(host.notifications.at(-1)).toContain("Connected as");
    expect(host.notifications.at(-1)).not.toContain("participation is off");
    expect(host.statuses.at(-1)).toBe("peers ✓");
    await host.event("message_end", { type: "message_end", message: { role: "custom" } });
    await host.event("agent_before_settle", { type: "agent_before_settle", entries: [] });
    await host.event("agent_settled", { type: "agent_settled" });
    await host.event("session_compact", { type: "session_compact" });
    await host.event("session_compact_failed", { type: "session_compact_failed", aborted: true });
    await host.event("session_shutdown", { type: "session_shutdown" });
    await host.event("session_shutdown", { type: "session_shutdown" });
    await host.command("status");
    expect(host.notifications.at(-1)).toContain("Peers is unavailable in this session");
    expect(host.notifications.at(-1)).not.toContain("Remote config snapshot");
    expect(host.notifications.at(-1)).not.toContain("Connected as");
  });
  test("public tools share the scoped runtime", async () => {
    const fixture = await gateway(toolGateway);
    const current: SessionHolder = {};
    const tools = toolRecorder();
    registerTools(tools, () => current.session);
    await expect(executeTool(tools, "peers_take", {})).resolves.toMatchObject({
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
    const listed = await executeTool(tools, "peers_list", {});
    expect(listed).toMatchObject({ peers: [{ peer: other, self: false, restarted: false }] });
    const handle = sessionHandle(other.machineId, other.sessionId);
    expect(listed).toMatchObject({ peers: [{ handle }] });
    await expect(
      executeTool(tools, "peers_send", { to: handle, kind: "request", content: "request" }),
    ).resolves.toMatchObject({ to: handle, outcome: { tag: "admitted" } });
    await expect(
      executeTool(tools, "peers_send", { to: "s-0000", kind: "update", content: "lost" }),
    ).resolves.toMatchObject({
      tag: "error",
      code: "invalid_input",
      note: "Unknown handle; call peers_list.",
    });
    await expect(executeTool(tools, "peers_take", {})).resolves.toMatchObject({ messages: [] });
    await expect(
      executeTool(tools, "peers_send", {
        to: handle,
        kind: "request",
        content: "x",
        unexpected: 1,
      }),
    ).resolves.toMatchObject({
      tag: "error",
      code: "invalid_input",
      note: "The arguments were rejected before anything was sent. Check them and the configured scopes.",
    });
  });
  test("a tool call on a closed client reports a cancelled request", async () => {
    const fixture = await gateway(toolGateway);
    const tools = toolRecorder();

    const owned = await createAdapterRuntime(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => ({ isIdle: () => true, ui: { setStatus: () => undefined } }),
    );

    cleanups.push(async () => {
      await owned.dispose();
    });
    registerTools(tools, () => owned.session);
    owned.session.client.close();
    await expect(executeTool(tools, "peers_take", {})).resolves.toStrictEqual({
      tag: "error",
      code: "cancelled",
      note: "The request was cancelled.",
    });
  });
  test("a send the gateway could not route is flagged as an error and says resending cannot duplicate it", async () => {
    const fixture = await gateway(unroutedGateway);
    const tools = toolRecorder();

    const owned = await createAdapterRuntime(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => ({ isIdle: () => true, ui: { setStatus: () => undefined } }),
    );

    cleanups.push(async () => {
      await owned.dispose();
    });
    registerTools(tools, () => owned.session);
    await expect.poll(() => owned.session.client.status().connected).toBe(true);
    await executeTool(tools, "peers_list", {});

    const result = await flaggedResult(tools, "peers_send", {
      to: sessionHandle(other.machineId, other.sessionId),
      kind: "request",
      content: "hi",
    });

    expect(result).toMatchObject({
      isError: true,
      value: { outcome: { tag: "not_admitted", code: "no_route" } },
    });
    expect(result.note).toMatch(/^Not delivered\. .*Call peers_list.*cannot duplicate it\.$/u);
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
          v: 2,
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
        v: 2,
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
        v: 2,
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
          v: 2,
          op: "discover",
          rid: "b".repeat(32),
          scopeIds: ["team"],
          watch: false,
        },
        undefined,
        performance.now() + 20,
      ),
    );

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
    const notices: SentNotice[0][] = [];
    const wakes: SentNotice[1][] = [];
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
      v: 2,
      op: "deliver",
      rid: "4".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      budgetMs: 15_000,
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
      v: 2,
      op: "deliver",
      rid: "5".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      budgetMs: 15_000,
      message: authored("6".repeat(32)),
    });
    await expect.poll(() => notices.length).toBe(1);
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
      v: 2,
      op: "deliver",
      rid: "7".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      budgetMs: 15_000,
      message,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(session.state.stats().inboxMessages).toBe(0);
    expect(notices).toHaveLength(1);
  });
  test("an unobserved wake notice is never replayed when more messages arrive", async () => {
    const fixture = await gateway(() => undefined);
    const notices: SentNotice[0][] = [];

    const session: AdapterSession = new AdapterSession(
      fixture.config,
      peer,
      {
        sendMessage: (message) => {
          notices.push(message);
        },
      },
      () => ({ isIdle: () => true, ui: { setStatus: () => undefined } }),
      () => {
        session.pumpIdle();
      },
    );

    cleanups.push(async () => {
      session.close();
    });
    await session.start();

    for (const [rid, id] of [
      ["4", "6"],
      ["5", "7"],
    ] as const) {
      fixture.sendFrame({
        v: 2,
        op: "deliver",
        rid: rid.repeat(32),
        from: other,
        to: peer,
        scopeId: "team",
        budgetMs: 15_000,
        message: authored(id.repeat(32)),
      });
    }

    await expect.poll(() => session.state.stats().inboxMessages).toBe(2);
    expect(notices).toHaveLength(1);
    expect(session.status().notice).toBe("submitted_unobserved");
  });
  test("a take that empties the inbox drops the pending wake, and a partial take keeps it", async () => {
    const fixture = await gateway(() => undefined);
    const notices: SentNotice[0][] = [];
    let idle = false;

    const session: AdapterSession = new AdapterSession(
      fixture.config,
      peer,
      {
        sendMessage: (message) => {
          notices.push(message);
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

    const deliver = (rid: string, id: string) => {
      fixture.sendFrame({
        v: 2,
        op: "deliver",
        rid: rid.repeat(32),
        from: other,
        to: peer,
        scopeId: "team",
        budgetMs: 15_000,
        message: authored(id.repeat(32)),
      });
    };

    deliver("4", "a");
    deliver("5", "b");
    await expect.poll(() => session.state.stats().inboxMessages).toBe(2);
    expect(session.take(1).messages).toHaveLength(1);
    expect(session.beforeSettle({ entries: [] })?.continue).toBe(true);
    deliver("6", "c");
    await expect.poll(() => session.state.stats().inboxMessages).toBe(2);
    expect(session.take(8).messages).toHaveLength(2);
    expect(session.beforeSettle({ entries: [] })).toBeUndefined();
    idle = true;
    session.pumpIdle();
    expect(notices).toHaveLength(0);
  });
  test("the footer follows unread mail and waits: ● on arrival, ✓ after take, waiting… while waiting", async () => {
    const fixture = await gateway(() => undefined);
    const footers: (string | undefined)[] = [];

    const session = new AdapterSession(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => ({
        isIdle: () => false,
        ui: {
          setStatus: (_key: string, text: string | undefined) => {
            footers.push(text);
          },
        },
      }),
      () => undefined,
    );

    cleanups.push(async () => {
      session.close();
    });
    await session.start();
    await expect.poll(() => footers.at(-1)).toBe("peers ✓");
    const waiting = session.waitForMessage(60);
    expect(footers.at(-1)).toBe("peers ✓ waiting…");
    fixture.sendFrame({
      v: 2,
      op: "deliver",
      rid: "4".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      budgetMs: 15_000,
      message: authored("a".repeat(32)),
    });
    await expect(waiting).resolves.toBe("message");
    expect(footers.at(-1)).toBe("peers ● 1");
    expect(session.take(8).messages).toHaveLength(1);
    expect(footers.at(-1)).toBe("peers ✓");
  });
  test("a wait returns on the first admission, allows one waiter, and ends on timeout or abort", async () => {
    const fixture = await gateway(() => undefined);

    const session = new AdapterSession(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => ({ isIdle: () => false, ui: { setStatus: () => undefined } }),
      () => undefined,
    );

    cleanups.push(async () => {
      session.close();
    });
    await session.start();
    await expect(session.waitForMessage(0.05)).resolves.toBe("timed_out");
    const controller = new AbortController();
    const aborted = session.waitForMessage(60, controller.signal);
    await expect(session.waitForMessage(60)).resolves.toBe("busy");
    controller.abort();
    await expect(aborted).resolves.toBe("cancelled");
    const waiting = session.waitForMessage(60);
    fixture.sendFrame({
      v: 2,
      op: "deliver",
      rid: "4".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      budgetMs: 15_000,
      message: authored("a".repeat(32)),
    });
    await expect(waiting).resolves.toBe("message");
    await expect(session.waitForMessage(60)).resolves.toBe("message");

    const closing = new AdapterSession(
      fixture.config,
      { ...peer, runtimeNonce: "9".repeat(32) },
      { sendMessage: () => undefined },
      () => undefined,
      () => undefined,
    );

    await expect(closing.waitForMessage(60)).resolves.toBe("disconnected");
    closing.close();
    await expect(closing.waitForMessage(60)).resolves.toBe("closed");
  });
  test("the wake notice names the sender but never carries the message body", async () => {
    const fixture = await gateway(() => undefined);
    const notices: SentNotice[0][] = [];

    const session: AdapterSession = new AdapterSession(
      fixture.config,
      peer,
      {
        sendMessage: (message) => {
          notices.push(message);
        },
      },
      () => ({ isIdle: () => true, ui: { setStatus: () => undefined } }),
      () => {
        session.pumpIdle();
      },
    );

    cleanups.push(async () => {
      session.close();
    });
    await session.start();
    fixture.sendFrame({
      v: 2,
      op: "deliver",
      rid: "4".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      budgetMs: 15_000,
      message: authored("a".repeat(32)),
    });
    await expect.poll(() => notices.length).toBe(1);
    const notice = Schema.decodeUnknownSync(Schema.String)(notices[0]?.content);
    expect(notice).toContain(sessionHandle(other.machineId, other.sessionId));
    expect(notice).toContain("peers_take");
    expect(notice).not.toContain(authored().content);
  });
  test("sessions track pushed link state and notify listeners only on change", async () => {
    const fixture = await gateway(() => undefined);

    const ensureGateway = vi
      .fn<EnsureGateway>()
      .mockResolvedValue({ gatewaySha256: "a".repeat(64) });

    const session = new AdapterSession(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => undefined,
      () => undefined,
      ensureGateway,
    );

    cleanups.push(async () => {
      session.close();
    });
    const seen: string[] = [];

    const stop = session.onLinkChange((links) => {
      seen.push(links.map((link) => `${link.machineId}:${link.state}`).join(","));
    });

    await session.reconnect();
    const register = fixture.requests[0];
    assert(register?.op === "register");
    expect(register).not.toHaveProperty("linkEvents");
    const base = { v: 2, op: "link.state", rid: register.rid, machineId: "beta" } as const;

    const down = {
      ...base,
      state: "down",
      since: 1_700_000_000_000,
      nextProbe: 1_700_000_030_000,
    } as const;

    fixture.sendFrame(down);
    await vi.waitFor(() => {
      expect(session.linkStates()).toStrictEqual([
        {
          machineId: "beta",
          state: "down",
          since: 1_700_000_000_000,
          nextProbe: 1_700_000_030_000,
        },
      ]);
    });
    expect(session.client.linkDown("beta")).toBe(true);
    expect(session.status().links).toHaveLength(1);
    fixture.sendFrame(down);
    fixture.sendFrame({ ...base, state: "up", since: 1_700_000_000_000 });
    await vi.waitFor(() => {
      expect(session.client.linkDown("beta")).toBe(false);
    });
    expect(seen).toStrictEqual(["beta:down", "beta:up"]);
    stop();
    fixture.drop();
    await vi.waitFor(() => {
      expect(session.linkStates()).toStrictEqual([]);
    });
    expect(seen).toHaveLength(2);
  });
  test("a link state for another registration closes the connection", async () => {
    const fixture = await gateway(() => undefined);

    const session = new AdapterSession(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => undefined,
      () => undefined,
      vi.fn<EnsureGateway>().mockResolvedValue({ gatewaySha256: "a".repeat(64) }),
    );

    cleanups.push(async () => {
      session.close();
    });
    await session.reconnect();
    fixture.sendFrame({
      v: 2,
      op: "link.state",
      rid: "f".repeat(32),
      machineId: "beta",
      state: "down",
      since: 1,
    });
    await vi.waitFor(() => {
      expect(fixture.connections()).toBe(2);
    });
    expect(session.linkStates()).toStrictEqual([]);
  });
  test("a wait ends as disconnected when the gateway connection drops", async () => {
    const fixture = await gateway(() => undefined);

    const session = new AdapterSession(
      fixture.config,
      peer,
      { sendMessage: () => undefined },
      () => ({ isIdle: () => false, ui: { setStatus: () => undefined } }),
      () => undefined,
    );

    cleanups.push(async () => {
      session.close();
    });
    await session.start();
    const waiting = session.waitForMessage(60);
    fixture.drop();
    await expect(waiting).resolves.toBe("disconnected");
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
      v: 2,
      op: "roster.event",
      rid: "f".repeat(32),
      event: { tag: "remove", peer: other },
    });
    fixture.sendFrame({
      v: 2,
      op: "roster.event",
      rid: request.rid,
      event: { tag: "remove", peer: other },
    });
    await expect
      .poll(async () => client.discover(["team"], true))
      .toMatchObject({ outcome: { value: { peers: [] } } });
    fixture.sendFrame({
      v: 2,
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
      v: 2,
      op: "roster.event",
      rid: request.rid,
      event: { tag: "invalidated", reason: "policy_changed" },
    });
    await expect.poll(() => client.status().watching).toBe(false);
    await client.discover(["team"], true);
    expect(fixture.requests.filter((item) => item.op === "discover")).toHaveLength(2);
    expect(client.status().operations).toBe(0);
    client.close();
    await expect(client.send(other, "team", authored())).resolves.toMatchObject({
      code: "cancelled",
    });
    await expect(
      client.request({
        v: 2,
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
      v: 2,
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
          v: 2,
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
            v: 2,
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
      connection.request({ v: 2, op: "close", rid: "a".repeat(32) }, performance.now() + 60_000),
    ).rejects.toMatchObject({ code: "overloaded", possible: false });
    abort.abort();
    await expect(Promise.all(pending)).resolves.toStrictEqual(
      Array.from({ length: 8 }, () => "Session communication cancelled"),
    );
    expect(connection.pendingCount()).toBe(0);
    await expect(
      connection.request(
        { v: 2, op: "close", rid: "a".repeat(32) },
        performance.now() + 60_000,
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      connection.request({ v: 2, op: "close", rid: "a".repeat(32) }, performance.now() - 1),
    ).rejects.toMatchObject({ code: "unavailable" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    try {
      const unanswered = connection
        .request({ v: 2, op: "close", rid: "b".repeat(32) }, performance.now() + 10)
        .then(() => undefined, Schema.decodeUnknownSync(Schema.instanceOf(Error)));

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
      v: 2,
      op: "result",
      rid: "b".repeat(32),
      forOp: "close",
      outcome: { tag: "ok", value: {} },
    });
    fixture.raw(Buffer.from([0, 0, 0, 0]));
    await expect.poll(() => disconnected).toEqual(["protocol_error"]);
    await expect(
      connection.request({ v: 2, op: "close", rid: "c".repeat(32) }, performance.now() + 60_000),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  test("adapter answers forwarded state and interest requests with forbidden, without wakes", async () => {
    const fixture = await gateway(() => undefined);
    const notices: SentNotice[0][] = [];

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
    const work = { kind: "publication" as const, publisher: peer, key: "report" };
    fixture.sendFrame({
      v: 2,
      op: "state.get",
      rid: "a".repeat(32),
      from: other,
      publisher: peer,
      scopeId: "team",
      key: "report",
      expectedRevision: 1,
    });
    fixture.sendFrame({
      v: 2,
      op: "state.list",
      rid: "b".repeat(32),
      from: other,
      publisher: peer,
      scopeId: "team",
    });
    fixture.sendFrame({
      v: 2,
      op: "interest.add",
      rid: "c".repeat(32),
      from: other,
      publisher: peer,
      scopeId: "team",
      work,
    });
    fixture.sendFrame({
      v: 2,
      op: "interest.remove",
      rid: "d".repeat(32),
      from: other,
      publisher: peer,
      scopeId: "team",
      work,
    });
    fixture.sendFrame({
      v: 2,
      op: "state.list",
      rid: "e".repeat(32),
      from: other,
      publisher: other,
      scopeId: "team",
    });
    await expect.poll(() => fixture.replies.length).toBe(5);
    expect(fixture.replies.map((reply) => [reply.forOp, reply.outcome])).toStrictEqual(
      ["state.get", "state.list", "interest.add", "interest.remove", "state.list"].map((op) => [
        op,
        { tag: "error", code: "forbidden" },
      ]),
    );
    expect(notices).toHaveLength(0);
    session.afterCompaction(true);
    session.afterCompaction();
    session.afterCompaction();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(notices).toHaveLength(0);
    fixture.raw(Buffer.from(encodeFrame({ v: 2, op: "ping", rid: "f".repeat(32) }, "remote-link")));
    await expect.poll(() => session.client.status().connected).toBe(false);
    session.close();
    session.afterCompaction();
    expect(session.beforeSettle({ entries: [] })).toBeUndefined();
  });
});
