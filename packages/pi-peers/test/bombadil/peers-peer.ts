import { readFileSync } from "node:fs";
import { decodeConfiguration } from "../../adapter/config.js";
import { createAdapterRuntime } from "../../adapter/runtime.js";
import { freshId } from "../../adapter/transport.js";
import { parseJson } from "../../onboarding/schema.js";

const PERIOD_MS = 4000;
const LIMIT = 8;
const config = decodeConfiguration(parseJson(readFileSync(process.argv[2] ?? "")));
const self = { machineId: config.machineId, sessionId: "scripted-peer", runtimeNonce: freshId() };

const runtime = await createAdapterRuntime(config, self, { sendMessage: () => undefined }, () => ({
  isIdle: () => true,
  ui: { setStatus: () => undefined },
}));

let sent = 0;

function leave(): void {
  clearInterval(timer);
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
