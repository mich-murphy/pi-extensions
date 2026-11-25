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
import type { ToolArguments } from "../adapter/tools.js";
import type { Request } from "../adapter/transport.js";
import type { Frame } from "../protocol/schema.js";
import { decodeFrame, encodeFrame, frameBodyLength } from "../protocol/wire.js";
import { toolRecorder } from "./adapter-tool-fixture.js";

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
        if (
          request.op === "result" ||
          request.op === "roster.event" ||
          request.op === "link.state"
        ) {
          continue;
        }
        log.push(request);
        if (request.op === "register") {
          socket.write(
            encodeFrame(
              {
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

async function tool(tools: ReturnType<typeof toolRecorder>, name: string, args: ToolArguments) {
  const result = await tools.run(name, args, new AbortController().signal);
  return { value: result.details.value, isError: result.isError === true };
}

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
        permissions: ["discover", "push"],
      },
      { machineId: "beta", scopeId: "extra", permissions: ["discover"] },
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
  const tools = toolRecorder();
  registerTools(tools, () => session);
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
      v: 2,
      op: "deliver",
      rid: "4".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      budgetMs: 15_000,
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
    const taken = await tool(fx.tools, "peers_take", {});
    expect(taken).toMatchObject({
      isError: false,
      value: { messages: [{ messageId: "3".repeat(32), kind: "update", content: "c" }] },
    });
    await expect(tool(fx.tools, "peers_take", {})).resolves.toMatchObject({
      value: { messages: [] },
    });
    expect(fx.ensure.mock.calls).toHaveLength(ensureBefore);
    expect(fx.log).toHaveLength(requestsBefore);
  }, 30_000);

  test("manually configured runtime (no ensureGateway): offline local tools work", async () => {
    const fx = await setup(["team"], false);
    fx.server().send({
      v: 2,
      op: "deliver",
      rid: "6".repeat(32),
      from: other,
      to: peer,
      scopeId: "team",
      budgetMs: 15_000,
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
    await expect(tool(fx.tools, "peers_take", {})).resolves.toMatchObject({
      isError: false,
      value: { messages: [{ messageId: "7".repeat(32) }] },
    });
    await expect(tool(fx.tools, "peers_take", {})).resolves.toMatchObject({
      value: { messages: [] },
    });
    expect(fx.ensure).not.toHaveBeenCalled();
    expect(fx.log).toHaveLength(requestsBefore);
    expect(fx.session.client.status().connected).toBe(false);
  }, 30_000);

  test("closed session fails closed for local tools", async () => {
    const fx = await setup(["team"]);
    fx.session.close();
    await expect(tool(fx.tools, "peers_take", {})).resolves.toMatchObject({
      isError: true,
      value: { code: "cancelled" },
    });
  });
});
