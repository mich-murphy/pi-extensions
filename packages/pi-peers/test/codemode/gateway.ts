/** SIMULATED gateway: a synthetic transport fixture speaking the real framing. Not the native gateway. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Frame, PeerRef } from "../../protocol/schema.js";
import { decodeFrame, encodeFrame, frameBodyLength } from "../../protocol/wire.js";
import { LOCAL_MACHINE, MACHINES, NOISE_MACHINE, PUBLICATIONS, SCOPE, peerRef } from "./corpus.js";
import type { Scenario } from "./corpus.js";

type Op<K extends Frame["op"]> = Extract<Frame, { op: K }>;
type Reply = {
  v: 1;
  op: "result";
  rid: string;
  forOp: string;
  outcome: Record<string, unknown>;
};
/** One observed operation and the simulated outcome, for verifying forbidden reads and unknown-send IDs. */
export type Receipt = {
  op: string;
  sessionId?: string;
  key?: string;
  expectedRevision?: number;
  messageId?: string;
  outcome?: string;
};

function targetOf(request: Frame): PeerRef | undefined {
  if (request.op === "send") {
    return request.to;
  }
  if (
    request.op === "state.get" ||
    request.op === "state.list" ||
    request.op === "interest.add" ||
    request.op === "interest.remove"
  ) {
    return request.publisher;
  }
  return undefined;
}
function describeOutcome(reply: Reply | undefined): string {
  if (reply === undefined) {
    return "no_reply";
  }
  const { tag, code } = reply.outcome;
  return typeof code === "string" ? `${String(tag)}:${code}` : String(tag);
}

export class SimulatedGateway {
  readonly requests: Frame[] = [];
  readonly receipts: Receipt[] = [];
  hung = 0;
  socketPath = "";
  private directory = "";
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private local: PeerRef = peerRef(LOCAL_MACHINE);
  constructor(
    private readonly scenario: Scenario,
    private readonly receiptsPath?: string,
    private readonly registerReplyDelayMs = 0,
  ) {}

  count(op: string): number {
    return this.requests.filter((r) => r.op === op).length;
  }
  async start(): Promise<string> {
    this.directory = await mkdtemp(join(tmpdir(), "psc-sim-"));
    this.socketPath = join(this.directory, "g.sock");
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => {
        this.sockets.delete(socket);
      });
      socket.on("error", () => undefined);
      this.read(socket);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(this.socketPath, resolve);
    });
    return this.socketPath;
  }
  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      if (this.server === undefined) {
        resolve();
      } else {
        this.server.close(() => {
          resolve();
        });
      }
    });
    if (this.receiptsPath !== undefined) {
      await writeFile(
        this.receiptsPath,
        JSON.stringify({ simulatedGateway: true, receipts: this.receipts }, null, 2),
      );
    }
    await rm(this.directory, { recursive: true, force: true });
  }
  private read(socket: Socket): void {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const total = frameBodyLength(buffer.subarray(0, 4)) + 4;
        if (buffer.length < total) {
          return;
        }
        const request = decodeFrame(buffer.subarray(0, total), "local-client");
        buffer = Buffer.from(buffer.subarray(total));
        this.requests.push(request);
        const reply = this.answer(request);
        this.record(request, reply);
        if (reply !== undefined) {
          this.write(socket, request, reply);
        }
      }
    });
  }
  private write(socket: Socket, request: Frame, reply: Reply): void {
    const bytes = encodeFrame(reply, "adapter-delivery");
    if (request.op === "register" && this.registerReplyDelayMs > 0) {
      // Models a loaded machine: the gateway has SEEN register, the adapter has not yet processed the reply.
      setTimeout(() => {
        if (!socket.destroyed) {
          socket.write(bytes);
        }
      }, this.registerReplyDelayMs);
    } else {
      socket.write(bytes);
    }
  }
  private record(request: Frame, reply: Reply | undefined): void {
    const sessionId = targetOf(request)?.sessionId;
    this.receipts.push({
      op: request.op,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(request.op === "state.get" ? { key: request.key } : {}),
      ...(request.op === "state.get" && request.expectedRevision !== undefined
        ? { expectedRevision: request.expectedRevision }
        : {}),
      ...(request.op === "send" ? { messageId: request.message.id } : {}),
      outcome: describeOutcome(reply),
    });
  }
  private result(request: Frame, outcome: Record<string, unknown>): Reply {
    return { v: 1, op: "result", rid: request.rid, forOp: request.op, outcome };
  }
  private answer(request: Frame): Reply | undefined {
    if (request.op === "register") {
      this.local = {
        machineId: LOCAL_MACHINE,
        sessionId: request.sessionId,
        runtimeNonce: request.runtimeNonce,
      };
      return this.result(request, { tag: "ok", value: { peer: this.local, scopeIds: [SCOPE] } });
    }
    if (request.op === "discover") {
      const peers = [...MACHINES, NOISE_MACHINE].map((machine) => ({
        peer: peerRef(machine),
        label: `simulated ${machine}`,
        scopeIds: [SCOPE],
      }));
      return this.result(request, { tag: "ok", value: { peers, watching: request.watch } });
    }
    if (request.op === "close" || request.op === "ping" || request.op === "unwatch") {
      return this.result(request, { tag: "ok", value: {} });
    }
    if (request.op === "send") {
      return this.send(request);
    }
    if (request.op === "state.list" || request.op === "state.get") {
      return this.state(request);
    }
    return undefined;
  }
  private send(request: Op<"send">): Reply | undefined {
    const injected = this.scenario.faults[`send:${request.to.sessionId}`];
    if (injected === "hang") {
      this.hung += 1;
      return undefined;
    }
    const binding = {
      messageId: request.message.id,
      sender: this.local,
      recipient: request.to,
      scopeId: request.scopeId,
    };
    if (injected === "unknown") {
      return this.result(request, { tag: "unknown", binding, code: "unavailable" });
    }
    return this.result(
      request,
      injected === undefined
        ? { tag: "admitted", binding, correlation: "none" }
        : { tag: "not_admitted", binding, code: injected },
    );
  }
  private state(request: Op<"state.get" | "state.list">): Reply | undefined {
    const target = request.publisher;
    const injected = this.scenario.faults[`${request.op}:${target.sessionId}`];
    if (injected === "hang") {
      this.hung += 1;
      return undefined;
    }
    if (injected !== undefined) {
      return this.result(request, { tag: "error", code: injected });
    }
    const publications = PUBLICATIONS[target.machineId];
    if (publications === undefined || target.sessionId !== `peer-${target.machineId}`) {
      return this.result(request, { tag: "error", code: "no_route" });
    }
    if (request.op === "state.list") {
      const items = Object.entries(publications).map(([key, p]) => ({
        key,
        revision: p.revision,
        category: p.category,
        title: p.title,
      }));
      return this.result(request, {
        tag: "ok",
        value: {
          publisher: target,
          scopeId: SCOPE,
          revision: Math.max(0, ...items.map((item) => item.revision)),
          items,
        },
      });
    }
    const found = publications[request.key];
    if (found === undefined) {
      return this.result(request, { tag: "error", code: "not_found" });
    }
    if (request.expectedRevision !== undefined && request.expectedRevision !== found.revision) {
      return this.result(request, { tag: "error", code: "revision_mismatch" });
    }
    return this.result(request, {
      tag: "ok",
      value: {
        publisher: target,
        scopeId: SCOPE,
        publication: {
          key: request.key,
          revision: found.revision,
          category: found.category,
          title: found.title,
          summary: found.summary,
          content: found.content,
          format: "text",
          preparation: "authored",
        },
      },
    });
  }
}
