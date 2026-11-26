import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { sampledFrom } from "@hegeldev/hegel/generators";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import {
  PEERS_REPLY_CHANNEL,
  PEERS_REQUEST_CHANNEL,
  PeersRequest,
  peersClient,
} from "../peers-channel";

const beta = { machineId: "beta", sessionId: "them", runtimeNonce: "b".repeat(32) };
const decode = Schema.decodeUnknownSync(PeersRequest, { onExcessProperty: "error" });

const withId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));

const withMessageId = Schema.decodeUnknownSync(Schema.Struct({ messageId: Schema.String }));

function answering(foreign: ReadonlyArray<string>) {
  const bus = createEventBus();
  const requests: Array<unknown> = [];
  bus.on(PEERS_REQUEST_CHANNEL, (data) => {
    requests.push(data);

    for (const id of foreign) {
      bus.emit(PEERS_REPLY_CHANNEL, { id, ok: false, code: "forbidden", note: "not yours" });
    }

    bus.emit(PEERS_REPLY_CHANNEL, { id: "not a valid id!", ok: true, peers: [] });
    bus.emit(PEERS_REPLY_CHANNEL, {
      id: withId(data).id,
      ok: true,
      peers: [{ peer: beta, scopeId: "team", label: "Beta", self: false }],
    });
  });

  return { bus, requests };
}

describe("peersClient", () => {
  test("correlates the reply by id and ignores foreign and malformed replies", async () => {
    const { bus, requests } = answering(["a", "b-1", "c_2"]);
    const result = await peersClient(bus).list("team");
    expect(result).toMatchObject({
      ok: true,
      peers: [{ peer: beta, scopeId: "team", label: "Beta", self: false }],
    });
    expect(requests).toStrictEqual([{ op: "list", scope: "team", id: result.id }]);
  });
  test("a reply of the wrong kind is reported, not returned as a send result", async () => {
    const { bus } = answering([]);

    const result = await peersClient(bus).send({
      to: beta,
      scope: "team",
      message: { kind: "update", content: "hi" },
    });

    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });
  test("no answer within the timeout resolves unavailable", async () => {
    const result = await peersClient(createEventBus(), { timeoutMs: 5 }).list();
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
  });
  test("an already aborted call is cancelled without emitting; a later abort is unavailable", async () => {
    const bus = createEventBus();
    const seen: Array<unknown> = [];
    bus.on(PEERS_REQUEST_CHANNEL, (data) => seen.push(data));
    const controller = new AbortController();
    controller.abort();
    await expect(peersClient(bus).list(undefined, controller.signal)).resolves.toMatchObject({
      ok: false,
      code: "cancelled",
      note: "The request was aborted before it was sent. Nothing was sent.",
    });
    const pending = peersClient(bus).list(undefined, AbortSignal.timeout(5));
    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      note: "The request was aborted before pi-peers answered.",
    });
    expect(seen).toHaveLength(1);
  });
  test("an unanswered send returns the messageId it used so a retry is safe", async () => {
    const bus = createEventBus();
    const seen: Array<unknown> = [];
    bus.on(PEERS_REQUEST_CHANNEL, (data) => seen.push(data));

    const result = await peersClient(bus, { timeoutMs: 5 }).send({
      to: beta,
      scope: "team",
      message: { kind: "update", content: "hi" },
    });

    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(result).toHaveProperty("messageId", expect.stringMatching(/^[0-9a-f]{32}$/u));
    expect(result).toHaveProperty(
      "note",
      expect.stringContaining("send again with this messageId"),
    );
    expect(seen.map((data) => withMessageId(data).messageId)).toStrictEqual([
      withMessageId(result).messageId,
    ]);
  });
  test("a caller messageId is sent unchanged", async () => {
    const bus = createEventBus();
    const seen: Array<unknown> = [];
    bus.on(PEERS_REQUEST_CHANNEL, (data) => seen.push(data));
    const messageId = "f".repeat(32);
    await peersClient(bus, { timeoutMs: 5 }).send({
      to: beta,
      scope: "team",
      messageId,
      message: { kind: "update", content: "hi" },
    });
    expect(seen).toMatchObject([{ op: "send", messageId }]);
  });
  test("generated requests decode unchanged", () => {
    assertHegel(propertySettings(200), (tc) => {
      const kind = tc.draw(sampledFrom(["request", "reply", "update"] as const), "kind");
      const content = tc.draw(sampledFrom(["x", "é", "line\nbreak", "🙂"]), "content");
      const scope = tc.draw(sampledFrom(["team", "a-b_c", "Z9"]), "scope");

      const request = {
        id: tc.draw(sampledFrom(["1", "abc", "a-b_c"]), "id"),
        op: "send",
        to: beta,
        scope,
        message: {
          kind,
          content,
          replyTo: { sender: beta, messageId: "e".repeat(32) },
        },
      };

      assert.deepEqual(decode(request), request);
      assert.deepEqual(decode({ id: "x", op: "list", scope }), { id: "x", op: "list", scope });
      assert.throws(() => decode({ ...request, scope: `${scope} bad` }));
    });
  });
});
