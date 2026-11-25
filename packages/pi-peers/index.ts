import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfiguration, visibleText } from "./adapter/config.js";
import type { Configuration } from "./adapter/config.js";
import { connectLabel } from "./adapter/label.js";
import { footerLine, footerStatus, statusSummary, statusText } from "./adapter/presentation.js";
import type { FooterTheme, StatusState, StatusSummary } from "./adapter/presentation.js";
import { createAdapterRuntime } from "./adapter/runtime.js";
import type { AdapterSession } from "./adapter/session.js";
import { registerTools } from "./adapter/tools.js";
import type { ToolHost } from "./adapter/tools.js";
import { freshId } from "./adapter/transport.js";
import { hasResetTarget, readManaged, reloadManagedLauncher } from "./onboarding/backend.js";
import type { SetupBackend } from "./onboarding/backend.js";
import { doctor, doctorReport, doctorRowText } from "./onboarding/doctor.js";
import type { DoctorReport } from "./onboarding/doctor.js";
import type { ManagedSetup } from "./onboarding/managed.js";
import type { MenuModel } from "./onboarding/menu/model.js";
import {
  outcomeLevel,
  outcomeLines,
  outcomeText,
  storedOutcome,
} from "./onboarding/menu/progress.js";
import type { Outcome } from "./onboarding/menu/progress.js";
import { peersMenu } from "./onboarding/menu/root.js";
import type { ActionKind, RootState } from "./onboarding/menu/root.js";
import { runMenu } from "./onboarding/menu/run.js";
import type { MenuContext } from "./onboarding/menu/run.js";
import { NotActive, refusalText } from "./onboarding/outcome.js";
import { NO_CHANGES, NOTHING_TO_RESET } from "./onboarding/route.js";
import type { ActivatePlan, SetupRoute } from "./onboarding/route.js";
import { prepareSetup, resetOutcome } from "./onboarding/setup.js";

type MenuHolder = { model?: MenuModel };

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

const BUSY = "Peers is busy with another action. Try again when it finishes.";
const STALE = "This session ended. Start a new Pi session to use the saved settings.";
const START_TECHNICAL = "This Pi could not start its connection.";
const NOT_ACCEPTED = "The gateway did not accept this Pi. Nothing was sent twice.";
const STALE_TECHNICAL = "The session ended during reconnect.";

function reconnectNext(connected: boolean, after: StatusSummary): string {
  if (connected) {
    return after.next ?? "Open another Pi session to collaborate.";
  }

  return after.state === "off" && after.next !== undefined
    ? after.next
    : "Run /peers doctor to check the gateway.";
}

type Runtime = Awaited<ReturnType<typeof createAdapterRuntime>>;

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

const CHECKING: SetupRoute = {
  value: "Checking…",
  description: "Reading the saved setup.",
  configured: false,
  cancelled: () => NO_CHANGES,
};

export type PeersContext = MenuContext &
  Pick<ExtensionContext, "isIdle"> & {
    readonly ui: MenuContext["ui"] &
      Pick<ExtensionContext["ui"], "setStatus"> & { readonly theme?: FooterTheme };
    readonly sessionManager: Pick<
      ExtensionContext["sessionManager"],
      "getCwd" | "getSessionId" | "getSessionName" | "getHeader"
    >;
  };

export type PeersCommand = Omit<RegisteredCommand, "name" | "sourceInfo" | "handler"> & {
  handler: (args: string, context: PeersContext) => Promise<void>;
};

export type PeersEventPayloads = {
  session_start: { readonly type: "session_start" };
  session_shutdown: { readonly type: "session_shutdown" };
  message_end: { readonly type: "message_end" } & {
    message: Parameters<AdapterSession["observed"]>[0];
  };
  agent_before_settle: Pick<AgentBeforeSettleEvent, "entries" | "type">;
  agent_settled: { readonly type: "agent_settled" };
  session_compact: { readonly type: "session_compact" };
  session_compact_failed: Pick<SessionCompactFailedEvent, "aborted" | "type">;
};

export type PeersEvents = {
  [Name in keyof PeersEventPayloads]: (
    event: PeersEventPayloads[Name],
    context: PeersContext,
  ) => Name extends "agent_before_settle"
    ? AgentBeforeSettleEventResult | undefined
    : Promise<void> | void;
};

