import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import {
  decodeJson,
  MAX_ARRAY_ITEMS,
  MAX_BODY_BYTES,
  MAX_NESTING_DEPTH,
  ProtocolError,
} from "../protocol/json.js";
import { MAX_AUTHORED_BYTES } from "../protocol/schema.js";
import type { BoundaryRole } from "../protocol/wire.js";
import {
  decodeFrame,
  encodeFrame,
  frameBodyLength,
  MAX_DESCRIPTOR_BYTES,
  validateFrame,
} from "../protocol/wire.js";

const settings = propertySettings(200);
const rid = "1".repeat(32);
const nonce = "a".repeat(32);

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

function filled(bytes: number, wide: boolean): string {
  return wide ? `${"€".repeat(Math.floor(bytes / 3))}${"x".repeat(bytes % 3)}` : "x".repeat(bytes);
}

function publicationFrame(sizes: {
  title: number;
  summary: number;
  content: number;
  label: number;
  locator: number;
  wide: boolean;
}): unknown {
  const peer = { machineId: "alpha", sessionId: "s", runtimeNonce: nonce };
  return {
    v: 1,
    op: "result",
    rid,
    forOp: "state.get",
    outcome: {
      tag: "ok",
      value: {
        publisher: peer,
        scopeId: "team",
        publication: {
          key: "report",
          revision: 1,
          category: "context",
          title: filled(sizes.title, sizes.wide),
          summary: filled(sizes.summary, sizes.wide),
          content: filled(sizes.content, sizes.wide),
          format: "text",
          preparation: "authored",
          refs: [
            {
              kind: "resource",
              machineId: "alpha",
              locator: filled(sizes.locator, sizes.wide),
              label: filled(sizes.label, sizes.wide),
            },
          ],
        },
      },
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

function oncePerKey(): (key: string, check: () => void) => void {
  const seen = new Set<string>();
  return (key, check) => {
    if (!seen.has(key)) {
      seen.add(key);
      check();
    }
  };
}

function property(
  name: string,
  body: (tc: Parameters<ConstructorParameters<typeof Hegel>[0]>[0]) => void,
) {
  new Hegel(body).settings(settings).runSync();
}

describe("Hegel size-bound edges", () => {
  test("authored content accepted iff <= MAX_AUTHORED_BYTES", () => {
    const once = oncePerKey();
    property("authored", (tc) => {
      const offset = tc.draw(edge, "offset");
      once(`${offset}`, () => {
        assertFrameEdge(sendFrame(MAX_AUTHORED_BYTES + offset), "local-client", offset <= 0);
      });
    });
  });

  test("the sum of title, summary, content, label and locator bytes is accepted iff <= MAX_AUTHORED_BYTES", () => {
    property("aggregate", (tc) => {
      const offset = tc.draw(edge, "offset");
      const title = tc.draw(gs.integers({ minValue: 4, maxValue: 128 }), "title bytes");
      const summary = tc.draw(gs.integers({ minValue: 4, maxValue: 1024 }), "summary bytes");
      const label = tc.draw(gs.integers({ minValue: 4, maxValue: 128 }), "label bytes");
      const locator = tc.draw(gs.integers({ minValue: 4, maxValue: 1024 }), "locator bytes");
      const wide = tc.draw(gs.booleans(), "multi-byte text");
      const content = MAX_AUTHORED_BYTES + offset - title - summary - label - locator;
      assertFrameEdge(
        publicationFrame({ title, summary, content, label, locator, wide }),
        "local-client",
        offset <= 0,
      );
    });
  });

  test("descriptor accepted iff <= MAX_DESCRIPTOR_BYTES JSON bytes", () => {
    const once = oncePerKey();
    property("descriptor", (tc) => {
      const offset = tc.draw(edge, "offset");
      once(`${offset}`, () => {
        assertFrameEdge(
          upsertWithDescriptorBytes(MAX_DESCRIPTOR_BYTES + offset),
          "gateway-forward",
          offset <= 0,
        );
      });
    });
  });

  test("array length accepted iff <= 64", () => {
    property("array", (tc) => {
      const offset = tc.draw(edge, "offset");
      assert.equal(
        accepts(() => decodeJson(arrayObject(MAX_ARRAY_ITEMS + offset))),
        offset <= 0,
      );
    });
  });

  test("nesting depth accepted iff <= 16 containers", () => {
    property("depth", (tc) => {
      const offset = tc.draw(edge, "offset");
      assert.equal(
        accepts(() => decodeJson(nestedObject(MAX_NESTING_DEPTH + offset))),
        offset <= 0,
      );
    });
  });

  test("body bytes accepted iff 1..32764 (prefix and decodeJson)", () => {
    const once = oncePerKey();
    property("body", (tc) => {
      const offset = tc.draw(edge, "offset");
      const low = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }), "low");
      once(`${offset}/${low}`, () => {
        assert.equal(
          accepts(() => decodeJson(paddedBody(MAX_BODY_BYTES + offset))),
          offset <= 0,
        );
        assert.equal(
          accepts(() => frameBodyLength(prefixOf(MAX_BODY_BYTES + offset))),
          offset <= 0,
        );
        assert.equal(
          accepts(() => frameBodyLength(prefixOf(low))),
          low >= 1,
        );
      });
    });
  });
});
