import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_AUTHORED_BYTES } from "../protocol/schema.js";
import { validateFrame } from "../protocol/wire.js";
import type { PublishInput } from "../state/types.js";
import { permits, visibleText } from "./config.js";
import { toolPresentation } from "./presentation.js";
import { deliveryText } from "./session.js";
import type { AdapterSession } from "./session.js";
import { ConnectionFailure, freshId } from "./transport.js";

const id = Type.String({ pattern: "^[0-9a-f]{32}$" });
const scope = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
const peer = Type.Object(
  {
    machineId: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
    sessionId: Type.String({ minLength: 1, maxLength: 256 }),
    runtimeNonce: id,
  },
  { additionalProperties: false },
);
const work = Type.Union([
  Type.Object({ kind: Type.Literal("request"), origin: peer, requestId: id }),
  Type.Object({
    kind: Type.Literal("publication"),
    publisher: peer,
    key: scope,
  }),
]);
const status = Type.Union(
  [
    "accepted",
    "declined",
    "needs_clarification",
    "planned",
    "in_progress",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ].map((value) => Type.Literal(value)),
);
const format = Type.Union([
  Type.Literal("text"),
  Type.Literal("markdown"),
  Type.Literal("git-diff"),
  Type.Literal("git-format-patch"),
]);
const refs = Type.Array(
  Type.Union([
    Type.Object({
      kind: Type.Literal("publication"),
      publisher: peer,
      key: scope,
      revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    }),
    Type.Object({
      kind: Type.Literal("resource"),
      machineId: Type.String(),
      locator: Type.String({ minLength: 1, maxLength: 1024 }),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
  ]),
  { maxItems: 8 },
);
const authored = {
  work: Type.Optional(work),
  status: Type.Optional(status),
  refs: Type.Optional(refs),
};
const message = Type.Object(
  {
    kind: Type.Union([Type.Literal("request"), Type.Literal("reply"), Type.Literal("update")]),
    content: Type.String({ minLength: 1, maxLength: MAX_AUTHORED_BYTES }),
    format,
    ...authored,
    replyTo: Type.Optional(Type.Object({ sender: peer, messageId: id })),
  },
  { additionalProperties: false },
);
const record = Type.Object(
  {
    category: Type.Union([
      Type.Literal("context"),
      Type.Literal("research"),
      Type.Literal("spec"),
      Type.Literal("plan"),
      Type.Literal("finding"),
      Type.Literal("work"),
    ]),
    title: Type.String({ minLength: 1, maxLength: 128 }),
    summary: Type.String({ minLength: 1, maxLength: 1024 }),
    content: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_AUTHORED_BYTES })),
    format,
    ...authored,
    preparation: Type.Union([
      Type.Literal("authored"),
      Type.Literal("summarized"),
      Type.Literal("curated"),
    ]),
  },
  { additionalProperties: false },
);

type ToolValue = {
  content: { type: "text"; text: string }[];
  details: { value: unknown };
  isError?: boolean;
};
function output(value: unknown): ToolValue {
  return {
    content: [{ type: "text", text: visibleText(JSON.stringify(value)) }],
    details: { value },
  };
}
async function invoke(
  getSession: () => AdapterSession | undefined,
  run: (session: AdapterSession) => unknown,
  local: (session: AdapterSession) => boolean = () => false,
): Promise<ToolValue> {
  const session = getSession();
  if (session === undefined) {
    return output({
      tag: "error",
      code: "unavailable",
      note: "Peers is not set up or not running in this session. Ask the user to run `/peers status`.",
    });
  }
  try {
    if (local(session)) {
      if (session.client.isClosed()) {
        throw new ConnectionFailure("cancelled", false);
      }
    } else {
      await session.client.recoverForTool();
    }
    return output(await run(session));
  } catch (error) {
    return {
      ...output({
        tag: "error",
        code: error instanceof ConnectionFailure ? error.code : "invalid_input",
        note: `${failureNote(error)} If this was peers_send, do not call it again for this message; it may have arrived. No delivery or work-completion claim.`,
      }),
      isError: true,
    };
  }
}
function failureNote(error: unknown): string {
  if (!(error instanceof ConnectionFailure)) {
    return "This request was rejected. Check the tool arguments and configured scopes.";
  }
  if (error.code === "cancelled") {
    return "The request was cancelled.";
  }
  return error.code === "overloaded"
    ? "The peers gateway is busy; try again shortly."
    : "The peers gateway did not complete this request. Ask the user to run `/peers status`.";
}
function ownScope(session: AdapterSession, scopeId: string): void {
  if (!session.client.effectiveScopes().has(scopeId)) {
    throw new ConnectionFailure("unavailable", false);
  }
}
const offline = (session: AdapterSession): boolean => !session.client.status().connected;
function mutateOwn(
  session: AdapterSession,
  args: (PublishInput & { action: "put" }) | { action: "remove"; scopeId: string; key: string },
) {
  if (!offline(session)) {
    ownScope(session, args.scopeId);
  }
  return args.action === "put" ? session.state.publish(args) : session.state.remove(args);
}

