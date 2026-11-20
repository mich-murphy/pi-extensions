import type { SetupBackend } from "./backend.js";
import type { ManagedSetup } from "./managed.js";
import type { Progress } from "./menu/forms.js";
import type { Screen } from "./menu/model.js";
import type { LocalPlan } from "./plan.js";

/** Replaces this Pi's runtime with an applied plan; `replace` must be explicit for a live one. */
export type ActivatePlan = (
  plan: LocalPlan,
  setup: ManagedSetup,
  replace?: boolean,
) => Promise<void>;
/** Exactly one shared-gateway restart request; an uncertain outcome is never replayed. */
export type Restart = (setup: ManagedSetup) => Promise<"acknowledged" | "uncertain">;
/** Guarded reconnect of this Pi; `fresh` asks for a fresh admission after a restart. */
export type Reconnect = (fresh?: boolean) => Promise<void>;
/** A reviewed acquisition route; no backend means acquisition is blocked. */
export type Acquisition = {
  readonly backend?: SetupBackend;
  readonly description: string;
  /** A plain reason when there is no backend. */
  readonly blocked?: string;
};

/**
 * The Setup row of the Peers root: its value and description, the screen it opens, and the RPC
 * notice for a menu that closes without any action. Building it is read-only.
 */
export type SetupRoute = {
  readonly value: string;
  readonly description: string;
  /** False when nothing is configured, so Reconnect has nothing to do. */
  readonly configured: boolean;
  /** Undefined when the row has nothing to open (for example while checking). */
  readonly screen?: (progress: Progress) => Screen;
  /** Evaluated when an RPC menu closes without any action. */
  readonly cancelled: () => Notice;
};

export type Notice = { readonly message: string; readonly level: "info" | "warning" };
export const NO_CHANGES: Notice = { message: "Cancelled — no changes made.", level: "info" };

export const SETUP_STEPS = [
  "Getting the verified gateway",
  "Saving private configuration",
  "Starting the gateway and connecting",
] as const;

export const NOTHING_TO_RESET =
  "Nothing to reset: peers is not set up for this Pi profile. No changes made.";
