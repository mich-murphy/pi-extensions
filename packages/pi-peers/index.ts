import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfiguration, visibleText } from "./adapter/config.js";
import type { Configuration } from "./adapter/config.js";
import { footerStatus, statusSummary, statusText } from "./adapter/presentation.js";
import type { StatusState } from "./adapter/presentation.js";
import { createAdapterRuntime } from "./adapter/runtime.js";
import { registerTools } from "./adapter/tools.js";
import { freshId } from "./adapter/transport.js";
import { hasResetTarget, readManaged, reloadManagedLauncher } from "./onboarding/backend.js";
import type { SetupBackend } from "./onboarding/backend.js";
import { doctor, doctorReport, doctorRowText } from "./onboarding/doctor.js";
import type { DoctorReport } from "./onboarding/doctor.js";
import type { ManagedSetup } from "./onboarding/managed.js";
import type { MenuModel } from "./onboarding/menu/model.js";
import { outcomeLines, outcomeText, storedOutcome } from "./onboarding/menu/progress.js";
import type { Outcome } from "./onboarding/menu/progress.js";
import { peersMenu } from "./onboarding/menu/root.js";
import type { ActionKind, RootState } from "./onboarding/menu/root.js";
import { runMenu } from "./onboarding/menu/run.js";
import { NotActive, safeReason } from "./onboarding/outcome.js";
import { NO_CHANGES, NOTHING_TO_RESET } from "./onboarding/route.js";
import type { ActivatePlan, SetupRoute } from "./onboarding/route.js";
import { prepareSetup, resetOutcome } from "./onboarding/setup.js";

const COMMANDS = [
  { value: "status", description: "Show whether peers is connected" },
  { value: "setup", description: "Set up or manage peers" },
  { value: "doctor", description: "Check the peers files and gateway (read-only)" },
  { value: "reconnect", description: "Retry connecting this Pi" },
  { value: "reset", description: "Disable peers for this agent directory" },
] as const;
const ACTIONS: readonly string[] = COMMANDS.map((command) => command.value);
const STATE_VALUES: Record<StatusState, string> = {
  off: "Not set up",
  connected: "Connected",
  pending: "Activation pending",
  unavailable: "Unavailable",
  failed: "Setup failed",
};
const BUSY = "Peers is busy with another action. Try again when it finishes. No changes made.";
/** Why a runtime started for an ended session was dropped. */
const STALE = "Settings saved; not active in this session. A new Pi session uses them.";
const START_TECHNICAL =
  "Activation unavailable: no runtime was replaced and no uncertain sends were replayed.";
const REGISTER_TECHNICAL =
  "Managed activation unavailable or unconfirmed; no admitted work was replayed. Passive reconnect never restarts a shared gateway. If an old generation survives, Setup › Activate saved configuration offers one explicitly reviewed restart; /peers status shows bounded accounting.";
const STALE_TECHNICAL = "The session ended during reconnect; its new runtime was disposed.";

type Runtime = Awaited<ReturnType<typeof createAdapterRuntime>>;
/** A reconnect's result; `technical` holds the internal reason for a failure. */
type Reconnected = { readonly connected: boolean; readonly technical: readonly string[] };

function doctorLines(report: DoctorReport): string[] {
  return [
    ...report.rows.map((row) => doctorRowText(row)),
    ...(report.next === undefined ? [] : [`Next: ${report.next}`]),
    ...(report.technical.length === 0
      ? []
      : ["Technical details:", ...report.technical.map((line) => `  ${line}`)]),
  ];
}

/** Setup's row while the menu's first reads run. */
const CHECKING: SetupRoute = {
  value: "Checking…",
  description: "Reading the saved setup.",
  configured: false,
  cancelled: () => NO_CHANGES,
};

function attended(ctx: ExtensionContext): boolean {
  return ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc");
}

