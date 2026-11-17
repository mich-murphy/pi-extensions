// Scripted second participant for peers.bombadil.ts: a real pi-comms adapter runtime in its own
// process, on the same gateway as the driven Pi. Every few seconds it discovers the other sessions
// in scope `team` and sends each one an `update` whose content carries a unique token
// (`peer-msg-<n>`) followed by an escape sequence and a bidi override, so the spec can check
// delivery and sanitization. The last message also says `final`; then the peer disconnects and
// exits, so the spec can check that the driven Pi survives a peer leaving.
//   node --import jiti/register peers-peer.ts <session-communication.json>
import { readFileSync } from "node:fs";
import { decodeConfiguration } from "../../adapter/config.js";
import { createAdapterRuntime } from "../../adapter/runtime.js";
import { freshId } from "../../adapter/transport.js";

const PERIOD_MS = 4000;
const LIMIT = 8;
const config = decodeConfiguration(JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")));
const self = { machineId: config.machineId, sessionId: "scripted-peer", runtimeNonce: freshId() };
const runtime = await createAdapterRuntime(config, self, { sendMessage: () => undefined }, () => ({
  isIdle: () => true,
  ui: { setStatus: () => undefined },
}));
let sent = 0;

function leave(): void {
  clearInterval(timer);
  // Nothing else holds the event loop once the runtime is disposed, so the process then ends.
  void runtime.dispose();
}

async function round(): Promise<void> {
  const reply = await runtime.session.client.discover(["team"], false);
  if (reply.forOp !== "discover" || reply.outcome.tag !== "ok") {
    return;
  }
  const others = reply.outcome.value.peers.filter(({ peer }) => peer.sessionId !== self.sessionId);
  for (const { peer } of others) {
    sent += 1;
    const content = `peer-msg-${sent}${sent === LIMIT ? " final" : ""} \u001B[31mred‮`;
    await runtime.session.send(peer, "team", {
      id: freshId(),
      kind: "update",
      content,
      format: "text",
    });
  }
  if (sent >= LIMIT) {
    leave();
  }
}

const timer = setInterval(() => {
  void round().catch(() => undefined);
}, PERIOD_MS);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, leave);
}
