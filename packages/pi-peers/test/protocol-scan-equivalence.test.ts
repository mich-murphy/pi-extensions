import { describe, expect, test } from "vitest";
import { ProtocolError } from "../protocol/json.js";
import { decodeFrame, encodeFrame, validateFrame } from "../protocol/wire.js";

const rid = "1".repeat(32);
const peerA = `{"machineId":"alpha","sessionId":"a","runtimeNonce":"${"a".repeat(32)}"}`;
const peerB = `{"machineId":"beta","sessionId":"b","runtimeNonce":"${"b".repeat(32)}"}`;

function deliverText(content: string, budget = "15000", extra = ""): string {
  return `{"v":2,"op":"deliver","rid":"${rid}"${extra},"from":${peerA},"to":${peerB},"scopeId":"team","budgetMs":${budget},"message":{"id":"${"2".repeat(32)}","kind":"request","format":"text","content":"${content}"}}`;
}

function framed(text: string): Uint8Array {
  const body = Buffer.from(text, "utf8");
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length, false);
  bytes.set(body, 4);

  return bytes;
}

const nested = `${"[".repeat(17)}${"]".repeat(17)}`;

describe("wire decode keeps every scanner rejection", () => {
  test.each([
    ["duplicate key", deliverText("hi", "15000", `,"rid":"${rid}"`)],
    ["lone surrogate escape", deliverText(String.raw`\ud800`)],
    ["form feed whitespace", deliverText("hi").replace("{", "{\f")],
    ["null scalar", deliverText("hi", "null")],
    ["negative integer", deliverText("hi", "-1")],
    ["fraction", deliverText("hi", "1.0")],
    ["exponent", deliverText("hi", "1e3")],
    ["leading zero", deliverText("hi", "015")],
    ["unsafe integer", deliverText("hi", "9007199254740993")],
    ["trailing data", `${deliverText("hi")} x`],
    ["too deep", deliverText("hi", "15000", `,"x":${nested}`)],
    ["unterminated string", deliverText("hi").slice(0, -4)],
    ["oversized body", deliverText("a".repeat(32_764))],
  ])("decodeFrame rejects %s", (_name, text) => {
    expect(() => decodeFrame(framed(text), "adapter-delivery")).toThrow(ProtocolError);
  });

  test("decodeFrame accepts escaped wire text longer than its re-encoding", () => {
    const frame = decodeFrame(framed(deliverText(String.raw`A\/b`)), "adapter-delivery");

    expect(frame).toMatchObject({ op: "deliver", message: { content: "A/b" } });
  });
});

describe("in-process frames keep the encoded body scan", () => {
  const controls = {
    v: 2,
    op: "send",
    rid,
    to: { machineId: "beta", sessionId: "b", runtimeNonce: "b".repeat(32) },
    scopeId: "team",
    budgetMs: 15_000,
    message: {
      id: "2".repeat(32),
      kind: "request",
      format: "text",
      content: "\u0001".repeat(6000),
    },
  };

  test("validateFrame rejects control content whose encoded body exceeds the limit", () => {
    expect(() => validateFrame(controls, "local-client")).toThrow(ProtocolError);
  });

  test("encodeFrame rejects control content whose encoded body exceeds the limit", () => {
    expect(() => encodeFrame(controls, "local-client")).toThrow(ProtocolError);
  });
});
