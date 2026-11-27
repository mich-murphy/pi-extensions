import type {
  AgentBeforeSettleEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import type { Types } from "effect";
import { samePeer } from "../protocol/identity.js";
import { retiredOps } from "../protocol/schema.js";
import type { Message, PeerRef } from "../protocol/schema.js";
import { validateFrame } from "../protocol/wire.js";
import { createState } from "../state/core.js";
import type { SessionState } from "../state/core.js";
import type { Delivery } from "../state/types.js";
import { MessageAliases } from "./aliases.js";
import type { ClientOptions, EnsureGateway, LinkState } from "./client.js";
import { GatewayClient } from "./client.js";
import { permits, plainText } from "./config.js";
import type { Configuration } from "./config.js";
import { Handles, TakenIndex } from "./handles.js";
import { footerStatus } from "./presentation.js";
import type { FooterTheme } from "./presentation.js";
import { SentReceipts } from "./receipts.js";
import { UnsureSends } from "./retries.js";
import { freshId } from "./transport.js";
import type { Reply, Request } from "./transport.js";

export type AdapterHost = {
  isIdle: () => boolean;
  ui: Pick<ExtensionContext["ui"], "setStatus"> & { readonly theme?: FooterTheme };
};

export const NOTICE_TYPE = "peers-wake";
const isNoticeDetails = Schema.is(Schema.Struct({ noticeId: Schema.String }));
const LEGACY_NOTICE_TYPE = "session-communication-wake";

export function isWakeNotice(customType: string | undefined): boolean {
  return customType === NOTICE_TYPE || customType === LEGACY_NOTICE_TYPE;
}

export type TakenMessages<Item = Delivery> = { messages: ReadonlyArray<Item> };

export type Waited = "message" | "timed_out" | "cancelled" | "disconnected" | "closed" | "busy";

type Waiting = { key: string; from: PeerRef; scopeId: string };

export class AdapterSession {
  readonly client: GatewayClient;
  readonly state: SessionState;
  readonly handles = new Handles();
  readonly taken = new TakenIndex();
  readonly unsure = new UnsureSends();
  readonly aliases = new MessageAliases();
  readonly receipts = new SentReceipts();
  private readonly inbox: Array<Waiting> = [];
  private waiter: ((result: Waited) => void) | undefined;
  private readonly abort = new AbortController();
  private wakeNeeded = false;
  private notice: { id: string; at: number } | undefined;
  private deferred: ReturnType<typeof setImmediate> | undefined;
  private disposed = false;
  private readonly linkListeners = new Set<(links: ReadonlyArray<LinkState>) => void>();
  constructor(
    readonly config: Configuration,
    readonly peer: PeerRef,
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    private readonly context: () => AdapterHost | undefined,
    private readonly signalPump: () => void,
    ensureGateway?: EnsureGateway,
  ) {
    const clientOptions: Types.Mutable<ClientOptions> = {
      config,
      peer,
      incoming: (request) => this.incoming(request),
      linkChanged: () => {
        this.updateStatus();
        const links = this.client.links();

        for (const listener of this.linkListeners) {
          listener(links);
        }
      },
      statusChanged: () => {
        this.updateStatus();

        if (!this.client.status().connected) {
          this.waiter?.("disconnected");
        }
      },
    };

    if (ensureGateway !== undefined) {
      clientOptions.ensureGateway = ensureGateway;
    }

    this.client = new GatewayClient(clientOptions);
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
  linkStates(): ReadonlyArray<LinkState> {
    return this.client.links();
  }
  onLinkChange(listener: (links: ReadonlyArray<LinkState>) => void): () => void {
    this.linkListeners.add(listener);

    return () => {
      this.linkListeners.delete(listener);
    };
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
      waiting: this.waiter !== undefined,
      links: this.client.links(),
      notice,
    };
  }
  private updateStatus(): void {
    const host = this.context();
    host?.ui.setStatus("peers", footerStatus(this.status(), true, host.ui.theme));
  }
  private incoming(request: Request): Reply {
    if (request.op === "deliver") {
      const previous = this.inbox.length;
      const outcome = this.state.admit(request);

      if (this.inbox.length > previous) {
        this.wakeNeeded = true;
        this.waiter?.("message");
        this.updateStatus();
        this.signalPump();
      }

      return checkedReply({
        v: 2,
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
      v: 2,
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
      isNoticeDetails(details) &&
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
      ...new Set(
        this.inbox.map((entry) => {
          const handle = this.handles.sender(entry.from, entry.scopeId);

          return entry.from.machineId === this.peer.machineId
            ? handle
            : `${handle} on machine ${plainText(entry.from.machineId)}`;
        }),
      ),
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
      const timers: Array<ReturnType<typeof setTimeout>> = [];

      const aborted = () => {
        finish("cancelled");
      };

      const finish = (result: Waited) => {
        for (const timer of timers) {
          clearTimeout(timer);
        }

        signal?.removeEventListener("abort", aborted);
        this.waiter = undefined;
        this.updateStatus();
        resolve(result);
      };

      timers.push(
        setTimeout(() => {
          finish("timed_out");
        }, seconds * 1000),
      );
      signal?.addEventListener("abort", aborted, { once: true });
      this.waiter = finish;
      this.updateStatus();
    });
  }
  take(limit: number): TakenMessages {
    const messages: Array<Delivery> = [];

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

    if (messages.length > 0) {
      this.updateStatus();
    }

    return { messages };
  }
  async send(to: PeerRef, scopeId: string, message: Message, signal?: AbortSignal) {
    const messageId = message.id;

    if (
      !this.client.effectiveScopes().has(scopeId) ||
      !permits(this.config, to.machineId, scopeId, "push")
    ) {
      return { tag: "not_admitted", messageId, code: "forbidden" } as const;
    }

    if (message.kind === "request") {
      const relation = this.state.rememberOutgoing({ to, scopeId, message });

      if (relation.tag !== "ok") {
        type RejectedRequest = {
          tag: "not_admitted";
          messageId: string;
          code: typeof relation.code;
          resource?: Extract<typeof relation, { code: "overloaded" }>["resource"];
        };

        const failure: RejectedRequest = { tag: "not_admitted", messageId, code: relation.code };

        if (relation.code === "overloaded") {
          failure.resource = relation.resource;
        }

        return failure;
      }
    }

    const outcome = await this.client.send(to, scopeId, message, signal);

    if (outcome.tag === "admitted") {
      this.receipts.record(messageId, outcome.durable);
    }

    return outcome;
  }
  close(): void {
    this.disposed = true;
    this.abort.abort();
    clearImmediate(this.deferred);
    this.deferred = undefined;
    this.waiter?.("closed");
    this.client.close();
    this.linkListeners.clear();
    this.inbox.length = 0;
    this.notice = undefined;
    this.wakeNeeded = false;
  }
}

function checkedReply(value: Reply): Reply {
  const frame = validateFrame(value, "adapter-delivery");

  if (frame.op !== "result") {
    throw new Error("Invalid reply");
  }

  return frame;
}
