// Bombadil terminal specification for the /comms onboarding dialogs, run against the real Pi CLI.
// Run with `npm run test:bombadil:comms`. Pi loads test/bombadil/setup-extension.ts, which wires
// pi-comms to a backend that refuses every acquisition and reports unreviewed disk writes in the
// footer as `probe:UNREVIEWED-WRITE <path>` (or `-CHANGE` for a changed or deleted path).
// Bombadil sees only the screen, so that status line is how "no changes before Apply" becomes
// checkable. Generators and properties live in setup-keys.ts.
import { weighted } from "@antithesishq/bombadil/terminal";
import { commands, dialogKeys, resize } from "./setup-keys.ts";

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

export const setupKeys = weighted([
  [10, commands],
  [20, dialogKeys],
  [1, resize],
]);
