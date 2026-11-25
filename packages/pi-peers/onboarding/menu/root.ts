import type { SetupRoute } from "../route.js";
import { NOTHING_TO_RESET } from "../route.js";
import type { Progress } from "./forms.js";
import { MenuModel } from "./model.js";
import type { ActGuard, Consent, Row, Screen } from "./model.js";
import { runWithProgress } from "./progress.js";
import type { Outcome, Step } from "./progress.js";

export type RootState = {
  readonly status: { readonly value: string; readonly lines: readonly string[] };
  readonly doctor: readonly string[];
  readonly setup: SetupRoute;
  readonly resettable: boolean | undefined;
  readonly busy: boolean;
};

export type ActionKind = "setup" | "reset" | "reconnect";

export type RootOptions = {
  readonly state: () => RootState;
  readonly reset: (step: Step) => Promise<Outcome>;
  readonly reconnect: (step: Step) => Promise<Outcome>;
  readonly started: (kind: ActionKind, done: Promise<void>) => void;
  readonly finished: (outcome: Outcome, hidden: boolean, kind: ActionKind) => void;
  readonly guard?: ActGuard;
};

function resetValue(state: RootState): string {
  if (state.busy) {
    return "Busy";
  }

  if (state.resettable === undefined) {
    return "Checking…";
  }

  return state.resettable ? "" : "Nothing to reset";
}

function report(title: string, lines: readonly string[]): Screen {
  return { kind: "report", title, lines: () => lines };
}

function resetScreen(state: RootState, progress: Progress, reset: RootOptions["reset"]): Screen {
  if (state.resettable !== true) {
    return report("Reset", [NOTHING_TO_RESET]);
  }

  return {
    kind: "list",
    title: "Reset",
    note: "Turns peers off for new sessions and closes this Pi's connection. Keys, revocation lists and the gateway install are kept.",
    rows: () => [
      {
        id: "disable",
        label: "Turn off peers",
        value: "",
        description:
          "Turn off peers for this Pi profile. Other open Pi sessions stay connected until they close.",
        activation: {
          kind: "consent",
          action: "Disable",
          run: () => {
            progress("Turning off", ["Turning off peers"], reset, "Result");
          },
        },
      },
    ],
  };
}

export function peersMenu(
  options: RootOptions,
  observe?: Consent,
  start?: "setup" | "reset",
): MenuModel {
  const progress =
    (base: ActionKind): Progress =>
    (title, planned, work, result, override) => {
      const kind = override ?? base;

      const done = runWithProgress(
        model,
        title,
        planned,
        work,
        (outcome, hidden) => {
          options.finished(outcome, hidden, kind);
        },
        result,
      );

      options.started(kind, done);
    };

  let cached: { readonly route: SetupRoute; readonly screen: Screen } | undefined;

  const setupScreen = (route: SetupRoute, open: (progress: Progress) => Screen): Screen => {
    if (cached?.route !== route) {
      cached = { route, screen: open(progress("setup")) };
    }

    return cached.screen;
  };

  const setupRow = (state: RootState): Row => {
    const { setup } = state;
    const open = setup.screen;

    return {
      id: "setup",
      label: "Setup",
      value: state.busy ? "Applying…" : setup.value,
      description: state.busy ? "Wait for the current action to finish." : setup.description,
      activation:
        state.busy || open === undefined
          ? { kind: "none" }
          : { kind: "open", screen: () => setupScreen(setup, open) },
    };
  };

  const reconnectRow = (state: RootState): Row => {
    if (!state.setup.configured) {
      return {
        id: "reconnect",
        label: "Reconnect",
        value: "Not set up",
        description: "Set up peers first.",
        activation: { kind: "none" },
      };
    }

    return {
      id: "reconnect",
      label: "Reconnect",
      value: state.busy ? "Busy" : "",
      description: "Retry connecting this Pi. It never restarts a shared gateway.",
      activation: state.busy
        ? { kind: "none" }
        : {
            kind: "consent",
            action: "Reconnect",
            run: () => {
              progress("reconnect")(
                "Reconnect › Reconnecting",
                ["Reconnecting"],
                options.reconnect,
                "Reconnect › Result",
              );
            },
          },
    };
  };

  const rows = (): Row[] => {
    const state = options.state();

    return [
      {
        id: "status",
        label: "Status",
        value: state.status.value,
        description: "This session's connection.",
        activation: { kind: "open", screen: () => report("Status", options.state().status.lines) },
      },
      setupRow(state),
      {
        id: "doctor",
        label: "Doctor",
        value: "",
        description: "Read-only checks of the peers files and gateway.",
        activation: { kind: "open", screen: () => report("Doctor", options.state().doctor) },
      },
      reconnectRow(state),
      {
        id: "reset",
        label: "Reset",
        value: resetValue(state),
        description: "Turn peers off for new sessions. Keys are kept.",
        activation:
          state.busy || state.resettable === undefined
            ? { kind: "none" }
            : {
                kind: "open",
                screen: () => resetScreen(options.state(), progress("reset"), options.reset),
              },
      },
    ];
  };

  const model: MenuModel = new MenuModel(
    { kind: "list", title: "Peers", rows },
    observe,
    options.guard,
  );

  if (start !== undefined) {
    model.activate(start);
  }

  return model;
}
