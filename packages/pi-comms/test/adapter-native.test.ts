import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import type { Configuration } from "../adapter/config.js";
import { createAdapterRuntime } from "../adapter/runtime.js";
import { freshId } from "../adapter/transport.js";
import type { Frame, Message } from "../protocol/schema.js";
import { decodeFrame, frameBodyLength } from "../protocol/wire.js";

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

function host() {
  return { isIdle: () => true, ui: { setStatus: () => undefined } };
}
async function readinessLine(child: ChildProcess, signal: AbortSignal): Promise<string> {
  assert(child.stdout !== null);
  let bytes = Buffer.alloc(0);
  while (!bytes.includes(10)) {
    const chunk: unknown[] = await once(child.stdout, "data", { signal });
    assert(Buffer.isBuffer(chunk[0]));
    bytes = Buffer.concat([bytes, chunk[0]]);
    assert(bytes.length <= 4096, "Bounded readiness record");
  }
  return bytes.subarray(0, bytes.indexOf(10)).toString("utf8");
}
function isAdmittedSend(frame: Frame): boolean {
  if (frame.op !== "result" || frame.forOp !== "send") {
    return false;
  }
  return frame.outcome.tag === "admitted";
}
async function receiptLossProxy(config: Configuration, onLoss: () => void) {
  const socketPath = join(config.socketPath, "..", "loss.sock");
  const sockets = new Set<Socket>();
  let lost = false;
  const server = createServer((client) => {
    const upstream = createConnection(config.socketPath);
    sockets.add(client);
    sockets.add(upstream);
    client.on("error", () => {
      upstream.destroy();
    });
    upstream.on("error", () => {
      client.destroy();
    });
    client.on("close", () => {
      upstream.destroy();
    });
    upstream.on("close", () => {
      client.destroy();
    });
    client.pipe(upstream);
    let buffer = Buffer.alloc(0);
    const forward = (bytes: Buffer) => {
      if (!lost && isAdmittedSend(decodeFrame(bytes, "adapter-delivery"))) {
        lost = true;
        onLoss();
        client.destroy();
        upstream.destroy();
        return;
      }
      client.write(bytes);
    };
    upstream.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = frameBodyLength(buffer.subarray(0, 4)) + 4;
        if (buffer.length < length) {
          return;
        }
        forward(Buffer.from(buffer.subarray(0, length)));
        buffer = Buffer.from(buffer.subarray(length));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    config: { ...config, socketPath },
    close: async () => {
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
async function nativeGateway() {
  // Canonical private directory is required by the native gateway, including on macOS /var.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "psc-native-")));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "gateway.sock");
  const configPath = join(directory, "gateway.json");
  const policies = [
    {
      machineId: "alpha",
      scopeId: "team",
      permissions: ["discover", "read", "push", "interest"] as const,
    },
  ];
  await writeFile(
    configPath,
    JSON.stringify({ machineId: "alpha", socketPath, scopeIds: ["team"], policies }),
  );
  const binary =
    process.env.PI_SESSION_GATEWAY_BINARY ??
    fileURLToPath(new URL("../gateway/target/debug/pi-gateway", import.meta.url));
  const child = spawn(binary, ["--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RAYON_NUM_THREADS: "2", OMP_NUM_THREADS: "2" },
  });
  assert(child.stdout !== null);
  let diagnostic = "";
  child.stderr?.on("data", (bytes: Buffer) => {
    diagnostic = (diagnostic + bytes.toString("utf8")).slice(-4096);
  });
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, 5000);
  child.once("error", () => {
    abort.abort();
  });
  try {
    const line = await readinessLine(child, abort.signal);
    const value: unknown = JSON.parse(line);
    assert.deepEqual(value, { event: "ready", socketPath, machineId: "alpha" });
  } catch (error) {
    await stop(child);
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `Native gateway did not become ready. Build the locked gateway before this mandatory integration gate. ${diagnostic}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  const config: Configuration = {
    machineId: "alpha",
    socketPath,
    scopeIds: ["team"],
    label: "native adapter",
    policies,
  };
  return {
    config,
    close: async () => {
      await stop(child);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("production adapter / native local gateway vertical slice", () => {
  test("routes exact runtimes, bound receipts, publications and interests without replay or read wakes", async () => {
    const gateway = await nativeGateway();
    const sender = { machineId: "alpha", sessionId: "sender", runtimeNonce: freshId() };
    const receiver = { machineId: "alpha", sessionId: "receiver", runtimeNonce: freshId() };
    const notices: { customType: string; details?: unknown }[] = [];
    const left = await createAdapterRuntime(
      gateway.config,
      sender,
      { sendMessage: () => undefined },
      host,
    );
    const right = await createAdapterRuntime(
      gateway.config,
      receiver,
      {
        sendMessage: (notice) => {
          notices.push(notice);
        },
      },
      host,
    );
    try {
      await Promise.all([left.session.reconnect(), right.session.reconnect()]);
      const roster = await left.session.client.discover(["team"], true);
      assert(roster.forOp === "discover");
      assert(roster.outcome.tag === "ok");
      expect(roster.outcome.value.watching).toBe(true);
      expect(roster.outcome.value.peers.map((descriptor) => descriptor.peer)).toContainEqual(
        receiver,
      );
      const message: Message = {
        id: freshId(),
        kind: "request",
        content: "Explicitly authored native integration request",
        format: "text",
      };
      const admitted = await left.session.send(receiver, "team", message);
      expect(admitted).toMatchObject({
        tag: "admitted",
        binding: { sender, recipient: receiver, messageId: message.id, scopeId: "team" },
      });
      await expect.poll(() => notices.length).toBe(1);
      await expect(left.session.send(receiver, "team", message)).resolves.toStrictEqual(admitted);
      await expect(
        left.session.send(receiver, "team", { ...message, content: "conflicting content" }),
      ).resolves.toMatchObject({ tag: "not_admitted", code: "id_conflict" });
      expect(right.session.state.stats()).toMatchObject({ inboxMessages: 1, receipts: 1 });
      const taken = right.session.take(8);
      expect(taken.messages).toHaveLength(1);
      expect(taken.messages[0]).toMatchObject({
        from: sender,
        to: receiver,
        scopeId: "team",
        message,
      });
      expect(right.session.status().notice).toBe("submitted_unobserved");
      right.session.observed({
        role: "custom",
        customType: "session-communication-wake",
        details: notices[0]?.details,
      });
      expect(right.session.status().notice).toBe("none");
      const work = { kind: "request" as const, origin: sender, requestId: message.id };
      const record = {
        category: "work" as const,
        title: "Native report",
        summary: "Authored progress",
        format: "text" as const,
        preparation: "authored" as const,
        work,
        status: "in_progress" as const,
      };
      expect(right.session.state.publish({ scopeId: "team", key: "report", record })).toMatchObject(
        { tag: "ok" },
      );
      await expect(
        left.session.client.request({
          v: 1,
          op: "state.get",
          rid: freshId(),
          publisher: receiver,
          scopeId: "team",
          key: "report",
          expectedRevision: 1,
        }),
      ).resolves.toMatchObject({
        outcome: { tag: "ok", value: { publisher: receiver, publication: { revision: 1 } } },
      });
      await expect(
        left.session.client.request({
          v: 1,
          op: "state.list",
          rid: freshId(),
          publisher: receiver,
          scopeId: "team",
        }),
      ).resolves.toMatchObject({ outcome: { tag: "ok", value: { items: [{ key: "report" }] } } });
      await expect(
        left.session.client.request({
          v: 1,
          op: "interest.add",
          rid: freshId(),
          publisher: receiver,
          scopeId: "team",
          work,
        }),
      ).resolves.toMatchObject({ outcome: { tag: "ok", value: { active: true } } });
      expect(notices).toHaveLength(1);
      await expect(
        right.session.report({
          scopeId: "team",
          key: "report",
          record: { ...record, status: "completed" },
          notify: "interested",
        }),
      ).resolves.toMatchObject({
        tag: "ok",
        value: {
          publication: { revision: 2 },
          pushes: [{ recipient: sender, outcome: { tag: "admitted" } }],
        },
      });
      expect(left.session.take(8).messages).toHaveLength(1);
      expect(right.session.client.status().operations).toBe(0);
      const proxy = await receiptLossProxy(gateway.config, () => {
        right.session.close();
      });
      const lostSender = { ...sender, sessionId: "lost-sender", runtimeNonce: freshId() };
      const uncertain = new GatewayClient({
        config: proxy.config,
        peer: lostSender,
        incoming: () => {
          throw new Error("No incoming proxy test operations");
        },
        statusChanged: () => undefined,
      });
      try {
        const lostMessage: Message = { ...message, id: freshId(), kind: "update" };
        await expect(uncertain.send(receiver, "team", lostMessage)).resolves.toMatchObject({
          tag: "unknown",
          code: "unavailable",
        });
        expect(right.session.state.stats().receipts).toBe(2);
        expect(right.session.state.stats().inboxMessages).toBe(1);
      } finally {
        uncertain.close();
        await proxy.close();
      }
      await right.dispose();
      await expect(
        left.session.send(receiver, "team", { ...message, id: freshId() }),
      ).resolves.toMatchObject({ tag: "not_admitted", code: "no_route" });
      // The dropped receipt still followed a genuinely admitted fresh push and one fresh wake.
      expect(notices).toHaveLength(2);
    } finally {
      await Promise.all([left.dispose(), right.dispose()]);
      await gateway.close();
    }
  }, 15_000);
});