export type PeersHost = Pick<ExtensionAPI, "sendMessage" | "registerEntryRenderer"> &
  Partial<Pick<ExtensionAPI, "appendEntry">> &
  ToolHost & {
    registerCommand: (name: string, options: PeersCommand) => void;
    on: {
      (name: "session_start", handler: PeersEvents["session_start"]): void;
      (name: "session_shutdown", handler: PeersEvents["session_shutdown"]): void;
      (name: "message_end", handler: PeersEvents["message_end"]): void;
      (name: "agent_before_settle", handler: PeersEvents["agent_before_settle"]): void;
      (name: "agent_settled", handler: PeersEvents["agent_settled"]): void;
      (name: "session_compact", handler: PeersEvents["session_compact"]): void;
      (name: "session_compact_failed", handler: PeersEvents["session_compact_failed"]): void;
    };
  };

function attended(ctx: PeersContext): boolean {
  return ctx.hasUI && (ctx.mode === "tui" || ctx.mode === "rpc");
}

export default function registerCommunication(
  pi: PeersHost,
  testBackend?: {
    backend: SetupBackend;
    description: string;
    restart?: (setup: ManagedSetup) => Promise<"acknowledged" | "uncertain">;
    observe?: { consented: (action: string) => void };
    runtime?: typeof createAdapterRuntime;
  },
): void {
  let current: PeersContext | undefined;
  let owned: Runtime | undefined;
  let diagnostic = "not enabled (no user-agent pi-peers.json)";
  let generation = 0;
  let running = 0;
  const busy = (): boolean => running > 0;

  const track = async <T>(work: Promise<T>): Promise<T> => {
    running += 1;

    try {
      return await work;
    } finally {
      running -= 1;
    }
  };

  const ensureCurrent = async (started: number, fresh?: Runtime): Promise<void> => {
    if (generation !== started) {
      await fresh?.dispose();
      throw new NotActive(STALE);
    }
  };

  const startRuntime = async (
    ctx: PeersContext,
    config: Configuration,
    setup: ManagedSetup | undefined,
    started: number,
  ): Promise<Runtime> => {
    current = ctx;
    const label = await connectLabel(config, ctx.sessionManager);
    await ensureCurrent(started);

    const runtime = await (testBackend?.runtime ?? createAdapterRuntime)(
      { ...config, label },
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

  const restore = async (ctx: PeersContext, started: number): Promise<void> => {
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
      ctx.ui.setStatus("peers", footerLine("setup_failed", ctx.ui.theme));
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

  const activatePlan = (ctx: PeersContext): ActivatePlan => {
    const started = generation;

    return async (plan, setup, replace) => {
      await ensureCurrent(started);

      if (owned !== undefined && replace !== true) {
        throw new NotActive(
          "This Pi still uses its earlier connection. Start a new Pi session to use the saved settings.",
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

  const registered = async (runtime: Runtime, started: number): Promise<void> => {
    try {
      await runtime.session.reconnect();
    } catch {
      await ensureCurrent(started);
      throw new Error(NOT_ACCEPTED);
    }

    await ensureCurrent(started);

    if (!runtime.session.status().connected) {
      throw new Error(NOT_ACCEPTED);
    }
  };

  const ensureRuntime = async (ctx: PeersContext, started: number): Promise<string | undefined> => {
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

  const reconnectCurrent = async (ctx: PeersContext, fresh = false): Promise<Reconnected> => {
    const started = generation;
    const failure = await ensureRuntime(ctx, started);
    const session = owned?.session;

    if (failure !== undefined || session === undefined) {
      return { connected: false, technical: failure === undefined ? [] : [failure] };
    }

    try {
      await session.reconnect(fresh);
    } catch {
      return { connected: false, technical: [NOT_ACCEPTED] };
    }

    if (generation !== started) {
      return { connected: false, technical: [STALE_TECHNICAL] };
    }

    return { connected: session.status().connected, technical: [] };
  };

  const summary = () => statusSummary(owned?.session.status(), diagnostic);
  const liveLinks = () => owned?.session.linkStates() ?? [];

  const reconnectOutcome = async (ctx: PeersContext): Promise<Outcome> => {
    const { connected, technical } = await reconnectCurrent(ctx);
    const after = summary();

    return {
      ok: connected,
      headline: connected
        ? `✓ Reconnected — ${after.headline}`
        : `✗ Reconnect failed: ${after.headline.charAt(0).toLowerCase()}${after.headline.slice(1)}`,
      facts: after.rows,
      next: reconnectNext(connected, after),
      technical: [...technical, ...after.technical],
    };
  };

  const disable = async (): Promise<void> => {
    await owned?.dispose();
    owned = undefined;
    diagnostic = "participation disabled";
  };

  const footer = (ctx: PeersContext, outcome: Outcome, kind: ActionKind, saved: boolean) => {
    const live = footerStatus(owned?.session.status(), owned !== undefined, ctx.ui.theme);

    if (kind === "reconnect" && live === undefined) {
      return;
    }

    if (live !== undefined || outcome.ok || kind !== "setup" || !saved) {
      ctx.ui.setStatus("peers", live);
    } else {
      ctx.ui.setStatus(
        "peers",
        footerLine(
          outcome.headline.startsWith("!") ? "activation_pending" : "setup_failed",
          ctx.ui.theme,
        ),
      );
    }
  };

  const report = (
    ctx: PeersContext,
    outcome: Outcome,
    hidden: boolean,
    kind: ActionKind,
    saved: boolean,
  ): void => {
    footer(ctx, outcome, kind, saved);
    pi.appendEntry?.("peers-report", outcome);

    if (hidden || ctx.mode !== "tui") {
      ctx.ui.notify(outcomeText(outcome), outcomeLevel(outcome));
    }
  };

  const reconnectGuarded = (ctx: PeersContext) => async (fresh?: boolean) => {
    const result = await reconnectCurrent(ctx, fresh);

    if (!result.connected) {
      throw new Error(NOT_ACCEPTED);
    }
  };

  const load = async (ctx: PeersContext): Promise<RootState> => {
    const agentDir = getAgentDir();

    const [setup, checks, resettable] = await Promise.all([
      prepareSetup(agentDir, activatePlan(ctx), testBackend, reconnectGuarded(ctx)),
      doctorReport(agentDir, { inMenu: true, liveLinks: liveLinks() }).then(doctorLines, () => [
        "✗ Doctor could not read the setup files.",
      ]),
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

  const openMenu = async (ctx: PeersContext, start?: "setup" | "reset"): Promise<void> => {
    const opened = generation;

    let state: RootState = {
      status: { value: "", lines: ["Checking…"] },
      doctor: ["Checking…"],
      setup: CHECKING,
      resettable: undefined,
      busy: busy(),
    };

    const loading = load(ctx);
    const tui = ctx.mode === "tui" && ctx.ui.custom !== undefined;

    if (!tui) {
      state = await loading;
    }

    const holder: MenuHolder = {};

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
            ctx.ui.setStatus("peers", footerLine("setting_up", ctx.ui.theme));
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

  const menuCommand = async (action: string, ctx: PeersContext): Promise<void> => {
    if (!attended(ctx)) {
      ctx.ui.notify(
        action === "" ? statusText(summary()) : `/peers ${action} needs an interactive session.`,
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
      ctx.ui.notify(
        refusalText(
          error instanceof Error ? error : undefined,
          "The peers menu could not open. Run /peers doctor to check your files.",
        ),
        "error",
      );
    }
  };

  pi.registerCommand("peers", {
    description: "Peers menu: status, setup, doctor, reconnect, reset",
    getArgumentCompletions: (prefix) => {
      const items = COMMANDS.flatMap(({ value, description }) =>
        value.startsWith(prefix) ? [{ value, label: value, description }] : [],
      );

      return items.length === 0 ? null : items;
    },
    handler: async (args, ctx) => {
      const action = args.trim();

      if (action !== "" && !ACTIONS.includes(action)) {
        ctx.ui.notify(`Unknown /peers action. Usage: /peers [${ACTIONS.join("|")}]`, "warning");

        return;
      }

      if (action === "" || action === "setup" || action === "reset") {
        await menuCommand(action, ctx);

        return;
      }

      if (action === "doctor") {
        ctx.ui.notify(
          `${await doctor(getAgentDir(), { liveLinks: liveLinks() })}\nLive: ${summary().headline}`,
          "info",
        );

        return;
      }

      if (action === "reconnect") {
        if (busy()) {
          ctx.ui.notify(BUSY, "warning");

          return;
        }

        const outcome = await track(reconnectOutcome(ctx));
        ctx.ui.notify(outcomeText(outcome), outcomeLevel(outcome));

        return;
      }

      ctx.ui.notify(statusText(summary()), "info");
    },
  });
}
