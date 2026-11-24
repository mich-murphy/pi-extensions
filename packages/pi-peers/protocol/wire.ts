import { Schema } from "effect";
import { decodeJson, MAX_BODY_BYTES, ProtocolError } from "./json.js";
import type { ObjectBytesVisitor } from "./json.js";
import { Frame, MAX_AUTHORED_BYTES, retiredOps } from "./schema.js";

export const MAX_DESCRIPTOR_BYTES = 512;

export type BoundaryRole = "local-client" | "gateway-forward" | "adapter-delivery" | "remote-link";
const routed = new Set(["send", ...retiredOps]);
const decode = Schema.decodeUnknownSync(Frame, { onExcessProperty: "error" });

export function frameBodyLength(prefix: Uint8Array): number {
  if (prefix.length !== 4) {
    throw new ProtocolError();
  }
  const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, false);
  if (length < 1 || length > MAX_BODY_BYTES) {
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
  "adapter-delivery": new Set(["deliver", ...retiredOps]),
  "remote-link": new Set(["ping", "discover", "unwatch", ...routed]),
};

function checkRole(frame: Frame, role: BoundaryRole): void {
  if (frame.op === "link.state" && role !== "adapter-delivery") {
    throw new ProtocolError();
  }
  if (
    frame.op === "result" &&
    "code" in frame.outcome &&
    (frame.outcome.code === "config_mismatch" || frame.outcome.code === "link_down") &&
    role !== "local-client" &&
    role !== "adapter-delivery"
  ) {
    throw new ProtocolError();
  }
  if (frame.op === "result" && frame.forOp === "gateway.restart" && role !== "local-client") {
    throw new ProtocolError();
  }
  if (frame.op === "result" || frame.op === "roster.event" || frame.op === "link.state") {
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

const authoredFields = new Set(["content", "label", "locator"]);
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
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_DESCRIPTOR_BYTES) {
    throw new ProtocolError();
  }
}

export function validateFrame(value: unknown, role: BoundaryRole): Frame {
  try {
    const frame = decode(value);
    decodeJson(Buffer.from(JSON.stringify(frame), "utf8"));
    checkRole(frame, role);
    checkDescriptorBounds(frame);
    if (authoredBytes(frame) > MAX_AUTHORED_BYTES) {
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
      byteLength > MAX_DESCRIPTOR_BYTES
    ) {
      snapshotOverflow = true;
    }
  };
  const frame = validateFrame(decodeJson(bytes, inspect), role);
  if (
    snapshotOverflow ||
    (frame.op === "roster.event" &&
      frame.event.tag === "upsert" &&
      eventBytes > MAX_DESCRIPTOR_BYTES)
  ) {
    throw new ProtocolError();
  }
  return frame;
}

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
  decodeJson(body);
  const bytes = new Uint8Array(body.length + 4);
  new DataView(bytes.buffer).setUint32(0, body.length, false);
  bytes.set(body, 4);
  return bytes;
}
