import { Schema } from "effect";
import { decodeJson, ProtocolError } from "./json.js";
import type { ObjectBytesVisitor } from "./json.js";
import { Frame } from "./schema.js";

export type BoundaryRole = "local-client" | "gateway-forward" | "adapter-delivery" | "remote-link";
const routed = new Set(["send", "state.get", "state.list", "interest.add", "interest.remove"]);
const decode = Schema.decodeUnknownSync(Frame, { onExcessProperty: "error" });

/** Inspect this before allocating a declared body. */
export function frameBodyLength(prefix: Uint8Array): number {
  if (prefix.length !== 4) {
    throw new ProtocolError();
  }
  const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, false);
  if (length < 1 || length > 32_764) {
    throw new ProtocolError();
  }
  return length;
}

const roleOperations: Record<BoundaryRole, ReadonlySet<string>> = {
  "local-client": new Set([
    "register",
    "close",
    "gateway.restart",
    "discover",
    "unwatch",
    ...routed,
  ]),
  "gateway-forward": routed,
  "adapter-delivery": new Set([
    "deliver",
    "state.get",
    "state.list",
    "interest.add",
    "interest.remove",
  ]),
  "remote-link": new Set(["ping", "discover", "unwatch", ...routed]),
};

function checkRole(frame: Frame, role: BoundaryRole): void {
  if (
    frame.op === "result" &&
    frame.outcome.tag === "error" &&
    frame.outcome.code === "config_mismatch" &&
    role !== "local-client" &&
    role !== "adapter-delivery"
  ) {
    throw new ProtocolError();
  }
  if (frame.op === "result" && frame.forOp === "gateway.restart" && role !== "local-client") {
    throw new ProtocolError();
  }
  if (frame.op === "result" || frame.op === "roster.event") {
    return;
  }
  if (!roleOperations[role].has(frame.op)) {
    throw new ProtocolError();
  }
  if (routed.has(frame.op)) {
    const from = "from" in frame ? frame.from : undefined;
    if ((role === "local-client") !== (from === undefined)) {
      throw new ProtocolError();
    }
  }
}

const authoredFields = new Set(["content", "title", "summary", "label", "locator"]);
function authoredBytes(value: unknown): number {
  if (typeof value !== "object" || value === null) {
    return 0;
  }
  let total = 0;
  for (const [name, child] of Object.entries(value)) {
    total +=
      authoredFields.has(name) && typeof child === "string"
        ? Buffer.byteLength(child, "utf8")
        : authoredBytes(child);
  }
  return total;
}

function checkDescriptorBounds(frame: Frame): void {
  if (frame.op === "roster.event" && frame.event.tag === "upsert") {
    checkDescriptor(frame.event.peer);
  }
  if (frame.op === "result" && frame.forOp === "discover" && frame.outcome.tag === "ok") {
    for (const descriptor of frame.outcome.value.peers) {
      checkDescriptor(descriptor);
    }
  }
}
function checkDescriptor(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 512) {
    throw new ProtocolError();
  }
}

/** Structural validation only; authorization, live correlations and runtime fencing belong to callers. */
export function validateFrame(value: unknown, role: BoundaryRole): Frame {
  try {
    const frame = decode(value);
    // Direct callers receive the same byte/depth/Unicode bounds as raw-wire callers.
    decodeJson(Buffer.from(JSON.stringify(frame), "utf8"));
    checkRole(frame, role);
    checkDescriptorBounds(frame);
    if (authoredBytes(frame) > 24_576) {
      throw new ProtocolError();
    }
    return frame;
  } catch {
    throw new ProtocolError();
  }
}

function decodeBody(bytes: Uint8Array, role: BoundaryRole): Frame {
  let eventBytes = 0;
  let snapshotOverflow = false;
  const inspect: ObjectBytesVisitor = (path, byteLength) => {
    if (path.length === 2 && path[0] === "event" && path[1] === "peer") {
      eventBytes = byteLength;
    }
    if (
      path.length === 4 &&
      path[0] === "outcome" &&
      path[1] === "value" &&
      path[2] === "peers" &&
      typeof path[3] === "number" &&
      byteLength > 512
    ) {
      snapshotOverflow = true;
    }
  };
  const frame = validateFrame(decodeJson(bytes, inspect), role);
  if (
    snapshotOverflow ||
    (frame.op === "roster.event" && frame.event.tag === "upsert" && eventBytes > 512)
  ) {
    throw new ProtocolError();
  }
  return frame;
}

/** Exactly one complete frame; stream assemblers retain partial bytes outside this pure helper. */
export function decodeFrame(bytes: Uint8Array, role: BoundaryRole): Frame {
  const length = frameBodyLength(bytes.subarray(0, 4));
  if (bytes.length !== length + 4) {
    throw new ProtocolError();
  }
  return decodeBody(bytes.subarray(4), role);
}

export function encodeFrame(value: unknown, role: BoundaryRole): Uint8Array {
  const frame = validateFrame(value, role);
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  // Run the same bounded interpretation pass on local values, including surrogate validation.
  decodeJson(body);
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length, false);
  bytes.set(body, 4);
  return bytes;
}
