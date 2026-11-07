import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { ProtocolError } from "../protocol/json.js";
import { Message } from "../protocol/schema.js";
import type { Publication, WorkRef } from "../protocol/schema.js";
import { validateFrame } from "../protocol/wire.js";

const peer = { machineId: "alpha", sessionId: "session", runtimeNonce: "a".repeat(32) };
const work: WorkRef = { kind: "request", origin: peer, requestId: "2".repeat(32) };
const publication: Publication = {
  key: "report",
  revision: 1,
  category: "work",
  title: "Report",
  summary: "Summary",
  format: "text",
  preparation: "authored",
  work,
  status: "completed",
};
function publicationResult(record: unknown): unknown {
  return {
    v: 1,
    op: "result",
    rid: "1".repeat(32),
    forOp: "state.get",
    outcome: {
      tag: "ok",
      value: { publisher: peer, scopeId: "team", publication: record },
    },
  };
}

const decodeMessage = Schema.decodeUnknownSync(Message, { onExcessProperty: "error" });
const message = { id: "3".repeat(32), kind: "request", format: "text", content: "hello" };

describe("protocol domain schema API", () => {
  test("Message is usable independently for local authored tools", () => {
    expect(decodeMessage(message)).toStrictEqual(message);
    expect(() => decodeMessage({ ...message, extra: true })).toThrow(Schema.SchemaError);
  });

  test("typed work publications roundtrip through state.get results", () => {
    expect(validateFrame(publicationResult(publication), "local-client")).toStrictEqual(
      publicationResult(publication),
    );
  });

  test.each([
    { ...publication, work: undefined },
    { ...publication, category: "context" },
    { ...publication, title: "" },
    { ...publication, summary: "" },
    { ...publication, content: "" },
    {
      ...publication,
      refs: Array.from({ length: 9 }, () => ({
        kind: "publication",
        publisher: peer,
        key: "report",
        revision: 1,
      })),
    },
    { ...publication, content: "x".repeat(24_576) },
  ])("rejects invalid publication variant %#", (record) => {
    expect(() => validateFrame(publicationResult(record), "local-client")).toThrow(ProtocolError);
  });

  test("authored aggregate includes resource labels and locators", () => {
    const record = {
      ...publication,
      content: "x".repeat(24_560),
      refs: [
        { kind: "resource", machineId: "alpha", locator: "long-resource-locator", label: "Label" },
      ],
    };
    expect(() => validateFrame(publicationResult(record), "local-client")).toThrow(ProtocolError);
  });
});