/** API-only loading is inert without configuration; the optional backend is an explicit test seam. */
export default function registerCommunication(
  pi: ExtensionAPI,
  testBackend?: {
    backend: SetupBackend;
    description: string;
    restart?: (setup: ManagedSetup) => Promise<"acknowledged" | "uncertain">;
    /** Called synchronously when a consent row is confirmed, before any effect. */
    observe?: { consented: (action: string) => void };
    /** Starts an adapter runtime; tests wrap the real one to observe its lifetime. */
    runtime?: typeof createAdapterRuntime;
  },
): void {
  let current: ExtensionContext | undefined;
  let owned: Runtime | undefined;
  let diagnostic = "not enabled (no user-agent pi-peers.json)";
  /** Bumped at session shutdown; work started in an older session leaves this one alone. */
  let generation = 0;
  /** Running Apply, Reset or Reconnect actions, possibly with their progress views hidden. */
  let running = 0;
  const busy = (): boolean => running > 0;
  /** Counts `work` as running until it settles; overlapping actions each count once. */
  const track = async <T>(work: Promise<T>): Promise<T> => {
    running += 1;
    try {
      return await work;
    } finally {
      running -= 1;
    }
  };
  /** Throws NotActive (disposing `fresh` first) when a session_shutdown landed during an await. */
  const ensureCurrent = async (started: number, fresh?: Runtime): Promise<void> => {
    if (generation !== started) {
      await fresh?.dispose();
      throw new NotActive(STALE);
    }
  };
  /** Starts and owns a runtime for `config`, unless the session ended meanwhile. */
  const startRuntime = async (
    ctx: ExtensionContext,
    config: Configuration,
    setup: ManagedSetup | undefined,
    started: number,
  ): Promise<Runtime> => {
    current = ctx;
    const runtime = await (testBackend?.runtime ?? createAdapterRuntime)(
      config,
      {
        machineId: config.machineId,
        sessionId: ctx.sessionManager.getSessionId(),
        runtimeNonce: freshId(),
      },
      pi,
      () => current,
      setup === undefined ? undefined : reloadManagedLauncher(getAgentDir(), config, setup),
    );
    await ensureCurrent(started, runtime);
    owned = runtime;
    return runtime;
  };
  /** Starts the saved configuration's runtime, if there is one. */
  const restore = async (ctx: ExtensionContext, started: number): Promise<void> => {
    const config = await loadConfiguration(getAgentDir());
    await ensureCurrent(started);
    if (config === undefined) {
      return;
    }
    const managed = await readManaged(getAgentDir(), config);
    await ensureCurrent(started);
    await startRuntime(ctx, config, managed, started);
    diagnostic = "enabled";
  };
  registerTools(pi, () => owned?.session);
  // Test hosts may omit the entry API; Pi always provides it.
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer("peers-report", (entry, _options, theme) => {
      const outcome = storedOutcome(entry.data);
      return outcome === undefined
        ? undefined
        : new Text(
            outcomeLines(outcome)
              .map((line, index) =>
                index === 0
                  ? theme.fg(outcome.ok ? "accent" : "error", visibleText(line))
                  : visibleText(line),
              )
              .join("\n"),
            1,
            0,
          );
    });
  }
  pi.on("session_start", async (_event, ctx) => {
    current = ctx;
    const started = generation;
    try {
      await restore(ctx, started);
    } catch {
      if (generation !== started) {
        return;
      }
      diagnostic = "configuration or startup failed";
      ctx.ui.setStatus("peers", "Peers: setup failed");
    }
  });
  pi.on("session_shutdown", async () => {
    generation += 1;
    const previous = owned;
    owned = undefined;
    current = undefined;
    await previous?.dispose();
  });
  pi.on("message_end", (event) => {
    owned?.session.observed(event.message);
  });
  pi.on("agent_before_settle", (event) => owned?.session.beforeSettle(event));
  pi.on("agent_settled", () => {
    owned?.session.settled();
  });
  pi.on("session_compact", () => {
    owned?.session.afterCompaction();
  });
  pi.on("session_compact_failed", (event) => {
    owned?.session.afterCompaction(event.aborted);
  });
  const activatePlan = (ctx: ExtensionContext): ActivatePlan => {
    const started = generation;
    return async (plan, setup, replace) => {
      await ensureCurrent(started);
      if (owned !== undefined && replace !== true) {
        throw new Error(
          "An existing runtime must be explicitly disabled before replacement; volatile state would be lost",
        );
      }
      if (owned !== undefined) {
        if (!ctx.isIdle()) {
          throw new NotActive(
            "This Pi is busy and was not replaced. Start a new Pi session to use the saved settings.",
          );
        }
        const previous = owned;
        owned = undefined;
        await previous.dispose();
        await ensureCurrent(started);
      }
      const runtime = await startRuntime(ctx, plan.adapter, setup, started);
      await registered(runtime, started);
      diagnostic = "enabled";
    };
  };
  /** The guarded registration of a fresh runtime; a shutdown meanwhile already disposed it. */
  const registered = async (runtime: Runtime, started: number): Promise<void> => {
    try {
      await runtime.session.reconnect();
    } catch {
      await ensureCurrent(started);
      throw new Error(
        "Configuration saved; activation pending: guarded gateway registration unavailable. Existing sessions may still use old trust until the old gateway exits; no control request was replayed.",
      );
    }
    await ensureCurrent(started);
    if (!runtime.session.status().connected) {
      throw new Error(
        "Configuration saved; activation pending: guarded gateway registration failed. Existing sessions may still use the old configuration until that gateway exits.",
      );
    }
  };
  /** Starts the saved runtime when none runs; the reason goes to technical detail on failure. */
  const ensureRuntime = async (
    ctx: ExtensionContext,
    started: number,
  ): Promise<string | undefined> => {
    if (owned !== undefined) {
      return undefined;
    }
    try {
      await restore(ctx, started);
      return undefined;
    } catch {
      return generation === started ? START_TECHNICAL : STALE_TECHNICAL;
    }
  };
  /** Retries this Pi's connection; never notifies, so each caller reports it once. */
  const reconnectCurrent = async (ctx: ExtensionContext, fresh = false): Promise<Reconnected> => {
    const started = generation;
    const failure = await ensureRuntime(ctx, started);
    const session = owned?.session;
    if (failure !== undefined || session === undefined) {
      return { connected: false, technical: failure === undefined ? [] : [failure] };
    }
    try {
      await session.reconnect(fresh);
    } catch {
      return { connected: false, technical: [REGISTER_TECHNICAL] };
    }
    if (generation !== started) {
      return { connected: false, technical: [STALE_TECHNICAL] };
    }
    return { connected: session.status().connected, technical: [] };
  };
  const summary = () => statusSummary(owned?.session.status(), diagnostic);
  const reconnectOutcome = async (ctx: ExtensionContext): Promise<Outcome> => {
    const { connected, technical } = await reconnectCurrent(ctx);
    const after = summary();
    return {
      ok: connected,
      headline: `${connected ? "✓ Reconnected" : "✗ Reconnect failed"} — ${after.headline}`,
      facts: after.rows,
      // At most two plain sentences in a notification; internals stay under technical details.
      next: connected
        ? (after.next ?? "Open another Pi session to collaborate.")
        : "Run /peers doctor to see why; nothing was changed.",
      technical: [...technical, ...after.technical],
    };
  };
  const disable = async (): Promise<void> => {
    await owned?.dispose();
    owned = undefined;
    diagnostic = "participation disabled";
  };
  const footer = (ctx: ExtensionContext, outcome: Outcome, kind: ActionKind, saved: boolean) => {
    const live = footerStatus(owned?.session.status(), owned !== undefined);
    if (kind === "reconnect" && live === undefined) {
      // A reconnect writes nothing; without a runtime the footer keeps what it said.
      return;
    }
    if (live !== undefined || outcome.ok || kind !== "setup" || !saved) {
      ctx.ui.setStatus("peers", live);
    } else {
      ctx.ui.setStatus(
        "peers",
        outcome.headline.startsWith("!") ? "Peers: activation pending" : "Peers: setup failed",
      );
    }
  };
  const report = (
    ctx: ExtensionContext,
    outcome: Outcome,
    hidden: boolean,
    kind: ActionKind,
    saved: boolean,
  ): void => {
    footer(ctx, outcome, kind, saved);
    if (typeof pi.appendEntry === "function") {
      pi.appendEntry("peers-report", outcome);
    }
    if (hidden || ctx.mode !== "tui") {
      ctx.ui.notify(outcomeText(outcome), outcome.ok ? "info" : "warning");
    }
  };
  const reconnectGuarded = (ctx: ExtensionContext) => async (fresh?: boolean) => {
    const result = await reconnectCurrent(ctx, fresh);
    if (!result.connected) {
      throw new Error("Guarded registration unavailable; activation pending or unconfirmed");
    }
  };
  /** Everything the root shows, read fresh; a read that fails never closes the menu. */
  const load = async (ctx: ExtensionContext): Promise<RootState> => {
    const agentDir = getAgentDir();
    const [setup, checks, resettable] = await Promise.all([
      prepareSetup(agentDir, activatePlan(ctx), testBackend, reconnectGuarded(ctx)),
      doctorReport(agentDir, { inMenu: true }).then(doctorLines, () => [
        "✗ Doctor could not read the setup files.",
      ]),
      // An unreadable directory still offers Reset, which then refuses safely.
      hasResetTarget(agentDir).catch(() => true),
    ]);
    const status = statusSummary(owned?.session.status(), diagnostic, { inMenu: true });
    return {
      status: { value: STATE_VALUES[status.state], lines: statusText(status).split("\n") },
      doctor: checks,
      setup,
      resettable,
      busy: busy(),
    };
  };
  const openMenu = async (ctx: ExtensionContext, start?: "setup" | "reset"): Promise<void> => {
    const opened = generation;
    let state: RootState = {
      status: { value: "", lines: ["Checking…"] },
      doctor: ["Checking…"],
      setup: CHECKING,
      // Reset offers nothing until the real state has loaded.
      resettable: undefined,
      busy: busy(),
    };
    const loading = load(ctx);
    // TUI: show the menu at once with Setup `Checking…`; RPC answers need the real rows first.
    const tui = ctx.mode === "tui" && ctx.ui.custom !== undefined;
    if (!tui) {
      state = await loading;
    }
    const holder: { model?: MenuModel } = {};
    const reload = async (): Promise<void> => {
      state = await load(ctx);
      holder.model?.refresh();
    };
    holder.model = peersMenu(
      {
        state: () => ({ ...state, busy: busy() }),
        reset: async () => resetOutcome(getAgentDir(), disable),
        reconnect: async () => reconnectOutcome(ctx),
        started: (kind, done) => {
          if (kind === "setup") {
            ctx.ui.setStatus("peers", "Peers: setting up…");
          }
          track(done).catch(() => undefined);
        },
        finished: (outcome, hidden, kind) => {
          if (generation !== opened) {
            return;
          }
          report(ctx, outcome, hidden, kind, state.setup.configured || outcome.ok);
          if (ctx.mode !== "tui") {
            holder.model?.close();
          }
          // The root re-reads state after any outcome, so Setup becomes Manage and so on.
          reload().catch(() => undefined);
        },
        guard: { canAct: () => !busy(), busy: BUSY },
      },
      testBackend?.observe,
      tui ? undefined : start,
    );
    const model = holder.model;
    if (tui) {
      const shown = async (): Promise<void> => {
        state = await loading;
        if (start !== undefined && model.depth === 0 && !model.closed) {
          model.activate(start);
        }
        model.refresh();
      };
      shown().catch(() => undefined);
    }
    await runMenu(
      ctx,
      model,
      start === "setup"
        ? () => {
            const notice = state.setup.cancelled();
            ctx.ui.notify(notice.message, notice.level);
          }
        : undefined,
    );
  };
  const menuCommand = async (action: string, ctx: ExtensionContext): Promise<void> => {
    if (!attended(ctx)) {
      ctx.ui.notify(
        action === ""
          ? statusText(summary())
          : `/peers ${action} needs the interactive TUI or an attended RPC client; no changes made.`,
        action === "" ? "info" : "warning",
      );
      return;
    }
    try {
      if (action !== "" && busy()) {
        ctx.ui.notify(BUSY, "warning");
        return;
      }
      if (action === "reset" && !(await hasResetTarget(getAgentDir()).catch(() => true))) {
        ctx.ui.notify(NOTHING_TO_RESET, "info");
        return;
      }
      await openMenu(ctx, action === "setup" || action === "reset" ? action : undefined);
    } catch (error) {
      // Never quote a parse or system error: it may contain file content or a path.
      ctx.ui.notify(
        safeReason(error, "The peers menu could not open; no changes made. Run /peers doctor."),
        "warning",
      );
    }
  };
  pi.registerCommand("peers", {
    description: "Peers menu: status, setup, doctor, reconnect, reset",
    getArgumentCompletions: (prefix) => {
      const items = COMMANDS.filter((command) => command.value.startsWith(prefix)).map(
        (command) => ({
          value: command.value,
          label: command.value,
          description: command.description,
        }),
      );
      return items.length === 0 ? null : items;
    },
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action !== "" && !ACTIONS.includes(action)) {
        ctx.ui.notify(`Usage: /peers [${ACTIONS.join("|")}]`, "warning");
        return;
      }
      if (action === "" || action === "setup" || action === "reset") {
        await menuCommand(action, ctx);
        return;
      }
      if (action === "doctor") {
        ctx.ui.notify(`${await doctor(getAgentDir())}\nLive: ${summary().headline}`, "info");
        return;
      }
      if (action === "reconnect") {
        if (busy()) {
          ctx.ui.notify(BUSY, "warning");
          return;
        }
        const outcome = await track(reconnectOutcome(ctx));
        ctx.ui.notify(outcomeText(outcome), outcome.ok ? "info" : "warning");
        return;
      }
      ctx.ui.notify(statusText(summary()), "info");
    },
  });
}
