import type { SetupBackend } from "./backend.js";
import type { ManagedSetup } from "./managed.js";
import type { Progress } from "./menu/forms.js";
import type { Screen } from "./menu/model.js";
import type { LocalPlan } from "./plan.js";

export type ActivatePlan = (
  plan: LocalPlan,
  setup: ManagedSetup,
  replace?: boolean,
) => Promise<void>;

export type RestartOutcome = "acknowledged" | "uncertain" | "not-running";

export type Restart = (setup: ManagedSetup) => Promise<RestartOutcome>;

export type Reconnect = (fresh?: boolean) => Promise<void>;

export type Acquisition = {
  readonly backend?: SetupBackend;
  readonly description: string;
  readonly blocked?: string;
};

export type SetupRoute = {
  readonly value: string;
  readonly description: string;
  readonly configured: boolean;
  readonly screen?: (progress: Progress) => Screen;
  readonly cancelled: () => Notice;
};

export type Notice = { readonly message: string; readonly level: "info" | "warning" };

export const NO_CHANGES: Notice = { message: "Cancelled. Nothing was changed.", level: "info" };

export const SETUP_STEPS = [
  "Getting the verified gateway",
  "Saving private configuration",
  "Starting the gateway and connecting",
] as const;

export const NOTHING_TO_RESET = "Nothing to reset: peers is not set up.";
