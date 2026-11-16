// Bombadil terminal specification for /comms onboarding with a real Apply, run against the real
// Pi CLI:
//   bombadil terminal test --specification packages/pi-comms/test/bombadil/setup-apply.bombadil.ts
//     -- node --experimental-strip-types scripts/bombadil-pi.ts
//        --fixture packages/pi-comms/test/bombadil/setup-apply.fixture.ts
//        packages/pi-comms/test/bombadil/setup-apply-extension.ts
// The extension installs the local debug gateway into the throwaway home and shows disk/runtime
// state in a `state:` footer line. Besides the setup.bombadil.ts keys, a "deeper" generator picks
// visible options by text and types well-formed answers (fixture paths, SHA256, IP:port).
import { always, eventually, now } from "@antithesishq/bombadil";
import type { Formula } from "@antithesishq/bombadil";
import { actions, extract, weighted } from "@antithesishq/bombadil/terminal";
import type { State } from "@antithesishq/bombadil/terminal";
import { screenRows } from "../../../../test-support/bombadil-screen.ts";
import { commands, dialogKeys, inDialog, resize } from "./setup-keys.ts";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";
export {
  dialogFits,
  dialogReached,
  escapeClosesDialog,
  noUnreviewedChange,
  noUnreviewedWrite,
  piKeepsRunning,
  probeShown,
  selectionVisible,
} from "./setup-keys.ts";

const HINT = /^(?:↑↓ navigate|enter submit) /u;
const OPTION = /^ (?:→ | {2})(?<text>\S.*)$/u;
const STATE =
  /state:cfg=(?<cfg>[yn]) sock=(?<sock>up|dn) claim=(?<claim>\w+) out=(?<out>\S+) step=(?<step>\d+)\.(?<command>\w+)\.(?<flags>[\w-]+)\.(?<outcome>\w+)/u;
// macOS shows the throwaway root under /private/tmp, Linux under /tmp.
const ROOT = /^(?<root>(?:\/private)?\/tmp\/pi-bombadil-[^/\s]+)\/cwd/u;

type Dialog = { input: boolean; title: string; options: string[]; cursor: number };

/** The open dialog: its title text, its options and the highlighted option's index. */
function dialogOf(rows: readonly string[]): Dialog | null {
  const hint = rows.findIndex((row) => HINT.test(row.trim()));
  if (hint < 0) {
    return null;
  }
  let start = hint;
  while (start > 0 && !(rows[start - 1] ?? "").startsWith("────")) {
    start--;
  }
  const body = rows.slice(start, hint).filter((row) => row.trim() !== "");
  const options = body.flatMap((row) => OPTION.exec(row)?.groups?.text ?? []);
  return {
    input: (rows[hint] ?? "").trim().startsWith("enter submit"),
    title: body
      .filter((row) => !OPTION.test(row))
      .map((row) => row.trim())
      .join(" "),
    options,
    cursor: body.filter((row) => OPTION.test(row)).findIndex((row) => row.startsWith(" → ")),
  };
}

type Status = {
  cfg: string;
  sock: string;
  claim: string;
  out: string;
  command: string;
  flags: string;
  outcome: string;
};
const NO_STATUS = { cfg: null, sock: null, claim: null, out: null, command: null, flags: null };

/** The fields of the first `state:` footer line, or null when none is shown. */
function statusOf(rows: readonly string[]): Status | null {
  for (const row of rows) {
    const groups = STATE.exec(row)?.groups;
    if (groups !== undefined) {
      const { cfg = "", sock = "", claim = "", out = "" } = groups;
      const { command = "", flags = "", outcome = "" } = groups;
      return { cfg, sock, claim, out, command, flags, outcome };
    }
  }
  return null;
}

/** The throwaway root, read from the cwd row of Pi's footer. */
function rootOf(rows: readonly string[]): string | null {
  for (const row of rows) {
    const root = ROOT.exec(row.trim())?.groups?.root;
    if (root !== undefined) {
      return root;
    }
  }
  return null;
}

const view = extract((state: State) => {
  const rows = screenRows(state);
  return {
    dialog: dialogOf(rows),
    root: rootOf(rows),
    outcome: null,
    ...NO_STATUS,
    ...statusOf(rows),
  };
});

// Options that lead further into onboarding than Enter on the first option does.
const DEEPER =
  /^(?:Configure one remote peer|Use existing trust material|Create a new trusted pair|Join a new trusted pair|Connect to peer|Listen for peer|Existing floor|Genuinely initial|Review details|Next details|Previous details|Edit choices|Permissions|Allow|Deny|Machine identity|Scope|Session label|Add one remote peer|Activate saved configuration|Keep and reconnect|View public exchange|Import public bundle|Issue peer CSR|Renew leaves|Revoke a leaf|Export latest|Apply)/u;
const FILES: readonly (readonly [RegExp, string])[] = [
  [/PUBLIC offer file/u, "offer.json"],
  [/root certificate DER/u, "root.der"],
  [/leaf certificate/u, "leaf.der"],
  [/PRIVATE key/u, "key.pem"],
  [/numbered CRL/u, "crl.der"],
  [/revocation-floor/u, "floor.json"],
  [/PUBLIC bundle/u, "bundle.json"],
  [/CSR\/request file/u, "request.json"],
];

