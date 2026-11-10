import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { ProtocolError } from "../protocol/json.js";
import { Frame, Message } from "../protocol/schema.js";
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
const decodeFrame = Schema.decodeUnknownSync(Frame, { onExcessProperty: "error" });
const CAP = 24_576;
const frame = (content: string) => publicationResult({ ...publication, content });
// Title "Report" and summary "Summary" are authored too, so this content fills the aggregate cap exactly.
const publicationContentAtCap = CAP - "ReportSummary".length;
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

  describe("authored content cap of 24,576 UTF-8 bytes", () => {
    test("a Message decoded on its own accepts content exactly at the cap and rejects one byte more", () => {
      expect(decodeMessage({ ...message, content: "x".repeat(CAP) }).content).toHaveLength(CAP);
      expect(() => decodeMessage({ ...message, content: "x".repeat(CAP + 1) })).toThrow(
        Schema.SchemaError,
      );
    });

    test("the per-field cap counts bytes, not characters", () => {
      // 8192 three-byte characters are 24,576 bytes but only 8,192 characters.
      expect(decodeMessage({ ...message, content: "€".repeat(8192) }).content).toHaveLength(8192);
      expect(() => decodeMessage({ ...message, content: `${"€".repeat(8192)}x` })).toThrow(
        Schema.SchemaError,
      );
    });

    test("the frame schema's publication content cap is exact", () => {
      expect(() => decodeFrame(frame("x".repeat(CAP)))).not.toThrow();
      expect(() => decodeFrame(frame("x".repeat(CAP + 1)))).toThrow(Schema.SchemaError);
    });

    test("validateFrame bounds the sum of every authored field, exactly at the cap", () => {
      expect(() =>
        validateFrame(frame("x".repeat(publicationContentAtCap)), "local-client"),
      ).not.toThrow();
      expect(() =>
        validateFrame(frame("x".repeat(publicationContentAtCap + 1)), "local-client"),
      ).toThrow(ProtocolError);
    });

    test("the aggregate counts UTF-8 bytes of multi-byte content", () => {
      const wide = "€".repeat(8000);
      const rest = publicationContentAtCap - 24_000;
      expect(() =>
        validateFrame(frame(`${wide}${"x".repeat(rest)}`), "local-client"),
      ).not.toThrow();
      expect(() => validateFrame(frame(`${wide}${"x".repeat(rest + 1)}`), "local-client")).toThrow(
        ProtocolError,
      );
    });
  });
});