export function registerTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  getSession: () => AdapterSession | undefined,
): void {
  pi.registerTool({
    name: "peers_list",
    ...toolPresentation("peers_list"),
    label: "Session peers",
    description:
      "Discover authorized live exact runtimes. Presence is not responsiveness or completed work. Does not wake peers.",
    parameters: Type.Object({
      scopeIds: Type.Optional(Type.Array(scope, { minItems: 1, maxItems: 4, uniqueItems: true })),
      watch: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, args, signal) =>
      invoke(getSession, async (session) => {
        const scopes = args.scopeIds ?? [...session.client.effectiveScopes()];
        for (const selected of scopes) {
          ownScope(session, selected);
        }
        const reply = await session.client.discover(scopes, args.watch ?? false, signal);
        if (reply.forOp === "discover" && reply.outcome.tag === "ok") {
          return {
            ...reply.outcome.value,
            peers: reply.outcome.value.peers.flatMap((descriptor) => {
              const allowed = descriptor.scopeIds.filter((selected) =>
                permits(session.config, descriptor.peer.machineId, selected, "discover"),
              );
              return allowed.length === 0 ? [] : [{ ...descriptor, scopeIds: allowed }];
            }),
          };
        }
        return reply.outcome;
      }),
  });
  pi.registerTool({
    name: "peers_send",
    ...toolPresentation("peers_send"),
    label: "Send collaboration message",
    description:
      "Send one immutable authored collaboration push to an exact live PeerRef. The adapter creates one message ID for this invocation; retries retain it. Admitted means volatile inbox admission only. An unknown outcome must NOT be resent as new work/new ID.",
    parameters: Type.Object({ to: peer, scopeId: scope, message }, { additionalProperties: false }),
    execute: async (_id, args, signal) =>
      invoke(getSession, async (session) => {
        const frame = validateFrame(
          {
            v: 1,
            op: "send",
            rid: freshId(),
            ...args,
            message: { ...args.message, id: freshId() },
          },
          "local-client",
        );
        if (frame.op !== "send") {
          throw new Error("Invalid send");
        }
        const outcome = await session.send(frame.to, frame.scopeId, frame.message, signal);
        return {
          outcome,
          note:
            outcome.tag === "unknown"
              ? "The message may already have arrived. Do not call peers_send again for it; nothing is resent automatically."
              : "Admission is not model reading, persistence, acceptance of work, or completion.",
        };
      }),
  });
  pi.registerTool({
    name: "peers_take",
    ...toolPresentation("peers_take"),
    label: "Take collaboration inbox",
    description:
      "Explicitly transfer a small FIFO inbox batch. Frees payload slots but retains admission receipts. Does not reset native notice accounting. Source/provenance is included; authored references are inert.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),
    execute: async (_id, args) =>
      invoke(
        getSession,
        (session) => {
          const result = session.take(args.limit ?? 4);
          return {
            messages: result.messages.map(
              (delivery) => JSON.parse(deliveryText(delivery)) as unknown,
            ),
            note: result.note,
          };
        },
        () => true,
      ),
  });
  pi.registerTool({
    name: "peers_state",
    ...toolPresentation("peers_state"),
    label: "Published collaboration state",
    description:
      "Get/list authorized current publications without waking a publisher, or put/remove only this runtime's own publication. References never fetch or apply resources. No historical revision store.",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("get"),
        publisher: peer,
        scopeId: scope,
        key: scope,
        expectedRevision: Type.Optional(
          Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        ),
      }),
      Type.Object({
        action: Type.Literal("list"),
        publisher: peer,
        scopeId: scope,
      }),
      Type.Object({
        action: Type.Literal("put"),
        scopeId: scope,
        key: scope,
        record,
      }),
      Type.Object({
        action: Type.Literal("remove"),
        scopeId: scope,
        key: scope,
      }),
    ]),
    execute: async (_id, args, signal) =>
      invoke(
        getSession,
        async (session) => {
          if (args.action === "put" || args.action === "remove") {
            return mutateOwn(session, args);
          }
          ownScope(session, args.scopeId);
          if (!permits(session.config, args.publisher.machineId, args.scopeId, "read")) {
            return { tag: "error", code: "forbidden" };
          }
          const frame = validateFrame(
            {
              v: 1,
              op: args.action === "get" ? "state.get" : "state.list",
              rid: freshId(),
              publisher: args.publisher,
              scopeId: args.scopeId,
              ...(args.action === "get"
                ? {
                    key: args.key,
                    ...(args.expectedRevision === undefined
                      ? {}
                      : { expectedRevision: args.expectedRevision }),
                  }
                : {}),
            },
            "local-client",
          );
          if (frame.op !== "state.get" && frame.op !== "state.list") {
            throw new Error("Invalid state operation");
          }
          return session.client.operation(async () => {
            const reply = await session.client.request(frame, signal);
            return reply.outcome;
          });
        },
        (session) => (args.action === "put" || args.action === "remove") && offline(session),
      ),
  });
  pi.registerTool({
    name: "peers_interest",
    ...toolPresentation("peers_interest"),
    label: "Work report interest",
    description:
      "Add/renew or remove one volatile explicit work interest. Does not wake the publisher; does not grant permission or imply automatic broadcasts.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("remove")]),
      publisher: peer,
      scopeId: scope,
      work,
    }),
    execute: async (_id, args, signal) =>
      invoke(getSession, async (session) => {
        ownScope(session, args.scopeId);
        if (!permits(session.config, args.publisher.machineId, args.scopeId, "interest")) {
          return { tag: "error", code: "forbidden" };
        }
        const frame = validateFrame(
          {
            v: 1,
            op: args.action === "add" ? "interest.add" : "interest.remove",
            rid: freshId(),
            publisher: args.publisher,
            scopeId: args.scopeId,
            work: args.work,
          },
          "local-client",
        );
        if (frame.op !== "interest.add" && frame.op !== "interest.remove") {
          throw new Error("Invalid interest operation");
        }
        return session.client.operation(async () => {
          const reply = await session.client.request(frame, signal);
          return reply.outcome;
        });
      }),
  });
  pi.registerTool({
    name: "peers_report",
    ...toolPresentation("peers_report"),
    label: "Publish and report work",
    description:
      "Atomically publish own work report and snapshot bounded explicit recipients/interests, then send independent admission pushes (max four concurrent). Partial failures are reported; this is not a distributed transaction or resumable report action.",
    parameters: Type.Object({
      scopeId: scope,
      key: scope,
      record,
      notify: Type.Union([Type.Literal("interested"), Type.Literal("selected")]),
      recipients: Type.Optional(Type.Array(peer, { minItems: 1, maxItems: 8 })),
    }),
    execute: async (_id, args, signal) =>
      invoke(getSession, async (session) => {
        ownScope(session, args.scopeId);
        return session.report(args, signal);
      }),
  });
}
