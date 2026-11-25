import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Option, Result, Schema, SchemaIssue } from "effect";
import {
  PEERS_REPLY_CHANNEL,
  PEERS_REQUEST_CHANNEL,
  PeersRequest,
} from "../../shared/peers-channel";
import type { PeersReply } from "../../shared/peers-channel";
import { refusalText } from "../onboarding/outcome.js";
import { MAX_AUTHORED_BYTES } from "../protocol/schema.js";
import { validateFrame } from "../protocol/wire.js";
import { sessionHandle } from "./handles.js";
import { failureHint } from "./hints.js";
import { SEND_BUDGET_MS } from "./send.js";
import type { ToolSession } from "./tools.js";
import { discovered } from "./tools.js";
import { ConnectionFailure, freshId } from "./transport.js";

type Send = Extract<PeersRequest, { op: "send" }>;

const NOT_RUNNING =
  "Peers is not set up or not running in this session. Ask the user to run `/peers status`.";

const BROKEN =
  "The message breaks a peers protocol rule, such as a malformed replyTo. Nothing was sent.";

const decodeRequest = Schema.decodeUnknownResult(PeersRequest, { onExcessProperty: "error" });

type DecodedRequest = ReturnType<typeof decodeRequest>;

const decodeRequestId = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)) }),
);

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

function issueText(issue: SchemaIssue.Issue): string {
  return formatIssue(issue)
    .issues.map(({ path, message }) =>
      [(path ?? []).map(String).join("."), message].filter(Boolean).join(": "),
    )
    .join("; ");
}

function failure(id: string, code: string, note: string): PeersReply {
  return { id, ok: false, code, note };
}

async function list(
  session: ToolSession,
  id: string,
  scope: string | undefined,
): Promise<PeersReply> {
  const found = await discovered(session, scope);

  if ("failed" in found) {
    const { code } = found.failed;

    return failure(id, code, failureHint(code));
  }

  return {
    id,
    ok: true,
    peers: found.entries.map(({ peer, scopeId, label, self }) => ({ peer, scopeId, label, self })),
  };
}

function messageProblem(message: Send["message"]): string | undefined {
  if (message.kind === "reply" && message.replyTo === undefined) {
    return "A reply needs message.replyTo: the sender and messageId of the message it answers. Nothing was sent.";
  }

  if (message.kind === "request" && message.status !== undefined) {
    return "A request cannot carry a status; use kind update or reply to report one. Nothing was sent.";
  }

  return undefined;
}

function framed(request: Send) {
  const { message } = request;

  try {
    const frame = validateFrame(
      {
        v: 2,
        op: "send",
        rid: freshId(),
        to: request.to,
        scopeId: request.scope,
        budgetMs: SEND_BUDGET_MS,
        message: {
          ...message,
          id: request.messageId ?? freshId(),
          format: message.format ?? "markdown",
        },
      },
      "local-client",
    );

    return frame.op === "send" ? frame : undefined;
  } catch {
    return undefined;
  }
}

function sentOutcome(outcome: { readonly tag: string; readonly code?: string }) {
  if (outcome.tag === "admitted") {
    return { tag: "admitted" } as const;
  }

  return {
    tag: outcome.tag === "unknown" ? "unknown" : "not_admitted",
    code: outcome.code ?? "unavailable",
  } as const;
}

async function send(session: ToolSession, request: Send): Promise<PeersReply> {
  const { id, message } = request;
  const invalid = messageProblem(message);

  if (invalid !== undefined) {
    return failure(id, "invalid_input", invalid);
  }

  if (Buffer.byteLength(message.content, "utf8") > MAX_AUTHORED_BYTES) {
    return failure(id, "delivery_too_large", failureHint("delivery_too_large"));
  }

  const frame = framed(request);

  if (frame === undefined) {
    return failure(id, "invalid_input", BROKEN);
  }

  const outcome = await session.send(frame.to, frame.scopeId, frame.message);

  if (outcome.tag === "unknown") {
    session.unsure.record({
      handle: sessionHandle(frame.to.machineId, frame.to.sessionId),
      to: frame.to,
      scopeId: frame.scopeId,
      message: frame.message,
    });
  }

  return {
    id,
    ok: true,
    messageId: frame.message.id,
    outcome: sentOutcome(outcome),
  };
}

async function answer(
  getSession: () => ToolSession | undefined,
  id: string,
  decoded: DecodedRequest,
): Promise<PeersReply> {
  if (Result.isFailure(decoded)) {
    return failure(id, "invalid_input", `${issueText(decoded.failure.issue)}. Nothing was sent.`);
  }

  const session = getSession();

  if (session === undefined) {
    return failure(id, "unavailable", NOT_RUNNING);
  }

  const request = decoded.success;

  try {
    await session.client.recoverForTool();

    return request.op === "list"
      ? await list(session, id, request.scope)
      : await send(session, request);
  } catch (error) {
    if (error instanceof ConnectionFailure) {
      return failure(id, error.code, failureHint(error.code));
    }

    return failure(
      id,
      "unavailable",
      refusalText(error instanceof Error ? error : undefined, NOT_RUNNING),
    );
  }
}

export function registerBridge(
  events: Pick<ExtensionAPI["events"], "emit" | "on"> | undefined,
  getSession: () => ToolSession | undefined,
): void {
  if (events === undefined) {
    return;
  }

  events.on(PEERS_REQUEST_CHANNEL, (data) => {
    const requested = decodeRequestId(data);

    if (Option.isNone(requested)) {
      return;
    }

    answer(getSession, requested.value.id, decodeRequest(data))
      .then((reply) => {
        events.emit(PEERS_REPLY_CHANNEL, reply);

        return undefined;
      })
      .catch(() => undefined);
  });
}
