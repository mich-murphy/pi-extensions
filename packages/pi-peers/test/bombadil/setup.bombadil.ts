// Bombadil terminal specification for the /peers menu with a refusing backend (safety suite), run
// against the real Pi CLI. Run with `npm run test:bombadil:peers:setup`. Pi loads
// test/bombadil/setup-extension.ts: its backend waits 1.5 s and then refuses every acquisition, and
// setup-probe.ts reports unreviewed disk writes in the footer as `probe:UNREVIEWED-WRITE <path>`
// (or `-CHANGE`). Bombadil sees only the screen, so that status line is how "no changes before
// consent" becomes checkable. Shared generators and properties live in setup-keys.ts.
import { weighted } from "@antithesishq/bombadil/terminal";
import { commands, menuKeys, resize, towardApply } from "./setup-keys.ts";

export { noReplacementChars } from "@antithesishq/bombadil/terminal/defaults/properties";
export {
  applyHasOutcome,
  applyReached,
  backTaken,
  escapeClosesRoot,
  escapeGoesBack,
  footerAgrees,
  hintMatchesDepth,
  menuFits,
  noCursorInViews,
  noUnreviewedChange,
  noUnreviewedWrite,
  oneSelected,
  outcomeReadable,
  outcomeShown,
  piKeepsRunning,
  probeAppears,
  probeShown,
  rootOutcomesMatch,
  rootReached,
  submenuReached,
} from "./setup-keys.ts";

export const setupKeys = weighted([
  [10, commands({ bare: 6, setup: 3, status: 2, reset: 1, doctor: 1 })],
  [30, menuKeys(12)],
  [4, towardApply],
  [1, resize],
]);
