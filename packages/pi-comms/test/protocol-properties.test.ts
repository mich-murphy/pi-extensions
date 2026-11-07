import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Schema } from "effect";
import { describe, test } from "vitest";
import { sameMessage, scopedMessageKey } from "../protocol/identity.js";
import { decodeJson, ProtocolError } from "../protocol/json.js";
import { Message } from "../protocol/schema.js";
import { decodeFrame, encodeFrame, frameBodyLength } from "../protocol/wire.js";

const sender = { machineId: "alpha", sessionId: "s", runtimeNonce: "a".repeat(32) };
const recipient = { ...sender, machineId: "beta" };
const settings = { testCases: 200, seed: 12_345n, database: Database.disabled, printBlob: true };

function escapedCharacter(character: string): string {
  return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
}

describe("Hegel v16 bounded protocol properties", () => {
  test("generated authored values roundtrip through strict framing", () => {
    new Hegel((tc) => {
      const values = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 255 }), { maxSize: 64 }),
        "content",
      );
      const content = `content:${values.map((value) => String.fromCodePoint(value)).join("")}`;
      const message = { id: "2".repeat(32), kind: "request", format: "text", content } as const;
      const frame = {
        v: 1,
        op: "send",
        rid: "1".repeat(32),
        scopeId: "team",
        to: recipient,
        message,
      };
      assert.deepStrictEqual(
        decodeFrame(encodeFrame(frame, "local-client"), "local-client"),
        frame,
      );
      assert.equal(
        sameMessage(message, { content, format: "text", kind: "request", id: message.id }),
        true,
      );
    })
      .databaseKey("session-communication/ts/roundtrip")
      .settings(settings)
      .runSync();
  });

  test("escaped duplicate keys are never accepted", () => {
    new Hegel((tc) => {
      const code = tc.draw(gs.integers({ minValue: 97, maxValue: 122 }), "key");
      const key = String.fromCodePoint(code);
      const escaped = `\\u${code.toString(16).padStart(4, "0")}`;
      const body = Buffer.from(`{"${key}":0,"${escaped}":1}`, "utf8");
      assert.throws(() => decodeJson(body), ProtocolError);
    })
      .databaseKey("session-communication/ts/duplicate-key")
      .settings(settings)
      .runSync();
  });

  test("integer decimal spellings are rejected even when numerically integral", () => {
    new Hegel((tc) => {
      const value = tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 }), "integer");
      assert.throws(() => decodeJson(Buffer.from(`{"value":${value}.0}`)), ProtocolError);
      assert.throws(() => decodeJson(Buffer.from(`{"value":${value}e0}`)), ProtocolError);
      assert.deepStrictEqual(decodeJson(Buffer.from(`{"value":${value}}`)), { value });
    })
      .databaseKey("session-communication/ts/lexical-number")
      .settings(settings)
      .runSync();
  });

  test("equivalent escaping and key order preserve decoded immutable identity", () => {
    new Hegel((tc) => {
      const values = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 255 }), { maxSize: 64 }),
        "content",
      );
      const content = `content:${values.map((value) => String.fromCodePoint(value)).join("")}`;
      const literal = { id: "2".repeat(32), kind: "request", format: "text", content };
      const escaped = `"${Array.from(content, (character) => escapedCharacter(character)).join("")}"`;
      const reordered = JSON.stringify({
        content,
        format: "text",
        kind: "request",
        id: literal.id,
      }).replace(JSON.stringify(content), escaped);
      const decodeMessage = Schema.decodeUnknownSync(Message, { onExcessProperty: "error" });
      assert.equal(
        sameMessage(
          decodeMessage(decodeJson(Buffer.from(JSON.stringify(literal)))),
          decodeMessage(decodeJson(Buffer.from(reordered))),
        ),
        true,
      );
      assert.equal(
        sameMessage(decodeMessage(literal), decodeMessage({ ...literal, content: `${content}!` })),
        false,
      );
    })
      .databaseKey("session-communication/ts/decoded-equality")
      .settings(settings)
      .runSync();
  });

  test("invalid declarations are rejected before any body is supplied", () => {
    new Hegel((tc) => {
      const length = tc.draw(
        gs.integers({ minValue: 32_765, maxValue: 0xff_ff_ff_ff }),
        "declared-length",
      );
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(length);
      assert.throws(() => frameBodyLength(prefix), ProtocolError);
    })
      .databaseKey("session-communication/ts/invalid-prefix")
      .settings(settings)
      .runSync();
  });

  test("malformed UTF8 cannot be normalized into authored strings", () => {
    new Hegel((tc) => {
      const byte = tc.draw(gs.integers({ minValue: 128, maxValue: 191 }), "continuation-byte");
      const body = Buffer.concat([
        Buffer.from('{"content":"'),
        Buffer.from([byte]),
        Buffer.from('"}'),
      ]);
      assert.throws(() => decodeJson(body), ProtocolError);
    })
      .databaseKey("session-communication/ts/malformed-utf8")
      .settings(settings)
      .runSync();
  });

  test("scope changes namespace without changing message identity", () => {
    new Hegel((tc) => {
      const value = tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 }), "scope");
      assert.notEqual(
        scopedMessageKey(sender, recipient, `a${value}`, "2".repeat(32)),
        scopedMessageKey(sender, recipient, `b${value}`, "2".repeat(32)),
      );
    })
      .databaseKey("session-communication/ts/scoped-idempotency")
      .settings(settings)
      .runSync();
  });
});
