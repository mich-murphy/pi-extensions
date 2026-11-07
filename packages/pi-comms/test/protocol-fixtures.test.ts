import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { sameMessage, samePeer, scopedMessageKey } from "../protocol/identity.js";
import { decodeJson, ProtocolError } from "../protocol/json.js";
import { decodeFrame, encodeFrame, frameBodyLength, validateFrame } from "../protocol/wire.js";

const fixtureSchema = Schema.Struct({
  contract: Schema.String,
  encoding: Schema.String,
  cases: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      boundary: Schema.String,
      role: Schema.Literals(["local-client", "gateway-forward", "adapter-delivery", "remote-link"]),
      hexFile: Schema.String,
      expected: Schema.Union([
        Schema.Struct({ tag: Schema.Literal("accepted"), value: Schema.Unknown }),
        Schema.Struct({ tag: Schema.Literal("rejected"), connection: Schema.Literal("closed") }),
      ]),
    }),
  ),
});
const manifest: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/manifest.json", import.meta.url), "utf8"),
);
const fixtures = Schema.decodeUnknownSync(fixtureSchema)(manifest).cases;
function bytes(file: string): Uint8Array {
  return Buffer.from(
    readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8").trim(),
    "hex",
  );
}
const accepted = fixtures.flatMap((fixture) =>
  fixture.expected.tag === "accepted" ? [{ ...fixture, value: fixture.expected.value }] : [],
);
const rejected = fixtures.filter((fixture) => fixture.expected.tag === "rejected");

function decodeFixture(fixture: (typeof fixtures)[number]): unknown {
  const raw = bytes(fixture.hexFile);
  return fixture.boundary === "json" ? decodeJson(raw) : decodeFrame(raw, fixture.role);
}

const sender = { machineId: "alpha", sessionId: "session", runtimeNonce: "a".repeat(32) };
const recipient = { ...sender, machineId: "beta" };
const message = { id: "2".repeat(32), kind: "request", content: "hello", format: "text" } as const;

describe("v16 shared exact-byte conformance", () => {
  test.each(accepted)("accept $name ($boundary / $role)", (fixture) => {
    expect(decodeFixture(fixture)).toStrictEqual(fixture.value);
  });

  test.each(rejected)("close $name ($boundary / $role)", (fixture) => {
    expect(() => decodeFixture(fixture)).toThrow(ProtocolError);
  });

  test("validates and encodes the same exact envelope", () => {
    const value = {
      v: 1,
      op: "send",
      rid: "1".repeat(32),
      to: recipient,
      scopeId: "team",
      message,
    };
    const encoded = encodeFrame(value, "local-client");
    expect(frameBodyLength(encoded.subarray(0, 4))).toBe(encoded.length - 4);
    expect(decodeFrame(encoded, "local-client")).toStrictEqual(
      validateFrame(value, "local-client"),
    );
  });

  test("identity equality preserves nonce and scope; rid is not a key", () => {
    expect(samePeer(sender, { ...sender })).toBe(true);
    expect(samePeer(sender, { ...sender, runtimeNonce: "b".repeat(32) })).toBe(false);
    expect(scopedMessageKey(sender, recipient, "one", message.id)).not.toBe(
      scopedMessageKey(sender, recipient, "two", message.id),
    );
    expect(scopedMessageKey(sender, recipient, "one", message.id)).not.toBe(
      scopedMessageKey(recipient, sender, "one", message.id),
    );
  });

  test("decoded immutable equality ignores key order but preserves optional absence and Unicode", () => {
    expect(
      sameMessage(message, { format: "text", content: "hello", kind: "request", id: message.id }),
    ).toBe(true);
    expect(sameMessage(message, { ...message, refs: [] })).toBe(false);
    expect(sameMessage({ ...message, content: "é" }, { ...message, content: "e\u0301" })).toBe(
      false,
    );
  });
});
