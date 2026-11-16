// Bombadil terminal specification: one interactive Pi with pi-comms on a real local gateway, while
// a scripted peer (peers-peer.ts) sends it `update` messages carrying unique `peer-msg-<n>` tokens.
// peers-extension.ts gives the driven Pi an offline model that answers every wake with
// `session_take`, so delivered messages become visible tool results, and a footer probe counting
// taken tokens over the whole run. After eight messages the peer disconnects. Run with:
//   bombadil terminal test --specification packages/pi-comms/test/bombadil/peers.bombadil.ts -- \
//     node --experimental-strip-types scripts/bombadil-pi.ts \
//     --fixture packages/pi-comms/test/bombadil/peers.fixture.ts packages/pi-comms/index.ts \
//     packages/pi-comms/test/bombadil/peers-extension.ts
import { always, eventually } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { CharSet } from "@antithesishq/bombadil/actions";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { State } from "@antithesishq/bombadil/terminal";
import { typeFromSet } from "@antithesishq/bombadil/terminal/defaults/actions";
import { screenRows } from "../../../../test-support/bombadil-screen.ts";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";

const TOKEN = /peer-msg-\d+/gu;
const PROBE = /peers-probe taken=(?<taken>\d+) dup=(?<dup>\S+) final=(?<final>yes|no)/u;
const view = extract((state: State) => {
  const rows = screenRows(state);
  const status = rows.find((row) => row.includes("Session communication:")) ?? null;
  const nonce =
    rows.map((row) => /nonce=(?<nonce>[0-9a-f]{32})/u.exec(row)?.groups?.nonce).find(Boolean) ??
    null;
  const probe = rows.map((row) => PROBE.exec(row)?.groups).find(Boolean);
  // The probe row names a duplicate token; only rendered take results count as peer rows.
  const peerRows = rows.filter((row) => row.includes("peer-msg-") && !PROBE.test(row));
  return {
    status,
    nonce,
    taken: Number(probe?.taken ?? 0),
    duplicate: probe?.dup ?? "none",
    final: probe?.final === "yes",
    tokens: peerRows.flatMap((row) => row.match(TOKEN) ?? []),
    unescaped: peerRows.filter((row) => !row.includes(String.raw`\u001b[31m`)).length,
  };
});
const exitStatus = extract((state: State) => state.exitStatus);
const connectedShown = (): boolean =>
  view.current?.status?.includes("enabled · connected") === true;

// Clear the editor (Ctrl+U), type a /comms command, Enter; also Escape (abort a take) and resize.
export const peerKeys = weighted([
  [10, actions(() => [{ TypeText: { Regexp: String.raw`\x15/comms (status|reconnect)` } }])],
  [10, typeFromSet(CharSet.fromLiterals("\r"))],
  [2, typeFromSet(CharSet.fromLiterals("\u001B"))],
  [1, actions(() => [{ Resize: { columns: [80, 140], rows: [24, 50] } }])],
]);

/** Pi never exits: no generated key asks it to, and peer traffic must not crash it. */
export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

/** The gateway stays up for the whole run, so every /comms status shown says connected. */
export const statusConnected: Formula = always(
  () => (view.current?.status ?? null) === null || connectedShown(),
);

/** /comms reconnect while connected keeps the runtime: the shown nonce never changes. */
export const nonceStable: Formula = always(() => {
  const first = view.current?.nonce ?? null;
  return first === null ? true : always(() => [null, first].includes(view.current?.nonce ?? null));
});

/** The peer's messages reach the driven Pi: wake, scripted take, rendered result. */
export const peerMessageShown: Formula = eventually(
  () => (view.current?.tokens.length ?? 0) > 0,
).within(90, "seconds");

/** Each message is taken once over the whole run: the probe never records a repeated token. */
export const noDuplicateMessage: Formula = always(() => view.current?.duplicate === "none");

/** Peer content is inert: its escape sequence is shown as the text `\u001b[31m`, never interpreted. */
export const peerContentEscaped: Formula = always(() => (view.current?.unescaped ?? 0) === 0);

/** After the peer's last message and disconnect, /comms status still renders as connected. */
export const peerLeaveSurvived: Formula = eventually(
  () => (view.current?.final ?? false) && connectedShown(),
).within(100, "seconds");
