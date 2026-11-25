import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { decodeConfiguration, plainText } from "../adapter/config.js";
import { Handles } from "../adapter/handles.js";
import { composeLabel } from "../adapter/label.js";
import type { PeerRef } from "../protocol/schema.js";

const settings = propertySettings(200);

const runtimes: PeerRef[] = ["x", "y"].flatMap((sessionId) =>
  ["1", "2", "3", "4"].map((nonce) => ({
    machineId: "beta",
    sessionId,
    runtimeNonce: nonce.repeat(32),
  })),
);

const same = (left: PeerRef, right: PeerRef) =>
  left.sessionId === right.sessionId && left.runtimeNonce === right.runtimeNonce;

type Model = { bound: Map<string, PeerRef>; owner: Map<string, string> };

function handleOf(bound: ReadonlyMap<string, PeerRef>, peer: PeerRef): string | undefined {
  return [...bound].find(([, runtime]) => same(runtime, peer))?.[0];
}

function bind(model: Model, handle: string, peer: PeerRef): void {
  const owner = model.owner.get(handle);
  assert(
    owner === undefined || owner === peer.sessionId,
    `${handle} was reused for another session`,
  );
  model.owner.set(handle, peer.sessionId);
  model.bound.set(handle, peer);
}

function listStep(handles: Handles, model: Model, indices: readonly number[]): void {
  const listed = indices.flatMap((index) => {
    const peer = runtimes[index];

    return peer === undefined ? [] : [peer];
  });

  const before = new Map(model.bound);
  const result = handles.list(listed.map((peer) => ({ peer, scopeId: "team" })));
  const shown = result.map((entry) => entry.handle);
  assert.equal(new Set(shown).size, shown.length, "one listing showed a handle twice");

  for (const entry of result) {
    const kept = handleOf(before, entry.peer);
    assert(kept === undefined || kept === entry.handle, "a listed runtime lost its handle");
    const previous = before.get(entry.handle);
    const replaced = previous !== undefined && !same(previous, entry.peer);
    assert.equal(entry.restarted, replaced, "restarted does not match a replaced runtime");
    assert(
      !replaced || !listed.some((peer) => same(peer, previous)),
      "a handle was taken from a runtime that is still listed",
    );
    bind(model, entry.handle, entry.peer);
  }
}

function senderStep(handles: Handles, model: Model, index: number): void {
  const peer = runtimes[index];
  assert(peer);
  const before = new Map(model.bound);
  const handle = handles.sender(peer, "team");
  const kept = handleOf(before, peer);
  assert(kept === undefined || kept === handle, "a known sender got a different handle");
  assert(kept !== undefined || !before.has(handle), "a new sender took a bound handle");
  bind(model, handle, peer);
}

function assertHandleTrace(tc: TestCase): void {
  const handles = new Handles();
  const model: Model = { bound: new Map(), owner: new Map() };
  const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }), "steps");

  for (let step = 0; step < steps; step += 1) {
    if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 }), `kind${step}`) === 3) {
      const index = tc.draw(
        gs.integers({ minValue: 0, maxValue: runtimes.length - 1 }),
        `from${step}`,
      );

      senderStep(handles, model, index);
    } else {
      const indices = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: runtimes.length - 1 }), {
          unique: true,
          maxSize: 5,
        }),
        `listed${step}`,
      );

      listStep(handles, model, indices);
    }

    for (const [handle, peer] of model.bound) {
      assert.deepEqual(handles.resolve(handle)?.peer, peer, `${handle} resolves elsewhere`);
    }
  }
}

const hostile = ["‮", "⁦⁩", " ", "\u001b[31m", "a\nb", "界😀é", "a/b", "n".repeat(130)];
const piece = gs.oneOf(gs.text({ maxSize: 40 }), gs.sampledFrom(hostile));

function acceptsLabel(label: string): boolean {
  try {
    decodeConfiguration({
      machineId: "alpha",
      socketPath: "/tmp/pi.sock",
      scopeIds: ["team"],
      label,
      policies: [],
    });

    return true;
  } catch {
    return false;
  }
}

function assertConfiguredFirst(label: string, configured: string, sessionName: string): void {
  const visible = plainText(configured);
  assert(visible.length > 0, "the config accepted a label with no visible text");
  assert(label.startsWith(visible), "the configured label was cut or replaced");
  const name = plainText(sessionName);
  const pair = `${visible} · ${name}`;
  assert(
    name.length === 0 || Buffer.byteLength(pair) > 128 || label.startsWith(pair),
    "the session name was dropped though it fits",
  );
}

function assertLabel(tc: TestCase): void {
  const configured = tc.draw(piece, "configured");
  const sessionName = tc.draw(gs.optional(piece), "sessionName");
  const repo = tc.draw(piece, "repo");
  const parent = tc.draw(gs.optional(piece), "parent");
  const branch = tc.draw(gs.optional(piece), "branch");

  const label = composeLabel({
    configured,
    machineId: "alpha",
    cwd: `/work/${repo}`,
    sessionName: sessionName ?? undefined,
    parentSession: parent === null ? undefined : `/sessions/2026_${parent}.jsonl`,
    branch: branch ?? undefined,
  });

  assert(Buffer.byteLength(label) <= 128, "the label is over 128 bytes");
  assert(label.length > 0, "the label is empty");
  assert.equal(plainText(label), label, "the label has control, bidi or repeated whitespace");

  if (acceptsLabel(configured)) {
    assertConfiguredFirst(label, configured, sessionName ?? "");
  }
}

describe("Hegel session identity properties", () => {
  test(
    "handles stay with listed runtimes, are never reused across sessions, and restarted means replaced",
    { timeout: propertyTimeout(30_000) },
    () => {
      assertHegel(settings, (tc) => {
        assertHandleTrace(tc);
      });
    },
  );
  test(
    "a label fits 128 bytes on one plain line and keeps the configured label first",
    { timeout: propertyTimeout(30_000) },
    () => {
      assertHegel(settings, (tc) => {
        assertLabel(tc);
      });
    },
  );
});
