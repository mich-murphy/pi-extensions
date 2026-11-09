import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Schema } from "effect";
import { describe, test } from "vitest";
import { sameMessage, scopedMessageKey } from "../protocol/identity.js";
import { decodeJson, ProtocolError } from "../protocol/json.js";
import { Message } from "../protocol/schema.js";
import type { BoundaryRole } from "../protocol/wire.js";
import { decodeFrame, encodeFrame, frameBodyLength } from "../protocol/wire.js";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled, printBlob: true };

const adversarial = gs.oneOf(
  gs.sampledFrom(["", ",", "][", '"', "\\", '","', String.raw`\"`, "[", "]", "a", "a,b"]),
  gs.text({ maxSize: 4 }),
);
const codePoint = gs.oneOf(
  gs.integers({ minValue: 0, maxValue: 0x10_ff_ff }),
  gs.sampledFrom([0, 0x7f, 0xfe_ff, 0xff_ff, 0x1_00_00, 0x10_ff_ff]),
);

/** Maps the surrogate block D800..DFFF onto E000..E7FF so every value is a scalar. */
function toScalar(value: number): number {
  return value >= 0xd8_00 && value <= 0xdf_ff ? value + 0x8_00 : value;
}

const nonce = "a".repeat(32);
const rid = "1".repeat(32);
const peerOf = (machineId: string) => ({ machineId, sessionId: "s", runtimeNonce: nonce });
type Case = { role: BoundaryRole; frame: Record<string, unknown> };

/** One case per op in schema.ts `requests`/`results`/`event` that a role in wire.ts `roleOperations` admits. */
function frameCases(content: string): Case[] {
  const message = { id: "2".repeat(32), kind: "request", format: "text", content };
  const head = { v: 1, rid };
  const work = { kind: "request", origin: peerOf("alpha"), requestId: rid };
  const routedBodies = [
    { op: "send", to: peerOf("beta"), scopeId: "team", message },
    { op: "state.get", publisher: peerOf("beta"), scopeId: "team", key: "k", expectedRevision: 3 },
    { op: "state.list", publisher: peerOf("beta"), scopeId: "team" },
    { op: "interest.add", publisher: peerOf("beta"), scopeId: "team", work },
    { op: "interest.remove", publisher: peerOf("beta"), scopeId: "team", work },
  ];
  const binding = {
    messageId: rid,
    sender: peerOf("alpha"),
    recipient: peerOf("beta"),
    scopeId: "team",
  };
  const cases: Case[] = [];
  const add = (role: BoundaryRole, body: Record<string, unknown>) =>
    cases.push({ role, frame: { ...head, ...body } });
  add("local-client", {
    op: "register",
    sessionId: "s",
    runtimeNonce: nonce,
    scopeIds: ["team"],
    label: "l",
  });
  add("local-client", { op: "close" });
  add("remote-link", { op: "ping" });
  for (const role of ["local-client", "remote-link"] as const) {
    add(role, { op: "discover", scopeIds: ["team"], watch: true });
    add(role, { op: "unwatch", watchRid: rid });
  }
  for (const body of routedBodies) {
    add("local-client", body);
    for (const role of ["gateway-forward", "remote-link"] as const) {
      add(role, { ...body, from: peerOf("alpha") });
    }
    if (body.op !== "send") {
      add("adapter-delivery", { ...body, from: peerOf("alpha") });
    }
  }
  add("adapter-delivery", {
    op: "deliver",
    from: peerOf("alpha"),
    to: peerOf("beta"),
    scopeId: "team",
    message,
  });
  add("local-client", { op: "result", forOp: "close", outcome: { tag: "ok", value: {} } });
  add("local-client", {
    op: "result",
    forOp: "send",
    outcome: { tag: "admitted", binding, correlation: "none" },
  });
  add("local-client", { op: "roster.event", event: { tag: "remove", peer: peerOf("beta") } });
  return cases;
}

const routedOps = new Set(["send", "state.get", "state.list", "interest.add", "interest.remove"]);

function assertRoundtrip({ role, frame }: Case): void {
  assert.deepStrictEqual(decodeFrame(encodeFrame(frame, role), role), frame);
  if (routedOps.has(String(frame.op))) {
    // `from` presence rule: required for every role except local-client, forbidden for it.
    const { from, ...without } = frame;
    const flipped = role === "local-client" ? { ...frame, from: peerOf("alpha") } : without;
    assert.notEqual(from === undefined, role !== "local-client");
    assert.throws(() => encodeFrame(flipped, role), ProtocolError);
  }
}

