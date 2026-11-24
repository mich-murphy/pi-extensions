import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_AUTHORED_BYTES } from "../protocol/schema.js";
import { validateFrame } from "../protocol/wire.js";
import { permits, visibleText } from "./config.js";
import { failureHint, sendHint } from "./hints.js";
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

type ToolValue = {
  content: { type: "text"; text: string }[];
  details: { value: unknown };
  isError?: boolean;
};
function output(value: unknown): ToolValue {
  const result: ToolValue = {
    content: [{ type: "text", text: visibleText(JSON.stringify(value)) }],
    details: { value },
  };
  return failed(value) ? { ...result, isError: true } : result;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function fieldsOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function failed(value: unknown): boolean {
  const fields = fieldsOf(value);
  return fields.tag === "error" || fieldsOf(fields.outcome).tag === "not_admitted";
}
function hinted(value: unknown): unknown {
  const fields = fieldsOf(value);
  if (fields.tag !== "error" || fields.note !== undefined || typeof fields.code !== "string") {
    return value;
  }
  const resource = typeof fields.resource === "string" ? fields.resource : undefined;
  return { ...fields, note: failureHint(fields.code, resource) };
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
    return output(hinted(await run(session)));
  } catch (error) {
    const code = error instanceof ConnectionFailure ? error.code : "invalid_input";
    return output({ tag: "error", code, note: failureHint(code) });
  }
}
function ownScope(session: AdapterSession, scopeId: string): void {
  if (!session.client.effectiveScopes().has(scopeId)) {
    throw new ConnectionFailure("unavailable", false);
  }
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
        return { outcome, note: sendHint(outcome) };
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
}
