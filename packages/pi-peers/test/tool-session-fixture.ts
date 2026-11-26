import { MessageAliases } from "../adapter/aliases.js";
import type { Configuration } from "../adapter/config.js";
import { Handles, TakenIndex } from "../adapter/handles.js";
import { UnsureSends } from "../adapter/retries.js";
import type { ToolSession } from "../adapter/tools.js";
import type { Reply } from "../adapter/transport.js";
import type { PeerRef } from "../protocol/schema.js";

export const self: PeerRef = { machineId: "alpha", sessionId: "me", runtimeNonce: "a".repeat(32) };

export const beta: PeerRef = { machineId: "beta", sessionId: "them", runtimeNonce: "b".repeat(32) };

const config: Configuration = {
  machineId: "alpha",
  socketPath: "/tmp/pi-peers-test.sock",
  label: "Pi",
  scopeIds: ["team"],
  policies: [{ machineId: "beta", scopeId: "team", permissions: ["discover", "push"] }],
};

export type Listed = { readonly peer: PeerRef; readonly label: string };

export function discoverReply(peers: ReadonlyArray<Listed>): Reply {
  return {
    v: 2,
    op: "result",
    rid: "0".repeat(32),
    forOp: "discover",
    outcome: {
      tag: "ok",
      value: {
        peers: peers.map(({ peer, label }) => ({ peer, label, scopeIds: ["team"] })),
        watching: false,
      },
    },
  };
}

export function toolSession(client: Partial<ToolSession["client"]> = {}): ToolSession {
  return {
    peer: self,
    config,
    handles: new Handles(),
    taken: new TakenIndex(),
    unsure: new UnsureSends(),
    aliases: new MessageAliases(),
    waitForMessage: async () => "timed_out",
    take: () => ({ messages: [] }),
    send: async (_to, _scopeId, message) => ({
      tag: "admitted",
      messageId: message.id,
      correlation: "none",
      durable: false,
    }),
    client: {
      isClosed: () => false,
      recoverForTool: async () => undefined,
      effectiveScopes: () => new Set(["team"]),
      linkDown: () => false,
      discover: async () => discoverReply([]),
      ...client,
    },
  };
}
