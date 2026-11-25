import { randomBytes, randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";

export const PEERS_REQUEST_CHANNEL = "pi-peers:request";
export const PEERS_REPLY_CHANNEL = "pi-peers:reply";
const DEFAULT_TIMEOUT_MS = 20_000;

const key = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u));
const hexId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));

const PeerRef = Schema.Struct({
  machineId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u)),
  sessionId: Schema.NonEmptyString,
  runtimeNonce: hexId,
});

const PeersMessage = Schema.Struct({
  kind: Schema.Literals(["request", "reply", "update"]),
  content: Schema.NonEmptyString,
  format: Schema.optionalKey(Schema.Literals(["markdown", "text", "git-diff", "git-format-patch"])),
  status: Schema.optionalKey(
    Schema.Literals([
      "accepted",
      "declined",
      "needs_clarification",
      "planned",
      "in_progress",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ]),
  ),
  replyTo: Schema.optionalKey(Schema.Struct({ sender: PeerRef, messageId: hexId })),
});

export const PeersRequest = Schema.Union([
  Schema.Struct({ id: key, op: Schema.Literal("list"), scope: Schema.optionalKey(key) }),
  Schema.Struct({
    id: key,
    op: Schema.Literal("send"),
    to: PeerRef,
    scope: key,
    messageId: Schema.optionalKey(hexId),
    message: PeersMessage,
  }),
]);

export type PeersRequest = typeof PeersRequest.Type;

const Outcome = Schema.Union([
  Schema.Struct({ tag: Schema.Literal("admitted") }),
  Schema.Struct({ tag: Schema.Literals(["not_admitted", "unknown"]), code: Schema.String }),
]);

const PeersReply = Schema.Union([
  Schema.Struct({
    id: key,
    ok: Schema.Literal(true),
    peers: Schema.Array(
      Schema.Struct({ peer: PeerRef, scopeId: key, label: Schema.String, self: Schema.Boolean }),
    ),
  }),
  Schema.Struct({ id: key, ok: Schema.Literal(true), messageId: hexId, outcome: Outcome }),
  Schema.Struct({
    id: key,
    ok: Schema.Literal(false),
    code: Schema.String,
    note: Schema.String,
    messageId: Schema.optionalKey(hexId),
  }),
]);

export type PeersReply = typeof PeersReply.Type;

export type PeersFailure = Extract<PeersReply, { ok: false }>;

export type PeersListed = Extract<PeersReply, { peers: unknown }> | PeersFailure;

export type PeersSent = Extract<PeersReply, { messageId: unknown }> | PeersFailure;

export type PeersSend = Omit<Extract<PeersRequest, { op: "send" }>, "id" | "op">;

export type PeersEvents = Pick<EventBus, "emit" | "on">;

export type PeersClientOptions = { readonly timeoutMs?: number };

export type PeersClient = {
  readonly list: (scope?: string, signal?: AbortSignal) => Promise<PeersListed>;
  readonly send: (request: PeersSend, signal?: AbortSignal) => Promise<PeersSent>;
};

type Untagged<T> = T extends unknown ? Omit<T, "id"> : never;

const decodeReply = Schema.decodeUnknownOption(PeersReply);

const NO_ANSWER =
  "pi-peers did not answer: it is not loaded, not set up or not connected in this session.";

const ABORTED = "The request was aborted before pi-peers answered.";
const NOT_SENT = "The request was aborted before it was sent. Nothing was sent.";

const MAY_HAVE_SENT =
  "A send may still arrive. To retry safely, send again with this messageId and the same to, scope and message.";

const MISMATCH = "pi-peers answered with a reply of the wrong kind.";

function unavailable(id: string, note: string): PeersFailure {
  return { id, ok: false, code: "unavailable", note };
}

function listed(reply: PeersReply): PeersListed {
  return !reply.ok || "peers" in reply ? reply : unavailable(reply.id, MISMATCH);
}

function sent(reply: PeersReply): PeersSent {
  return !reply.ok || "messageId" in reply ? reply : unavailable(reply.id, MISMATCH);
}

export function peersClient(events: PeersEvents, options: PeersClientOptions = {}): PeersClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = async (
    request: Untagged<PeersRequest>,
    signal?: AbortSignal,
  ): Promise<PeersReply> => {
    const id = randomUUID();

    return new Promise<PeersReply>((resolve) => {
      const finish = (reply: PeersReply): void => {
        clearTimeout(timer);
        stop();
        signal?.removeEventListener("abort", aborted);
        resolve(reply);
      };

      const aborted = (): void => {
        finish(unavailable(id, ABORTED));
      };

      const stop = events.on(PEERS_REPLY_CHANNEL, (data) => {
        const reply = decodeReply(data);

        if (Option.isSome(reply) && reply.value.id === id) {
          finish(reply.value);
        }
      });

      const timer = setTimeout(() => {
        finish(unavailable(id, NO_ANSWER));
      }, timeoutMs);

      if (signal?.aborted === true) {
        finish({ id, ok: false, code: "cancelled", note: NOT_SENT });
      } else {
        signal?.addEventListener("abort", aborted, { once: true });
        events.emit(PEERS_REQUEST_CHANNEL, { ...request, id });
      }
    });
  };

  return {
    list: async (scope, signal) =>
      listed(await call(scope === undefined ? { op: "list" } : { op: "list", scope }, signal)),
    send: async (request, signal) => {
      const messageId = request.messageId ?? randomBytes(16).toString("hex");
      const reply = sent(await call({ op: "send", ...request, messageId }, signal));

      return reply.ok || (reply.note !== NO_ANSWER && reply.note !== ABORTED)
        ? reply
        : { ...reply, messageId, note: `${reply.note} ${MAY_HAVE_SENT}` };
    },
  };
}
