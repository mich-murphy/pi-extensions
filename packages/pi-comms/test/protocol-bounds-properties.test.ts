import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { decodeJson, ProtocolError } from "../protocol/json.js";
import type { BoundaryRole } from "../protocol/wire.js";
import { decodeFrame, encodeFrame, frameBodyLength, validateFrame } from "../protocol/wire.js";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled, printBlob: true };
const rid = "1".repeat(32);
const nonce = "a".repeat(32);

// Limits, cited from source: json.ts:1 MAX_BODY_BYTES 32_764 (also wire.ts:16),
// json.ts:83 array 64, json.ts:108 depth 16, wire.ts:89 authored 24_576, wire.ts:76 descriptor 512.
const BODY_MAX = 32_764;
const AUTHORED_MAX = 24_576;
const DESCRIPTOR_MAX = 512;
const ARRAY_MAX = 64;
const DEPTH_MAX = 16;

/** Edge offsets around a limit: accept iff offset <= 0. */
const edge = gs.integers({ minValue: -3, maxValue: 3 });

function accepts(run: () => unknown): boolean {
  try {
    run();
    return true;
  } catch (error) {
    assert.ok(error instanceof ProtocolError, `non-ProtocolError thrown: ${String(error)}`);
    return false;
  }
}

function withPrefix(body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length, false);
  bytes.set(body, 4);
  return bytes;
}

/** Every frame entry point must agree with the closed-form oracle. */
function assertFrameEdge(value: unknown, role: BoundaryRole, expected: boolean): void {
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  assert.equal(
    accepts(() => validateFrame(value, role)),
    expected,
    "validateFrame",
  );
  assert.equal(
    accepts(() => encodeFrame(value, role)),
    expected,
    "encodeFrame",
  );
  assert.equal(
    accepts(() => decodeFrame(withPrefix(raw), role)),
    expected,
    "decodeFrame",
  );
}

function sendFrame(contentBytes: number): unknown {
  return {
    v: 1,
    op: "send",
    rid,
    to: { machineId: "beta", sessionId: "s", runtimeNonce: nonce },
    scopeId: "team",
    message: {
      id: "2".repeat(32),
      kind: "request",
      format: "text",
      content: "a".repeat(contentBytes),
    },
  };
}

function makeDescriptor(sessionId: string) {
  return {
    peer: { machineId: "beta", sessionId, runtimeNonce: nonce },
    label: "l",
    scopeIds: ["a", "b", "c", "d"].map((letter) => letter.repeat(64)),
  };
}

function upsertWithDescriptorBytes(size: number): unknown {
  const make = makeDescriptor;
  const base = Buffer.byteLength(JSON.stringify(make("s")), "utf8");
  const descriptor = make("s".repeat(1 + size - base));
  assert.equal(Buffer.byteLength(JSON.stringify(descriptor), "utf8"), size);
  return { v: 1, rid, op: "roster.event", event: { tag: "upsert", peer: descriptor } };
}

function nestedObject(levels: number): Uint8Array {
  return Buffer.from(`${'{"a":'.repeat(levels - 1)}{}${"}".repeat(levels - 1)}`, "utf8");
}

function arrayObject(length: number): Uint8Array {
  return Buffer.from(JSON.stringify({ a: Array.from({ length }, () => 1) }), "utf8");
}

function paddedBody(size: number): Uint8Array {
  return Buffer.from(`{}${" ".repeat(size - 2)}`, "utf8");
}

function prefixOf(length: number): Uint8Array {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, length, false);
  return prefix;
}

function property(
  name: string,
  body: (tc: Parameters<ConstructorParameters<typeof Hegel>[0]>[0]) => void,
) {
  new Hegel(body)
    .databaseKey(`session-communication/ts/bounds-${name}`)
    .settings(settings)
    .runSync();
}

describe("Hegel size-bound edges", () => {
  test("authored content accepted iff <= 24576 bytes", () => {
    property("authored", (tc) => {
      const offset = tc.draw(edge, "offset");
      assertFrameEdge(sendFrame(AUTHORED_MAX + offset), "local-client", offset <= 0);
    });
  });

  test("descriptor accepted iff <= 512 JSON bytes", () => {
    property("descriptor", (tc) => {
      const offset = tc.draw(edge, "offset");
      assertFrameEdge(
        upsertWithDescriptorBytes(DESCRIPTOR_MAX + offset),
        "gateway-forward",
        offset <= 0,
      );
    });
  });

  test("array length accepted iff <= 64", () => {
    property("array", (tc) => {
      const offset = tc.draw(edge, "offset");
      assert.equal(
        accepts(() => decodeJson(arrayObject(ARRAY_MAX + offset))),
        offset <= 0,
      );
    });
  });

  test("nesting depth accepted iff <= 16 containers", () => {
    property("depth", (tc) => {
      const offset = tc.draw(edge, "offset");
      assert.equal(
        accepts(() => decodeJson(nestedObject(DEPTH_MAX + offset))),
        offset <= 0,
      );
    });
  });

  test("body bytes accepted iff 1..32764 (prefix and decodeJson)", () => {
    property("body", (tc) => {
      const offset = tc.draw(edge, "offset");
      assert.equal(
        accepts(() => decodeJson(paddedBody(BODY_MAX + offset))),
        offset <= 0,
      );
      assert.equal(
        accepts(() => frameBodyLength(prefixOf(BODY_MAX + offset))),
        offset <= 0,
      );
      const low = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }), "low");
      assert.equal(
        accepts(() => frameBodyLength(prefixOf(low))),
        low >= 1,
      );
    });
  });
});
