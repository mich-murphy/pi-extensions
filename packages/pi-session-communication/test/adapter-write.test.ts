import assert from "node:assert/strict";
import { Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sendWithRetries } from "../adapter/send.js";
import { connectTransport } from "../adapter/transport.js";
import type { Reply, Request } from "../adapter/transport.js";
import type { Frame } from "../protocol/schema.js";
import { encodeFrame } from "../protocol/wire.js";

/** A real Node Writable with a deliberately blocked transport completion callback. */
class BlockedSocket extends Socket {
  readonly chunks: Buffer[] = [];
  private complete: ((error?: Error | null) => void) | undefined;
  override _write(
    bytes: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(bytes));
    this.complete = callback;
  }
  release(error?: Error): void {
    const callback = this.complete;
    assert(callback !== undefined);
    this.complete = undefined;
    callback(error);
  }
}
const peer = { machineId: "alpha", sessionId: "sender", runtimeNonce: "1".repeat(32) };
const other = { machineId: "alpha", sessionId: "receiver", runtimeNonce: "2".repeat(32) };
function readRequest(index: number): Request {
  return {
    v: 1,
    op: "state.get",
    rid: index.toString(16).padStart(32, "0"),
    from: peer,
    publisher: other,
    scopeId: "team",
    key: "report",
  };
}
function readReply(request: Request): Reply {
  assert(request.op === "state.get");
  return {
    v: 1,
    op: "result",
    rid: request.rid,
    forOp: "state.get",
    outcome: {
      tag: "ok",
      value: {
        publisher: other,
        scopeId: "team",
        publication: {
          key: "report",
          revision: 1,
          category: "context",
          title: "report",
          summary: "authored",
          content: "x".repeat(15_000),
          format: "text",
          preparation: "authored",
        },
      },
    },
  };
}
function deliver(socket: Socket, frame: Frame): void {
  socket.emit("data", Buffer.from(encodeFrame(frame, "adapter-delivery")));
}
function sending(rid: string): Request {
  return {
    v: 1,
    op: "send",
    rid,
    to: other,
    scopeId: "team",
    message: { id: "3".repeat(32), kind: "update", content: "authored", format: "text" },
  };
}
async function fixture() {
  const socket = new BlockedSocket();
  const disconnected: string[] = [];
  const connecting = connectTransport(
    {
      socketPath: "/unused/callback-seam.sock",
      deadline: performance.now() + 5000,
      incoming: readReply,
      event: () => undefined,
      validateReply: () => undefined,
      disconnected: (code) => {
        disconnected.push(code);
      },
    },
    () => socket,
  );
  socket.emit("connect");
  const connection = await connecting;
  return { socket, connection, disconnected };
}

describe("bounded transport write completion and absolute progress deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  test("control replies without a pending request expire after exactly five seconds; quiet streams do not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { socket, connection, disconnected } = await fixture();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(disconnected).toStrictEqual([]);
    deliver(socket, readRequest(1));
    expect(connection.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4999);
    expect(disconnected).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnected).toStrictEqual(["unavailable"]);
    expect(socket.destroyed).toBe(true);
    connection.close();
  });
  test("newly queued traffic cannot slide the oldest blocked write's deadline or erase admission uncertainty", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { socket, connection, disconnected } = await fixture();
    const outcome = sendWithRetries({
      sender: peer,
      recipient: other,
      scopeId: "team",
      message: { id: "3".repeat(32), kind: "update", content: "authored", format: "text" },
      request: async (rid, deadline) => connection.request(sending(rid), deadline),
    });
    await vi.advanceTimersByTimeAsync(4000);
    deliver(socket, readRequest(2));
    await vi.advanceTimersByTimeAsync(999);
    expect(disconnected).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnected).toStrictEqual(["unavailable"]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toMatchObject({ tag: "unknown", code: "unavailable" });
    connection.close();
  });
  test("control flooding hits its independent 32KiB ceiling, far below total connection capacity", async () => {
    const { socket, connection, disconnected } = await fixture();
    deliver(socket, readRequest(1));
    deliver(socket, readRequest(2));
    expect(socket.writableLength).toBeLessThan(32_768);
    expect(disconnected).toStrictEqual([]);
    deliver(socket, readRequest(3));
    expect(disconnected).toHaveLength(1);
    expect(socket.destroyed).toBe(true);
    connection.close();
  });
  test("actual completion releases control bytes and advances to the next original deadline, not a fresh five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { socket, connection, disconnected } = await fixture();
    deliver(socket, readRequest(1));
    await vi.advanceTimersByTimeAsync(1000);
    deliver(socket, readRequest(2));
    await vi.advanceTimersByTimeAsync(3000);
    socket.release();
    await vi.advanceTimersByTimeAsync(0);
    deliver(socket, readRequest(3));
    expect(disconnected).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(disconnected).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnected).toStrictEqual(["unavailable"]);
    connection.close();
  });
  test("caller cancellation retires pending requests but cannot free still-blocked ordinary byte charges", async () => {
    const { socket, connection, disconnected } = await fixture();
    const abort = new AbortController();
    const requests = Array.from({ length: 8 }, async (_, index) => {
      const request = sending(index.toString(16).padStart(32, "0"));
      assert(request.op === "send");
      return connection
        .request(
          { ...request, message: { ...request.message, content: "x".repeat(24_000) } },
          performance.now() + 15_000,
          abort.signal,
        )
        .catch((error: unknown) => error);
    });
    abort.abort();
    await expect(Promise.all(requests)).resolves.toHaveLength(8);
    expect(connection.pendingCount()).toBe(0);
    const ninth = sending("a".repeat(32));
    assert(ninth.op === "send");
    const nextAbort = new AbortController();
    const ninthWait = connection
      .request(
        { ...ninth, message: { ...ninth.message, content: "x".repeat(24_000) } },
        performance.now() + 15_000,
        nextAbort.signal,
      )
      .catch((error: unknown) => error);
    nextAbort.abort();
    await expect(ninthWait).resolves.toMatchObject({ code: "cancelled", possible: true });
    await expect(
      connection.request(
        {
          ...ninth,
          rid: "b".repeat(32),
          message: { ...ninth.message, content: "x".repeat(24_000) },
        },
        performance.now() + 15_000,
      ),
    ).rejects.toMatchObject({ code: "overloaded", possible: false });
    deliver(socket, readRequest(20));
    deliver(socket, readRequest(21));
    expect(disconnected).toStrictEqual([]);
    expect(socket.writableLength).toBeLessThanOrEqual(262_144);
    connection.close();
    socket.release();
    expect(disconnected).toStrictEqual(["cancelled"]);
  });
  test("write completion errors close all waiting operations with possible admission intact", async () => {
    const { socket, connection, disconnected } = await fixture();
    const request = connection.request(sending("a".repeat(32)), performance.now() + 15_000);
    socket.release(new Error("synthetic blocked write failure"));
    await expect(request).rejects.toMatchObject({ code: "unavailable", possible: true });
    expect(disconnected).toStrictEqual(["unavailable"]);
    expect(connection.pendingCount()).toBe(0);
    connection.close();
  });
  test("fully completed writes cancel the progress timer and restore a quiet connection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { socket, connection, disconnected } = await fixture();
    deliver(socket, readRequest(1));
    await vi.advanceTimersByTimeAsync(4000);
    socket.release();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(disconnected).toStrictEqual([]);
    deliver(socket, readRequest(2));
    expect(disconnected).toStrictEqual([]);
    connection.close();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(disconnected).toStrictEqual(["cancelled"]);
  });
});