function assertSurrogateRejected(prefix: string, surrogate: number): void {
  const content = `${prefix}${String.fromCodePoint(surrogate)}`;
  const send = at(
    frameCases(content).filter(
      (entry) => entry.frame.op === "send" && entry.role === "local-client",
    ),
    0,
  );
  assert.throws(() => encodeFrame(send.frame, send.role), ProtocolError);
  const escaped = `\\u${surrogate.toString(16)}`;
  const body = Buffer.from(`{"content":"${prefix}${escaped}"}`, "utf8");
  assert.throws(() => decodeJson(body), ProtocolError);
}

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  assert.ok(value !== undefined);
  return value;
}

function deriveSecond(
  first: readonly string[],
  plan: { reuse: boolean[]; fresh: string[]; shift: boolean; field: number; cut: number },
): string[] {
  if (plan.shift) {
    return shiftBoundary(first, plan.field, plan.cut);
  }
  return first.map((value, index) => (plan.reuse[index] === true ? value : at(plan.fresh, index)));
}

/** Re-splits two adjacent fields at a comma so naive comma-joined encodings collide. */
function shiftBoundary(values: readonly string[], field: number, cut: number): string[] {
  const joined = `${at(values, field)},${at(values, field + 1)}`;
  const commas = Array.from(joined, (character, index) => (character === "," ? index : -1)).filter(
    (index) => index >= 0,
  );
  const comma = at(commas, cut % commas.length);
  return values.map((value, index) => {
    if (index === field) {
      return joined.slice(0, comma);
    }
    return index === field + 1 ? joined.slice(comma + 1) : value;
  });
}

function keyOf(values: readonly string[]): string {
  return scopedMessageKey(
    { machineId: at(values, 0), sessionId: at(values, 1), runtimeNonce: at(values, 2) },
    { machineId: at(values, 3), sessionId: at(values, 4), runtimeNonce: at(values, 5) },
    at(values, 6),
    at(values, 7),
  );
}

function assertKeyInjective(first: readonly string[], second: readonly string[]): void {
  assert.equal(
    keyOf(first) === keyOf(second),
    first.every((value, index) => value === second[index]),
  );
}

function escapedCharacter(character: string): string {
  return `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
}

describe("Hegel v16 bounded protocol properties", () => {
  test("every client-role frame variant roundtrips with astral and BOM content", () => {
    new Hegel((tc) => {
      const index = tc.draw(
        gs.integers({ minValue: 0, maxValue: frameCases("x").length - 1 }),
        "variant",
      );
      const points = tc.draw(gs.arrays(codePoint, { maxSize: 64 }), "content");
      const content = `content:${points.map((value) => String.fromCodePoint(toScalar(value))).join("")}`;
      assertRoundtrip(at(frameCases(content), index));
    })
      .databaseKey("session-communication/ts/roundtrip")
      .settings(settings)
      .runSync();
  });

  test("lone surrogates are rejected on encode and decode", () => {
    new Hegel((tc) => {
      const surrogate = tc.draw(gs.integers({ minValue: 0xd8_00, maxValue: 0xdf_ff }), "surrogate");
      const prefix = tc.draw(
        gs.text({ maxSize: 8, maxCodepoint: 0x7e, minCodepoint: 0x41, excludeCharacters: "\\" }),
        "prefix",
      );
      assertSurrogateRejected(prefix, surrogate);
    })
      .databaseKey("session-communication/ts/lone-surrogate")
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

  test("scopedMessageKey is injective over adversarial tuples", () => {
    new Hegel((tc) => {
      const first = tc.draw(gs.arrays(adversarial, { minSize: 8, maxSize: 8 }), "first");
      const reuse = tc.draw(gs.arrays(gs.booleans(), { minSize: 8, maxSize: 8 }), "reuse");
      const fresh = tc.draw(gs.arrays(adversarial, { minSize: 8, maxSize: 8 }), "fresh");
      const field = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }), "field");
      const cut = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }), "cut");
      const shift = tc.draw(gs.booleans(), "shift-boundary");
      const second = deriveSecond(first, { reuse, fresh, shift, field, cut });
      assertKeyInjective(first, second);
    })
      .databaseKey("session-communication/ts/scoped-idempotency")
      .settings(settings)
      .runSync();
  });
});