/** A well-formed answer for an input dialog titled `title`, or null. */
function answerFor(title: string, root: string | null): string | null {
  if (title.includes("SHA256")) {
    return "ab".repeat(32);
  }
  if (title.includes("IP:port")) {
    return "127.0.0.1:7443";
  }
  if (title.startsWith("Peer's exact")) {
    return "peer-a";
  }
  const file = FILES.find(([pattern]) => pattern.test(title))?.[1];
  return file === undefined || root === null ? null : `${root}/fx/${file}`;
}

/** A regular expression that generates exactly `text`. */
function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** Arrow keys from option `from` to option `to`, then Enter. */
function moves(from: number, to: number): string {
  const key = to > from ? String.raw`\x1B\[B` : String.raw`\x1B\[A`;
  return `(${key}){${Math.abs(to - from)}}\r`;
}

// Go deeper: pick a visible option by its text, or type the answer an input dialog asks for.
const deeper = actions(() => {
  const dialog = view.current?.dialog ?? null;
  if (dialog === null) {
    return [];
  }
  if (dialog.input) {
    const answer = answerFor(dialog.title, view.current?.root ?? null);
    return answer === null ? [] : [{ TypeText: { Regexp: String.raw`\x15${literal(answer)}\r` } }];
  }
  return dialog.options.flatMap((option, index) =>
    DEEPER.test(option) ? [{ TypeText: { Regexp: moves(dialog.cursor, index) } }] : [],
  );
});

const KEEP = "Keep and reconnect";
const keepShown = (): boolean => (view.current?.dialog?.options ?? []).includes(KEEP);

// In the existing-setup dialog, often pick Keep and reconnect, so keepReconnects is exercised.
const keep = actions(() => {
  const dialog = view.current?.dialog ?? null;
  const index = dialog?.options.indexOf(KEEP) ?? -1;
  return dialog === null || index < 0
    ? []
    : [{ TypeText: { Regexp: moves(dialog.cursor, index) } }];
});

// With configuration saved and no dialog open, often type /comms setup again (the commands
// generator supplies Enter), so the existing-setup dialogs and Keep and reconnect are reached.
const configured = (): boolean => !inDialog() && view.current?.cfg === "y";
const setupAgain = actions(() => [{ TypeText: { Regexp: String.raw`\x15/comms setup` } }]);

// About 30% of actions go deeper; Keep and reconnect is offered with extra weight when shown.
export const applyKeys = weighted([
  [10, commands],
  [20, dialogKeys],
  [13, deeper.when(inDialog)],
  [15, keep.when(keepShown)],
  [5, setupAgain.when(configured)],
  [1, resize],
]);

/**
 * The state line is shown; without it the properties below would pass vacuously. It is a footer
 * row, so a dialog too tall for the terminal also pushes it off screen.
 */
export const stateShown: Formula = always(() => (view.current?.cfg ?? null) !== null);

/** Nothing is written to the real user's ~/.pi comms locations, only inside the throwaway root. */
export const nothingOutsideRoot: Formula = always(() => (view.current?.out ?? "ok") === "ok");

const SECONDS = 10;
const current = () => view.current;
const isSetup = (): boolean => current()?.command === "setup";
/** The first /comms setup after a reset reported participation disabled. */
const setupAfterReset = (): boolean => isSetup() && (current()?.flags ?? "").includes("r");
/** A /comms setup that started over existing configuration (and not right after a reset). */
const setupOverExisting = (): boolean =>
  isSetup() && /^c$/u.test(current()?.flags ?? "") && current()?.outcome !== "running";
// The documented first dialogs over an existing setup-owned configuration: repair the
// installation, continue a pairing, or the local-participation choices (keep, activate, add peer).
const EXISTING = new Set(["existing", "pair", "repair"]);

/** After a /comms command reports "connected", the configuration exists and its socket is up. */
export const connectedClaimHolds: Formula = always(
  now(() => current()?.claim === "conn").implies(
    eventually(() => current()?.cfg === "y" && current()?.sock === "up").within(SECONDS, "seconds"),
  ),
);

/** After /comms reset reports participation disabled, the configuration file is gone. */
export const resetDisables: Formula = always(
  now(() => current()?.claim === "off").implies(
    eventually(() => current()?.cfg === "n").within(5, "seconds"),
  ),
);

/** Never stuck: the first /comms setup after a reset opens the fresh intent dialog, no warning. */
export const setupAfterResetWorks: Formula = always(
  now(() => !setupAfterReset() || ["running", "intent"].includes(current()?.outcome ?? "")).and(
    now(setupAfterReset).implies(
      eventually(() => !setupAfterReset() || current()?.outcome === "intent").within(
        SECONDS,
        "seconds",
      ),
    ),
  ),
);

/** /comms setup over existing configuration opens a documented existing-setup dialog first. */
export const existingSetupOffered: Formula = always(
  () => !setupOverExisting() || EXISTING.has(current()?.outcome ?? ""),
);

/** Once a command that chose "Keep and reconnect" finishes, the gateway socket is up soon. */
export const keepReconnects: Formula = always(
  now(() => current()?.claim === "kept").implies(
    eventually(() => current()?.sock === "up").within(SECONDS, "seconds"),
  ),
);
