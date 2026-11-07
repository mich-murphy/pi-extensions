import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import type { Frame } from "../protocol/schema.js";
import { decodeFrame, encodeFrame, frameBodyLength } from "../protocol/wire.js";

export function freshId(): string {
  return randomBytes(16).toString("hex");
}
export type Request = Exclude<Frame, { op: "result" | "roster.event" }>;
export type Reply = Extract<Frame, { op: "result" }>;
export class ConnectionFailure extends Error {
  constructor(
    readonly code: "unavailable" | "protocol_error" | "cancelled" | "overloaded",
    readonly possible: boolean,
  ) {
    super(`Session communication ${code}`);
  }
}
type QueuedWrite = { bytes: number; control: boolean; deadline: number };
type Pending = {
  request: Request;
  resolve: (reply: Reply) => void;
  reject: (error: ConnectionFailure) => void;
  cleanup: () => void;
  possible: boolean;
};
export type Connection = {
  request: (request: Request, deadline: number, signal?: AbortSignal) => Promise<Reply>;
  close: () => void;
  pendingCount: () => number;
};
/** One generation of one local Unix connection. No global parser, mailbox, or replay queue. */
export async function connectTransport(
  options: {
    socketPath: string;
    deadline: number;
    signal?: AbortSignal;
    incoming: (request: Request) => Reply;
    event: (event: Extract<Frame, { op: "roster.event" }>) => void;
    disconnected: (code: ConnectionFailure["code"]) => void;
    validateReply: (request: Request, reply: Reply) => void;
  },
  openSocket: (path: string) => Socket = createConnection,
): Promise<Connection> {
  const pending = new Map<string, Pending>();
  let buffer = Buffer.alloc(0);
  let assemblyTimer: ReturnType<typeof setTimeout> | undefined;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  const writes = new Set<QueuedWrite>();
  let ordinaryBytes = 0;
  let controlBytes = 0;
  let closed = false;
  let ready = false;
  const socket = openSocket(options.socketPath);
  const fail = (code: ConnectionFailure["code"]) => {
    if (closed) {
      return;
    }
    closed = true;
    clearTimeout(assemblyTimer);
    clearTimeout(writeTimer);
    writes.clear();
    ordinaryBytes = 0;
    controlBytes = 0;
    buffer = Buffer.alloc(0);
    socket.destroy();
    for (const operation of pending.values()) {
      operation.cleanup();
      operation.reject(new ConnectionFailure(code, operation.possible));
    }
    pending.clear();
    if (ready) {
      options.disconnected(code);
    }
  };
  const scheduleWriteDeadline = () => {
    clearTimeout(writeTimer);
    writeTimer = undefined;
    const oldest = writes.values().next().value;
    if (oldest === undefined) {
      return;
    }
    // Completion of another write must never extend this write's original deadline.
    const remaining = oldest.deadline - performance.now();
    if (remaining <= 0) {
      fail("unavailable");
      return;
    }
    writeTimer = setTimeout(() => {
      fail("unavailable");
    }, remaining);
  };
  const releaseWrite = (record: QueuedWrite) => {
    if (!writes.delete(record)) {
      return;
    }
    if (record.control) {
      controlBytes -= record.bytes;
    } else {
      ordinaryBytes -= record.bytes;
    }
    scheduleWriteDeadline();
  };
  const write = (frame: Frame, control: boolean, operation?: Pending) => {
    const encoded = encodeFrame(frame, frame.op === "result" ? "adapter-delivery" : "local-client");
    const available = control ? 32_768 - controlBytes : 229_376 - ordinaryBytes;
    if (
      closed ||
      encoded.length > available ||
      ordinaryBytes + controlBytes + encoded.length > 262_144
    ) {
      throw new ConnectionFailure(closed ? "unavailable" : "overloaded", false);
    }
    // Charge until the actual Writable completion callback, not write()'s boolean return,
    // request retirement or a drain event. Bytes also bound the number of retained records.
    const record = { bytes: encoded.length, control, deadline: performance.now() + 5000 };
    writes.add(record);
    if (control) {
      controlBytes += record.bytes;
    } else {
      ordinaryBytes += record.bytes;
    }
    if (writes.size === 1) {
      scheduleWriteDeadline();
    }
    if (operation !== undefined) {
      operation.possible = true;
    }
    try {
      socket.write(encoded, (error) => {
        if (error !== null && error !== undefined) {
          fail("unavailable");
          return;
        }
        releaseWrite(record);
      });
    } catch {
      fail("unavailable");
      throw new ConnectionFailure("unavailable", true);
    }
  };
  const receive = (frame: Frame) => {
    if (frame.op === "result") {
      const operation = pending.get(frame.rid);
      if (operation === undefined) {
        return;
      }
      options.validateReply(operation.request, frame);
      pending.delete(frame.rid);
      operation.cleanup();
      operation.resolve(frame);
    } else if (frame.op === "roster.event") {
      options.event(frame);
    } else {
      write(options.incoming(frame), true);
    }
  };
  socket.on("error", () => {
    fail("unavailable");
  });
  socket.on("close", () => {
    fail("unavailable");
  });
  socket.on("data", (chunk: Buffer) => {
    try {
      if (buffer.length + chunk.length > 262_144) {
        throw new Error("Buffer limit");
      }
      if (buffer.length === 0) {
        assemblyTimer = setTimeout(() => {
          fail("unavailable");
        }, 5000);
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const total = frameBodyLength(buffer.subarray(0, 4)) + 4;
        if (buffer.length < total) {
          break;
        }
        const bytes = buffer.subarray(0, total);
        receive(decodeFrame(bytes, "adapter-delivery"));
        buffer = Buffer.from(buffer.subarray(total));
        clearTimeout(assemblyTimer);
        assemblyTimer =
          buffer.length === 0
            ? undefined
            : setTimeout(() => {
                fail("unavailable");
              }, 5000);
      }
    } catch (error) {
      fail(error instanceof ConnectionFailure ? error.code : "protocol_error");
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        finish(new ConnectionFailure("unavailable", false));
      },
      Math.max(1, Math.min(5000, options.deadline - performance.now())),
    );
    const aborted = () => {
      finish(new ConnectionFailure("cancelled", false));
    };
    const failed = () => {
      finish(new ConnectionFailure("unavailable", false));
    };
    const connected = () => {
      finish();
    };
    function finish(error?: ConnectionFailure): void {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      socket.off("error", failed);
      socket.off("connect", connected);
      if (error === undefined) {
        ready = true;
        resolve();
      } else {
        fail(error.code);
        reject(error);
      }
    }
    socket.once("error", failed);
    socket.once("connect", connected);
    if (options.signal?.aborted === true) {
      aborted();
    } else {
      options.signal?.addEventListener("abort", aborted, { once: true });
    }
  });
  return {
    request: async (request, deadline, signal) =>
      new Promise<Reply>((resolve, reject) => {
        if (
          closed ||
          signal?.aborted === true ||
          deadline <= performance.now() ||
          pending.size >= 8
        ) {
          let code: ConnectionFailure["code"] = "unavailable";
          if (signal?.aborted === true) {
            code = "cancelled";
          } else if (pending.size >= 8) {
            code = "overloaded";
          }
          reject(new ConnectionFailure(code, false));
          return;
        }
        const timer = setTimeout(
          () => {
            finish("unavailable");
          },
          Math.max(1, deadline - performance.now()),
        );
        const aborted = () => {
          finish("cancelled");
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
        };
        function finish(code: ConnectionFailure["code"]): void {
          const operation = pending.get(request.rid);
          if (operation === undefined) {
            return;
          }
          pending.delete(request.rid);
          cleanup();
          reject(new ConnectionFailure(code, operation.possible));
        }
        const operation: Pending = { request, resolve, reject, cleanup, possible: false };
        pending.set(request.rid, operation);
        signal?.addEventListener("abort", aborted, { once: true });
        try {
          write(request, request.op === "register" || request.op === "close", operation);
        } catch (error) {
          pending.delete(request.rid);
          cleanup();
          reject(
            error instanceof ConnectionFailure
              ? error
              : new ConnectionFailure("protocol_error", false),
          );
        }
      }),
    close: () => {
      fail("cancelled");
    },
    pendingCount: () => pending.size,
  };
}
