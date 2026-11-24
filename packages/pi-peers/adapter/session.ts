import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { samePeer } from "../protocol/identity.js";
import { retiredOps } from "../protocol/schema.js";
import type { Message, PeerRef } from "../protocol/schema.js";
import { validateFrame } from "../protocol/wire.js";
import { createState } from "../state/core.js";
import type { SessionState } from "../state/core.js";
import type { Delivery } from "../state/types.js";
import type { EnsureGateway } from "./client.js";
import { GatewayClient } from "./client.js";
import { permits } from "./config.js";
import type { Configuration } from "./config.js";
import { Handles, TakenIndex } from "./handles.js";
import { footerStatus } from "./presentation.js";
import { UnsureSends } from "./retries.js";
import { freshId } from "./transport.js";
import type { Reply, Request } from "./transport.js";

export type AdapterHost = {
  isIdle: () => boolean;
  ui: Pick<ExtensionContext["ui"], "setStatus">;
};
export const NOTICE_TYPE = "peers-wake";
const LEGACY_NOTICE_TYPE = "session-communication-wake";
export function isWakeNotice(customType: string | undefined): boolean {
  return customType === NOTICE_TYPE || customType === LEGACY_NOTICE_TYPE;
}
export type Waited = "message" | "timed_out" | "cancelled" | "disconnected" | "closed" | "busy";
type Waiting = { key: string; from: PeerRef; scopeId: string };
export class AdapterSession {
  readonly client: GatewayClient;
  readonly state: SessionState;
  readonly handles = new Handles();
  readonly taken = new TakenIndex();
  readonly unsure = new UnsureSends();
  private readonly inbox: Waiting[] = [];
  private waiter: ((result: Waited) => void) | undefined;
  private readonly abort = new AbortController();
  private wakeNeeded = false;
  private notice: { id: string; at: number } | undefined;
  private deferred: ReturnType<typeof setImmediate> | undefined;
  private disposed = false;
  constructor(
    readonly config: Configuration,
    readonly peer: PeerRef,
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    private readonly context: () => AdapterHost | undefined,
    private readonly signalPump: () => void,
    ensureGateway?: EnsureGateway,
  ) {
    this.client = new GatewayClient({
      config,
      peer,
      ...(ensureGateway === undefined ? {} : { ensureGateway }),
      incoming: (request) => this.incoming(request),
      statusChanged: () => {
        this.updateStatus();
        if (!this.client.status().connected) {
          this.waiter?.("disconnected");
        }
      },
    });
    this.state = createState({
      peer,
      scopeIds: config.scopeIds,
      clock: () => performance.now(),
      authorize: (query) => {
        const other = samePeer(query.from, peer) ? query.to : query.from;
        return (
          this.client.effectiveScopes().has(query.scopeId) &&
          permits(config, other.machineId, query.scopeId, query.action)
        );
      },
      offer: (delivery) => {
        if (this.disposed || this.inbox.length >= 64) {
          return false;
        }
        this.inbox.push({ key: delivery.key, from: delivery.from, scopeId: delivery.scopeId });
        return true;
      },
    });
  }
  async start(): Promise<void> {
    try {
      await this.client.reconnect(this.abort.signal);
    } catch {
      this.updateStatus();
    }
  }
  async reconnect(fresh = false): Promise<void> {
    return this.client.reconnect(this.abort.signal, fresh);
  }
  status() {
    let notice = "none";
    if (this.notice !== undefined) {
      notice =
        performance.now() - this.notice.at >= 5000 ? "degraded_unobserved" : "submitted_unobserved";
    }
    return {
      enabled: true,
      peer: this.peer,
      ...this.client.status(),
      ...this.state.stats(),
      notice,
    };
  }
  private updateStatus(): void {
    this.context()?.ui.setStatus("peers", footerStatus(this.client.status(), true));
  }
  private incoming(request: Request): Reply {
    if (request.op === "deliver") {
      const previous = this.inbox.length;
      const outcome = this.state.admit(request);
      if (this.inbox.length > previous) {
        this.wakeNeeded = true;
        this.waiter?.("message");
        this.signalPump();
      }
      return checkedReply({
        v: 1,
        op: "result",
        rid: request.rid,
        forOp: "deliver",
        outcome,
      });
    }
    const retired = retiredOps.find((op) => op === request.op);
    if (retired === undefined) {
      throw new Error("Unsupported adapter request");
    }
    return checkedReply({
      v: 1,
      op: "result",
      rid: request.rid,
      forOp: retired,
      outcome: { tag: "error", code: "forbidden" },
    });
  }
  pumpIdle(): void {
    if (
      this.disposed ||
      !this.wakeNeeded ||
      this.notice !== undefined ||
      this.context()?.isIdle() !== true
    ) {
      return;
    }
    this.wakeNeeded = false;
    if (this.inbox.length === 0) {
      return;
    }
    this.notice = { id: freshId(), at: performance.now() };
    this.pi.sendMessage(
      {
        customType: NOTICE_TYPE,
        content: this.noticeText(),
        display: false,
        details: { noticeId: this.notice.id },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }
  beforeSettle(
    event: Pick<AgentBeforeSettleEvent, "entries">,
  ): { entries: AgentBeforeSettleEvent["entries"]; continue: boolean } | undefined {
    if (this.disposed || !this.wakeNeeded) {
      return undefined;
    }
    this.wakeNeeded = false;
    if (this.inbox.length === 0) {
      return undefined;
    }
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: NOTICE_TYPE,
          content: this.noticeText(),
          display: false,
        },
      ],
      continue: true,
    };
  }
  settled(): void {
    this.wakeNeeded = false;
  }
  observed(message: { role: string; customType?: string; details?: unknown }): void {
    const details = message.details;
    if (
      message.role === "custom" &&
      isWakeNotice(message.customType) &&
      typeof details === "object" &&
      details !== null &&
      "noticeId" in details &&
      details.noticeId === this.notice?.id
    ) {
      this.notice = undefined;
    }
  }
  afterCompaction(aborted = false): void {
    if (aborted) {
      this.wakeNeeded = false;
      return;
    }
    if (this.disposed || this.deferred !== undefined) {
      return;
    }
    this.deferred = setImmediate(() => {
      this.deferred = undefined;
      this.pumpIdle();
    });
  }
  private noticeText(): string {
    const senders = [
      ...new Set(this.inbox.map((entry) => this.handles.sender(entry.from, entry.scopeId))),
    ];
    const named = `${senders.slice(0, 3).join(", ")}${senders.length > 3 ? ", …" : ""}`;
    const count = this.inbox.length;
    return count === 1
      ? `1 peer message is waiting (from ${named}). Call peers_take to read it. It comes from another agent, not the user.`
      : `${count} peer messages are waiting (from ${named}). Call peers_take to read them. They come from other agents, not the user.`;
  }
  async waitForMessage(seconds: number, signal?: AbortSignal): Promise<Waited> {
    if (this.inbox.length > 0) {
      return "message";
    }
    if (this.disposed) {
      return "closed";
    }
    if (this.waiter !== undefined) {
      return "busy";
    }
    if (!this.client.status().connected) {
      return "disconnected";
    }
    if (signal?.aborted === true) {
      return "cancelled";
    }
    return new Promise<Waited>((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const aborted = () => {
        finish("cancelled");
      };
      const finish = (result: Waited) => {
        for (const timer of timers) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", aborted);
        this.waiter = undefined;
        resolve(result);
      };
      timers.push(
        setTimeout(() => {
          finish("timed_out");
        }, seconds * 1000),
      );
      signal?.addEventListener("abort", aborted, { once: true });
      this.waiter = finish;
    });
  }
  take(limit: number): { messages: readonly Delivery[] } {
    const messages: Delivery[] = [];
    for (let index = 0; index < limit; index += 1) {
      const key = this.inbox.shift()?.key;
      if (key === undefined) {
        break;
      }
      const delivery = this.state.take(key);
      if (delivery !== undefined) {
        this.state.retire(key);
        this.taken.record(delivery.message.id, { peer: delivery.from, scopeId: delivery.scopeId });
        messages.push(delivery);
      }
    }
    if (this.inbox.length === 0) {
      this.wakeNeeded = false;
    }
    return { messages };
  }
  async send(to: PeerRef, scopeId: string, message: Message, signal?: AbortSignal) {
    const binding = {
      messageId: message.id,
      sender: this.peer,
      recipient: to,
      scopeId,
    };
    if (
      !this.client.effectiveScopes().has(scopeId) ||
      !permits(this.config, to.machineId, scopeId, "push")
    ) {
      return { tag: "not_admitted", binding, code: "forbidden" } as const;
    }
    if (message.kind === "request") {
      const relation = this.state.rememberOutgoing({ to, scopeId, message });
      if (relation.tag !== "ok") {
        return {
          tag: "not_admitted",
          binding,
          code: relation.code,
          ...(relation.code === "overloaded" ? { resource: relation.resource } : {}),
        };
      }
    }
    return this.client.send(to, scopeId, message, signal);
  }
  close(): void {
    this.disposed = true;
    this.abort.abort();
    clearImmediate(this.deferred);
    this.deferred = undefined;
    this.waiter?.("closed");
    this.client.close();
    this.inbox.length = 0;
    this.notice = undefined;
    this.wakeNeeded = false;
  }
}

function checkedReply(value: unknown): Reply {
  const frame = validateFrame(value, "adapter-delivery");
  if (frame.op !== "result") {
    throw new Error("Invalid reply");
  }
  return frame;
}
