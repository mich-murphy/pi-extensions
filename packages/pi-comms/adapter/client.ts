import { setTimeout as delay } from "node:timers/promises";
import type { Frame, Message, PeerRef } from "../protocol/schema.js";
import type { Configuration } from "./config.js";
import { validateBoundReply } from "./replies.js";
import { sendWithRetries } from "./send.js";
import type { SendOutcome } from "./send.js";
import { connectTransport, ConnectionFailure, freshId } from "./transport.js";
import type { Connection, Reply, Request } from "./transport.js";
import { waitFor } from "./wait.js";

type Descriptor = Extract<
  Extract<Frame, { op: "result"; forOp: "discover" }>["outcome"],
  { tag: "ok" }
>["value"]["peers"][number];
export type EnsureGateway = (
  deadline: number,
  signal: AbortSignal,
) => Promise<{ gatewaySha256: string }>;

export type ClientOptions = {
  config: Configuration;
  peer: PeerRef;
  incoming: (request: Request) => Reply;
  statusChanged: () => void;
  ensureGateway?: EnsureGateway;
};
/** One surviving adapter lifetime; reconnect replaces only connection-generation state. */
export class GatewayClient {
  private connection: Connection | undefined;
  private connecting: Promise<Connection> | undefined;
  private initialization: AbortController | undefined;
  private episode: { promise: Promise<void>; controller: AbortController } | undefined;
  private closed = false;
  private readonly lifetime = new AbortController();
  private generation = 0;
  private active = 0;
  private scopes = new Set<string>();
  private watch: { rid: string; scopes: ReadonlySet<string>; ready: boolean } | undefined;
  private readonly peers = new Map<string, Descriptor>();
  private diagnostic = "disconnected";
  private generationPending = false;
  constructor(private readonly options: ClientOptions) {}
  /** Tool preflight reconnects before scope guards; only setup-managed runtimes auto-start. */
  async recoverForTool(): Promise<void> {
    if (this.options.ensureGateway !== undefined && this.connection === undefined) {
      await this.reconnect(this.lifetime.signal);
    }
  }
  effectiveScopes(): ReadonlySet<string> {
    return this.scopes;
  }
  status() {
    return {
      status: this.diagnostic,
      connected: this.connection !== undefined,
      scopes: [...this.scopes],
      operations: this.active,
      watching: this.watch !== undefined,
    };
  }
  private validateReply(request: Request, reply: Reply): void {
    validateBoundReply(request, reply, this.options.peer);
    if (
      request.op !== "discover" ||
      !request.watch ||
      this.watch?.rid !== request.rid ||
      reply.forOp !== "discover" ||
      reply.outcome.tag !== "ok"
    ) {
      return;
    }
    this.watch.ready = true;
    this.peers.clear();
    for (const descriptor of reply.outcome.value.peers) {
      this.peers.set(JSON.stringify(descriptor.peer), descriptor);
    }
  }
  private roster(event: Extract<Frame, { op: "roster.event" }>): void {
    if (this.watch?.rid !== event.rid) {
      return;
    }
    if (event.event.tag === "invalidated") {
      this.watch = undefined;
      this.peers.clear();
      return;
    }
    if (event.event.tag === "remove") {
      this.peers.delete(JSON.stringify(event.event.peer));
      return;
    }
    const descriptor = event.event.peer;
    if (descriptor.scopeIds.some((scope) => this.watch?.scopes.has(scope) !== true)) {
      throw new Error("Roster scope mismatch");
    }
    const key = JSON.stringify(descriptor.peer);
    if (!this.peers.has(key) && this.peers.size >= 60) {
      throw new Error("Roster bound exceeded");
    }
    this.peers.set(key, descriptor);
  }
  private async connect(deadline: number, callerSignal?: AbortSignal): Promise<Connection> {
    const signal =
      callerSignal === undefined
        ? this.lifetime.signal
        : AbortSignal.any([callerSignal, this.lifetime.signal]);
    if (this.closed || signal.aborted) {
      throw new ConnectionFailure("cancelled", false);
    }
    if (deadline <= performance.now()) {
      throw new ConnectionFailure("unavailable", false);
    }
    if (this.connection !== undefined) {
      return this.connection;
    }
    if (this.connecting === undefined) {
      const pending = this.initialize();
      this.connecting = pending;
      void pending
        .finally(() => {
          if (this.connecting === pending) {
            this.connecting = undefined;
          }
        })
        .catch(() => undefined);
    }
    return waitFor(
      this.connecting,
      deadline,
      this.initialization === undefined
        ? signal
        : AbortSignal.any([signal, this.initialization.signal]),
    );
  }
  private async expectedConfiguration(
    deadline: number,
    signal: AbortSignal,
    current: () => boolean,
  ): Promise<string | undefined> {
    const ensure = this.options.ensureGateway;
    if (ensure === undefined) {
      return undefined;
    }
    try {
      const snapshot: unknown = await ensure(deadline, signal);
      if (
        typeof snapshot !== "object" ||
        snapshot === null ||
        !("gatewaySha256" in snapshot) ||
        typeof snapshot.gatewaySha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(snapshot.gatewaySha256)
      ) {
        throw new ConnectionFailure("protocol_error", false);
      }
      return snapshot.gatewaySha256;
    } catch (error) {
      if (current()) {
        this.diagnostic = "activation_unconfirmed";
        this.options.statusChanged();
      }
      throw error;
    }
  }
  private async initialize(): Promise<Connection> {
    // Session-owned absolute setup budget, independent of the first tool's budget.
    const deadline = performance.now() + 5000;
    const controller = new AbortController();
    this.initialization = controller;
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    const generation = ++this.generation;
    const current = () => !this.closed && generation === this.generation && !signal.aborted;
    const pending = (async () => {
      const expected = await this.expectedConfiguration(deadline, signal, current);
      // An ensure callback may ignore cancellation. Never let its late result open a socket.
      if (!current()) {
        throw new ConnectionFailure("cancelled", false);
      }
      const connection = await connectTransport({
        socketPath: this.options.config.socketPath,
        deadline,
        signal,
        incoming: this.options.incoming,
        event: (event) => {
          if (current()) {
            this.roster(event);
          }
        },
        validateReply: (request, reply) => {
          if (current()) {
            this.validateReply(request, reply);
          }
        },
        disconnected: (code) => {
          if (!current()) {
            return;
          }
          const established = this.connection !== undefined;
          this.connection = undefined;
          this.scopes.clear();
          this.watch = undefined;
          this.peers.clear();
          this.diagnostic = this.generationPending ? "activation_pending" : code;
          this.options.statusChanged();
          // One bounded episode per lost established generation; never replay requests.
          if (established && this.options.ensureGateway !== undefined && !this.closed) {
            queueMicrotask(() => {
              void this.reconnect(this.lifetime.signal).catch(() => undefined);
            });
          }
        },
      });
      if (!current()) {
        connection.close();
        throw new ConnectionFailure("cancelled", false);
      }
      const abort = () => {
        connection.close();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const reply = await connection.request(
          {
            v: 1,
            op: "register",
            rid: freshId(),
            sessionId: this.options.peer.sessionId,
            runtimeNonce: this.options.peer.runtimeNonce,
            scopeIds: this.options.config.scopeIds,
            label: this.options.config.label,
            ...(expected === undefined ? {} : { expectedConfigSha256: expected }),
          },
          deadline,
          signal,
        );
        if (!current()) {
          throw new ConnectionFailure("cancelled", false);
        }
        if (reply.outcome.tag === "error" && reply.outcome.code === "config_mismatch") {
          this.generationPending = true;
          throw new ConnectionFailure("unavailable", false);
        }
        if (reply.forOp !== "register" || reply.outcome.tag !== "ok") {
          throw new ConnectionFailure("unavailable", false);
        }
        this.scopes = new Set(reply.outcome.value.scopeIds);
        this.connection = connection;
        this.generationPending = false;
        this.diagnostic = "connected";
        this.options.statusChanged();
        return connection;
      } catch (error) {
        connection.close();
        if (current() && expected !== undefined) {
          this.diagnostic = this.generationPending
            ? "activation_pending"
            : "activation_unconfirmed";
          this.options.statusChanged();
        }
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    })();
    try {
      return await pending;
    } finally {
      if (this.initialization === controller) {
        this.initialization = undefined;
      }
    }
  }
  async operation<A>(run: () => Promise<A>): Promise<A> {
    if (this.closed || this.active >= 8) {
      throw new ConnectionFailure(this.closed ? "cancelled" : "overloaded", false);
    }
    this.active += 1;
    try {
      return await run();
    } finally {
      this.active -= 1;
    }
  }
  async request(
    request: Request,
    signal?: AbortSignal,
    deadline = performance.now() + 15_000,
  ): Promise<Reply> {
    const connection = await this.connect(deadline, signal);
    return connection.request(request, deadline, signal);
  }
  /** Fresh is reserved for a separately reviewed control attempt, never passive recovery. */
  async reconnect(signal?: AbortSignal, fresh = false): Promise<void> {
    if (this.closed || signal?.aborted === true) {
      throw new ConnectionFailure("cancelled", false);
    }
    if (this.episode !== undefined && !fresh) {
      return waitFor(
        this.episode.promise,
        performance.now() + 60_000,
        signal ?? this.lifetime.signal,
      );
    }
    if (fresh) {
      this.episode?.controller.abort();
      this.fenceTransport();
    }
    const controller = new AbortController();
    const episodeSignal = AbortSignal.any([
      this.lifetime.signal,
      controller.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const promise = this.operation(async () => {
      const deadline = performance.now() + 60_000;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          // eslint-disable-next-line eslint/no-await-in-loop -- One bounded reconnect episode; attempts must be sequential.
          await this.connect(deadline, episodeSignal);
          return;
        } catch (error) {
          if (
            !(error instanceof ConnectionFailure) ||
            error.code !== "unavailable" ||
            attempt === 5 ||
            performance.now() >= deadline
          ) {
            throw error;
          }
          try {
            // eslint-disable-next-line eslint/no-await-in-loop -- Retry backoff is sequential and consumes the same deadline.
            await delay(Math.min(4000, 100 * 2 ** attempt), undefined, { signal: episodeSignal });
          } catch {
            throw new ConnectionFailure("cancelled", false);
          }
        }
      }
    });
    const episode = { promise, controller };
    this.episode = episode;
    try {
      await promise;
    } finally {
      if (this.episode === episode) {
        this.episode = undefined;
      }
    }
  }
  private fenceTransport(): void {
    // Fence before close: the old transport's synchronous disconnect callback is stale too.
    this.generation += 1;
    this.initialization?.abort();
    this.initialization = undefined;
    this.connecting = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.scopes.clear();
    this.peers.clear();
    this.watch = undefined;
    this.diagnostic = "disconnected";
    this.options.statusChanged();
  }
  reservePushes(count: number): (() => void) | undefined {
    if (this.closed || count < 1 || count > 8 || this.active + count > 8) {
      return undefined;
    }
    this.active += count;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= count;
      }
    };
  }
  async send(
    to: PeerRef,
    scopeId: string,
    message: Message,
    signal?: AbortSignal,
    reserved = false,
  ): Promise<SendOutcome> {
    const binding = {
      messageId: message.id,
      sender: this.options.peer,
      recipient: to,
      scopeId,
    };
    const combined =
      signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal]);
    const run = async () =>
      sendWithRetries({
        sender: this.options.peer,
        recipient: to,
        scopeId,
        message,
        signal: combined,
        request: async (rid, deadline) =>
          this.request({ v: 1, op: "send", rid, to, scopeId, message }, combined, deadline),
      });
    try {
      return reserved ? await run() : await this.operation(run);
    } catch (error) {
      if (error instanceof ConnectionFailure && error.code === "overloaded") {
        return {
          tag: "not_admitted",
          binding,
          code: "overloaded",
          resource: "operations",
        };
      }
      return { tag: "not_admitted", binding, code: "cancelled" };
    }
  }
  async discover(
    scopeIds: readonly string[],
    watch: boolean,
    signal?: AbortSignal,
  ): Promise<Reply> {
    return this.operation(async () => {
      if (watch && this.watch !== undefined) {
        const scopesMatch =
          scopeIds.length === this.watch.scopes.size &&
          scopeIds.every((scope) => this.watch?.scopes.has(scope) === true);
        if (!this.watch.ready || !scopesMatch) {
          return {
            v: 1,
            op: "result",
            rid: freshId(),
            forOp: "discover",
            outcome: { tag: "error", code: "overloaded", resource: "watch" },
          };
        }
        return {
          v: 1,
          op: "result",
          rid: freshId(),
          forOp: "discover",
          outcome: {
            tag: "ok",
            value: { peers: [...this.peers.values()], watching: true },
          },
        };
      }
      const rid = freshId();
      // Install before request completion: live events can follow the snapshot in the same chunk.
      if (watch) {
        this.watch = { rid, scopes: new Set(scopeIds), ready: false };
      }
      try {
        const reply = await this.request({ v: 1, op: "discover", rid, scopeIds, watch }, signal);
        if (watch && (reply.forOp !== "discover" || reply.outcome.tag !== "ok")) {
          this.clearWatch(rid);
        }
        return reply;
      } catch (error) {
        if (watch) {
          this.clearWatch(rid);
        }
        throw error;
      }
    });
  }
  private clearWatch(rid: string): void {
    if (this.watch?.rid === rid) {
      this.watch = undefined;
      this.peers.clear();
    }
  }
  close(): void {
    this.closed = true;
    this.lifetime.abort();
    this.fenceTransport();
  }
}
