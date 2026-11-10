import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { decodeJson, ProtocolError } from "../protocol/json.js";
import type { BoundaryRole } from "../protocol/wire.js";
import { decodeFrame, encodeFrame } from "../protocol/wire.js";

const settings = propertySettings(200);
const roles: readonly BoundaryRole[] = [
  "local-client",
  "gateway-forward",
  "adapter-delivery",
  "remote-link",
];
const nonce = "a".repeat(32);
const rid = "1".repeat(32);
const peer = { machineId: "beta", sessionId: "s", runtimeNonce: nonce };
const validFrames: readonly { role: BoundaryRole; frame: unknown }[] = [
  {
    role: "local-client",
    frame: {
      v: 1,
      op: "send",
      rid,
      to: peer,
      scopeId: "team",
      message: { id: "2".repeat(32), kind: "request", format: "text", content: "hi \u{1F600}" },
    },
  },
  {
    role: "local-client",
    frame: { v: 1, rid, op: "discover", scopeIds: ["a", "b"], watch: false },
  },
  {
    role: "local-client",
    frame: {
      v: 1,
      rid,
      op: "register",
      sessionId: "s",
      runtimeNonce: nonce,
      scopeIds: ["t"],
      label: "l",
    },
  },
  { role: "remote-link", frame: { v: 1, rid, op: "ping" } },
  {
    role: "local-client",
    frame: { v: 1, rid, op: "roster.event", event: { tag: "remove", peer } },
  },
];

function withPrefix(body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length, false);
  bytes.set(body, 4);
  return bytes;
}

/** Totality oracle: decode returns a frame or throws ProtocolError; a frame must survive re-encode. */
function assertTotal(bytes: Uint8Array, role: BoundaryRole): void {
  let frame: unknown;
  try {
    frame = decodeFrame(bytes, role);
  } catch (error) {
    assert.ok(error instanceof ProtocolError, `non-ProtocolError thrown: ${String(error)}`);
    return;
  }
  assert.deepStrictEqual(decodeFrame(encodeFrame(frame, role), role), frame);
}

function assertJsonTotal(bytes: Uint8Array): void {
  let value: unknown;
  try {
    value = decodeJson(bytes);
  } catch (error) {
    assert.ok(error instanceof ProtocolError, `non-ProtocolError thrown: ${String(error)}`);
    return;
  }
  assert.deepStrictEqual(decodeJson(Buffer.from(JSON.stringify(value), "utf8")), value);
}

function arbitraryBytes(raw: Uint8Array, fixPrefix: boolean): Uint8Array {
  return fixPrefix ? withPrefix(raw) : raw;
}

function mutated(
  index: number,
  edits: readonly (readonly [number, number])[],
  fixPrefix: boolean,
): { bytes: Uint8Array; role: BoundaryRole } {
  const entry = validFrames[index];
  assert.ok(entry !== undefined);
  const { role, frame } = entry;
  const bytes = Uint8Array.from(encodeFrame(frame, role));
  for (const [position, value] of edits) {
    bytes[position % bytes.length] = value;
  }
  return { bytes: fixPrefix ? withPrefix(bytes.subarray(4)) : bytes, role };
}

const utf8Pieces: readonly Uint8Array[] = [
  [0xc0, 0x80],
  [0xc1, 0xbf],
  [0xe0, 0x80, 0x80],
  [0xe0, 0x9f, 0xbf],
  [0xed, 0xa0, 0x80],
  [0xed, 0xbf, 0xbf],
  [0xf4, 0x90, 0x80, 0x80],
  [0xf5, 0x80, 0x80, 0x80],
  [0xf0, 0x80, 0x80, 0x80],
  [0xc3],
  [0xe2, 0x82],
  [0xf0, 0x9f, 0x98],
  [0x80],
  [0xbf],
  [0xff],
  [0xc3, 0xa9],
  [0xe2, 0x82, 0xac],
  [0xf0, 0x9f, 0x98, 0x80],
  [0xf4, 0x8f, 0xbf, 0xbf],
  [0xef, 0xbb, 0xbf],
  [0x61],
  [0x7a, 0x20],
].map((piece) => Uint8Array.from(piece));

/** Oracle: a JSON string body decodes iff the WHATWG fatal UTF-8 decoder accepts the bytes. */
function assertUtf8Agreement(pieces: readonly Uint8Array[]): void {
  const body = Buffer.concat([Buffer.from('{"a":"'), ...pieces, Buffer.from('"}')]);
  let valid = true;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    valid = false;
  }
  let accepted = true;
  try {
    decodeJson(body);
  } catch (error) {
    assert.ok(error instanceof ProtocolError, `non-ProtocolError thrown: ${String(error)}`);
    accepted = false;
  }
  assert.equal(accepted, valid);
}

const jsonish = gs.oneOf(
  gs.text({ maxSize: 60 }),
  gs.text({ maxSize: 60, alphabet: '{}[]":,0123456789truefalsn\\u-.eE \n' }),
);

describe("Hegel decoder totality", () => {
  test("decodeFrame on arbitrary bytes returns a frame or throws ProtocolError", () => {
    new Hegel((tc) => {
      const raw = tc.draw(gs.binary({ maxSize: 200 }), "bytes");
      const fix = tc.draw(gs.booleans(), "fix-prefix");
      const role = tc.draw(gs.sampledFrom(roles), "role");
      assertTotal(arbitraryBytes(raw, fix), role);
    })
      .settings(settings)
      .runSync();
  });

  test("decodeFrame on mutated valid frames is total and re-encodes stably", () => {
    new Hegel((tc) => {
      const index = tc.draw(
        gs.integers({ minValue: 0, maxValue: validFrames.length - 1 }),
        "frame",
      );
      const edits = tc.draw(
        gs.arrays(
          gs.tuples(
            gs.integers({ minValue: 0, maxValue: 400 }),
            gs.integers({ minValue: 0, maxValue: 255 }),
          ),
          { minSize: 1, maxSize: 3 },
        ),
        "edits",
      );
      const fix = tc.draw(gs.booleans(), "fix-prefix");
      const role = tc.draw(gs.sampledFrom(roles), "role");
      const sample = mutated(index, edits, fix);
      assertTotal(sample.bytes, role);
      assertTotal(sample.bytes, sample.role);
    })
      .settings(settings)
      .runSync();
  });

  test("decodeJson on arbitrary strings and bytes is total", () => {
    new Hegel((tc) => {
      const text = tc.draw(jsonish, "text");
      const raw = tc.draw(gs.binary({ maxSize: 100 }), "bytes");
      assertJsonTotal(Buffer.from(text, "utf8"));
      assertJsonTotal(raw);
    })
      .settings(settings)
      .runSync();
  });

  test("decodeJson accepts string bodies iff fatal UTF-8 decoding does", () => {
    new Hegel((tc) => {
      const pieces = tc.draw(
        gs.arrays(gs.sampledFrom(utf8Pieces), { minSize: 1, maxSize: 6 }),
        "pieces",
      );
      assertUtf8Agreement(pieces);
    })
      .settings(settings)
      .runSync();
  });
});
