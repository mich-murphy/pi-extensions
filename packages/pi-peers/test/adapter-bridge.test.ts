import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { peersClient } from "../../shared/peers-channel";
import type { PeersSend } from "../../shared/peers-channel";
import { registerBridge } from "../adapter/bridge.js";
import type { ToolSession } from "../adapter/tools.js";
import type { Reply } from "../adapter/transport.js";
import { RefusalError } from "../onboarding/refusal.js";
import type { Message, PeerRef } from "../protocol/schema.js";
import { beta, discoverReply, self, toolSession } from "./tool-session-fixture.js";

const gamma: PeerRef = { machineId: "gamma", sessionId: "other", runtimeNonce: "c".repeat(32) };

type Sent = { to: PeerRef; scopeId: string; message: Message };

type BridgeOptions = {
  readonly outcome?: "admitted" | "unknown" | "not_admitted";
  readonly refuse?: Error;
  readonly absent?: boolean;
  readonly discovered?: Reply;
};

function fixture(options: BridgeOptions = {}) {
  const sent: Sent[] = [];

  const base = toolSession({
    recoverForTool: async () => {
      await Promise.resolve();

      if (options.refuse !== undefined) {
        throw options.refuse;
      }
    },
    discover: async () =>
      options.discovered ??
      discoverReply([
        { peer: self, label: "Me" },
        { peer: beta, label: "Beta\u0007" },
        { peer: gamma, label: "Gamma" },
      ]),
  });

  const session: ToolSession = {
    ...base,
    send: async (to, scopeId, message) => {
      sent.push({ to, scopeId, message });
      const tag = options.outcome ?? "admitted";

      return tag === "admitted"
        ? { tag, messageId: message.id, correlation: "none", durable: false }
        : { tag, messageId: message.id, code: "unavailable" };
    },
  };

  const bus = createEventBus();
  registerBridge(bus, () => (options.absent === true ? undefined : session));

  return { client: peersClient(bus, { timeoutMs: 1000 }), sent, unsure: base.unsure, bus };
}

const update = { to: beta, scope: "team", message: { kind: "update", content: "hi" } } as const;

describe("peers extension bridge", () => {
  test("list returns explicit PeerRefs filtered by discover permission", async () => {
    await expect(fixture().client.list()).resolves.toMatchObject({
      ok: true,
      peers: [
        { peer: self, scopeId: "team", label: "Me", self: true },
        { peer: beta, scopeId: "team", label: "Beta", self: false },
      ],
    });
  });
  test("send goes through the session with a markdown default and a fresh id", async () => {
    const fx = fixture();
    const result = await fx.client.send(update);
    expect(result).toMatchObject({ ok: true, outcome: { tag: "admitted" } });
    const id = String(fx.sent[0]?.message.id);
    expect(id).toMatch(/^[0-9a-f]{32}$/u);
    expect(fx.sent).toStrictEqual([
      {
        to: beta,
        scopeId: "team",
        message: { id, kind: "update", content: "hi", format: "markdown" },
      },
    ]);
    expect(result).toHaveProperty("messageId", fx.sent[0]?.message.id);
  });
  test("a caller messageId is kept so a retry after unknown reuses the same id", async () => {
    const fx = fixture({ outcome: "unknown" });
    const messageId = "d".repeat(32);
    const first = await fx.client.send({ ...update, messageId });
    const again = await fx.client.send({ ...update, messageId });
    expect(first).toStrictEqual({
      id: first.id,
      ok: true,
      messageId,
      outcome: { tag: "unknown", code: "unavailable" },
    });
    expect(again).toMatchObject({ messageId });
    expect(fx.sent.map((entry) => entry.message.id)).toStrictEqual([messageId, messageId]);
    expect(fx.unsure.lookup(messageId)?.entry.to).toStrictEqual(beta);
  });
  test.each<[PeersSend, string]>([
    [{ ...update, message: { kind: "reply", content: "x" } }, "A reply needs message.replyTo"],
    [
      { ...update, message: { kind: "request", content: "x", status: "completed" } },
      "A request cannot carry a status",
    ],
  ])("wire rules are refused before sending: %j", async (request, note) => {
    const fx = fixture();
    const result = await fx.client.send(request);
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(result).toHaveProperty("note", expect.stringContaining(note));
    expect(fx.sent).toHaveLength(0);
  });
  test("a malformed request names the field and sends nothing", async () => {
    const fx = fixture();
    const replies: unknown[] = [];
    fx.bus.on("pi-peers:reply", (data) => replies.push(data));
    fx.bus.emit("pi-peers:request", { id: "r1", op: "send", scope: "team", message: {} });
    fx.bus.emit("pi-peers:request", { op: "list" });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: "r1", ok: false, code: "invalid_input" });
    expect(JSON.stringify(replies[0])).toContain("to");
    expect(fx.sent).toHaveLength(0);
  });
  test("an oversized message is refused as too large", async () => {
    const fx = fixture();

    const result = await fx.client.send({
      ...update,
      message: { kind: "update", content: "é".repeat(12_289) },
    });

    expect(result).toMatchObject({ ok: false, code: "delivery_too_large" });
    expect(fx.sent).toHaveLength(0);
  });
  test.each<[Reply, string]>([
    [
      {
        v: 2,
        op: "result",
        rid: "0".repeat(32),
        forOp: "discover",
        outcome: { tag: "error", code: "forbidden" },
      },
      "forbidden",
    ],
    [
      { v: 2, op: "result", rid: "0".repeat(32), forOp: "ping", outcome: { tag: "ok", value: {} } },
      "protocol_error",
    ],
  ])("a failed discovery is reported with its code: %j", async (discovered, code) => {
    await expect(fixture({ discovered }).client.list()).resolves.toMatchObject({ ok: false, code });
  });
  test("a target the protocol rejects is invalid input and sends nothing", async () => {
    const fx = fixture();
    const result = await fx.client.send({ ...update, to: { ...beta, sessionId: "bell\u0007" } });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    expect(fx.sent).toHaveLength(0);
  });
  test("a send that was not admitted reports its code and is not kept for retry", async () => {
    const fx = fixture({ outcome: "not_admitted" });
    const result = await fx.client.send(update);
    expect(result).toMatchObject({
      ok: true,
      outcome: { tag: "not_admitted", code: "unavailable" },
    });
    expect(fx.unsure.lookup(String(fx.sent[0]?.message.id))).toBeUndefined();
  });
  test("no session is unavailable", async () => {
    await expect(fixture({ absent: true }).client.list()).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });
  test("a refusal while recovering is unavailable with its next step", async () => {
    const refuse = new RefusalError("the gateway program is out of date", "Run pi update");
    await expect(fixture({ refuse }).client.list()).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      note: "The gateway program is out of date. Run pi update.",
    });
  });
});
