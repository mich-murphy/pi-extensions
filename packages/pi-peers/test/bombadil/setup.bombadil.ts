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
  [12, towardApply],
  [1, resize],
]);
