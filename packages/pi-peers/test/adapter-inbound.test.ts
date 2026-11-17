import { Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { connectTransport } from "../adapter/transport.js";
import type { Frame } from "../protocol/schema.js";
import { encodeFrame } from "../protocol/wire.js";

const INBOUND_BUFFER_LIMIT = 262_144;

/** One small fixed-shape inbound frame; `sessionIdLength` (1-256) sets its encoded size. */
function rosterRemoval(sessionIdLength: number): Uint8Array {
  const frame: Frame = {
    v: 1,
    op: "roster.event",
    rid: "f".repeat(32),
    event: {
      tag: "remove",
      peer: {
        machineId: "alpha",
        sessionId: "s".repeat(sessionIdLength),
        runtimeNonce: "1".repeat(32),
      },
    },
  };
  return encodeFrame(frame, "adapter-delivery");
}
/** Valid frames whose encoded sizes add up to exactly `total` bytes. */
function framesTotalling(total: number): Uint8Array[] {
  const smallest = rosterRemoval(1).length;
  const largest = rosterRemoval(256).length;
  const frames: Uint8Array[] = [];
  let remaining = total;
  while (remaining > 0) {
    let size = largest;
    if (remaining <= largest) {
      size = remaining;
    } else if (remaining - largest < smallest) {
      size = remaining - smallest;
    }
    frames.push(rosterRemoval(size - smallest + 1));
    remaining -= size;
  }
  expect(frames.reduce((sum, frame) => sum + frame.length, 0)).toBe(total);
  return frames;
}
async function fixture() {
  const socket = new Socket();
  const disconnected: string[] = [];
  const events: Frame[] = [];
  const connecting = connectTransport(
    {
      socketPath: "/unused/inbound-seam.sock",
      deadline: performance.now() + 5000,
      incoming: () => {
        throw new Error("No peer request is expected");
      },
      event: (event) => {
        events.push(event);
      },
      validateReply: () => undefined,
      disconnected: (code) => {
        disconnected.push(code);
      },
    },
    () => socket,
  );
  socket.emit("connect");
  const connection = await connecting;
  const receive = (bytes: Uint8Array) => socket.emit("data", Buffer.from(bytes));
  return { socket, connection, disconnected, events, receive };
}

describe("inbound frame assembly and buffer bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  test("a partial frame closes the connection exactly five seconds after its first byte, however many chunks trickle in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { socket, connection, disconnected, receive } = await fixture();
    const frame = rosterRemoval(40);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(disconnected).toStrictEqual([]);
    receive(frame.subarray(0, 3));
    await vi.advanceTimersByTimeAsync(3000);
    receive(frame.subarray(3, 20));
    await vi.advanceTimersByTimeAsync(1999);
    expect(disconnected).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnected).toStrictEqual(["unavailable"]);
    expect(socket.destroyed).toBe(true);
    connection.close();
  });
  test("a frame that completes in time cancels the timer, and a trailing partial frame starts its own five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { connection, disconnected, events, receive } = await fixture();
    const first = rosterRemoval(40);
    const second = rosterRemoval(41);
    receive(first.subarray(0, 10));
    await vi.advanceTimersByTimeAsync(3000);
    receive(Buffer.concat([first.subarray(10), second.subarray(0, 6)]));
    expect(events).toHaveLength(1);
    // The first frame's window (ending at 5 s) no longer applies; the leftover has its own.
    await vi.advanceTimersByTimeAsync(4999);
    expect(disconnected).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnected).toStrictEqual(["unavailable"]);
    connection.close();
  });
  test("a complete frame leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const { connection, disconnected, events, receive } = await fixture();
    receive(rosterRemoval(40));
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(disconnected).toStrictEqual([]);
    connection.close();
  });
  test("one read of exactly 256 KiB is processed and one byte more is a protocol error", async () => {
    const accepted = await fixture();
    const frames = framesTotalling(INBOUND_BUFFER_LIMIT);
    accepted.receive(Buffer.concat(frames));
    expect(accepted.disconnected).toStrictEqual([]);
    expect(accepted.events).toHaveLength(frames.length);
    accepted.connection.close();
    const overfull = await fixture();
    overfull.receive(Buffer.concat([...framesTotalling(INBOUND_BUFFER_LIMIT), Buffer.from([0])]));
    expect(overfull.disconnected).toStrictEqual(["protocol_error"]);
    expect(overfull.events).toHaveLength(0);
    expect(overfull.socket.destroyed).toBe(true);
  });
});
