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
  const peerRows = rows.filter((row) => row.includes("peer-msg-") && !PROBE.test(row));

  return {
    status,
    nonce,
    taken: Number(probe?.taken ?? 0),
    duplicate: probe?.dup ?? "none",
    final: probe?.final === "yes",
    tokens: peerRows.flatMap((row) => row.match(TOKEN) ?? []),
    unescaped: peerRows.filter(
      (row) => !row.includes(String.raw`\u001b[31m`) || !row.includes(String.raw`\u202e`),
    ).length,
  };
});

const exitStatus = extract((state: State) => state.exitStatus);

const connectedShown = (): boolean =>
  view.current?.status?.includes("enabled · connected") === true;

export const peerKeys = weighted([
  [10, actions(() => [{ TypeText: { Regexp: String.raw`\x15/peers (status|reconnect)` } }])],
  [10, typeFromSet(CharSet.fromLiterals("\r"))],
  [2, typeFromSet(CharSet.fromLiterals("\u001B"))],
  [1, actions(() => [{ Resize: { columns: [80, 140], rows: [24, 50] } }])],
]);

export const piKeepsRunning: Formula = always(() => exitStatus.current === null);

export const statusConnected: Formula = always(
  () => (view.current?.status ?? null) === null || connectedShown(),
);

export const nonceStable: Formula = always(() => {
  const first = view.current?.nonce ?? null;

  return first === null ? true : always(() => [null, first].includes(view.current?.nonce ?? null));
});

export const peerMessageShown: Formula = eventually(
  () => (view.current?.tokens.length ?? 0) > 0,
).within(90, "seconds");

export const noDuplicateMessage: Formula = always(() => view.current?.duplicate === "none");

export const peerContentEscaped: Formula = always(() => (view.current?.unescaped ?? 0) === 0);

export const peerLeaveSurvived: Formula = eventually(
  () => (view.current?.final ?? false) && connectedShown(),
).within(100, "seconds");
