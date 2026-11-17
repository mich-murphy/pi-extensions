import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfiguration } from "./adapter/config.js";
import { diagnostics } from "./adapter/presentation.js";
import { createAdapterRuntime } from "./adapter/runtime.js";
import { registerTools } from "./adapter/tools.js";
import { freshId } from "./adapter/transport.js";
import { readManaged, reloadManagedLauncher } from "./onboarding/backend.js";
import type { SetupBackend } from "./onboarding/backend.js";
import { doctor, remoteSnapshot } from "./onboarding/doctor.js";
import type { ManagedSetup } from "./onboarding/managed.js";
import { setupCommand, resetCommand } from "./onboarding/setup.js";
import type { ActivatePlan } from "./onboarding/upgrade.js";

/** API-only loading is inert without configuration; the optional backend is an explicit test seam. */
export default function registerCommunication(
  pi: ExtensionAPI,
  testBackend?: {
    backend: SetupBackend;
    description: string;
    restart?: (setup: ManagedSetup) => Promise<"acknowledged" | "uncertain">;
  },
): void {
  let current: ExtensionContext | undefined;
  let owned: Awaited<ReturnType<typeof createAdapterRuntime>> | undefined;
  let diagnostic = "not enabled (no user-agent session-communication.json)";
  registerTools(pi, () => owned?.session);
  pi.on("session_start", async (_event, ctx) => {
    current = ctx;
    try {
      const config = await loadConfiguration(getAgentDir());
      if (config === undefined) {
        return;
      }
      const managed = await readManaged(getAgentDir(), config);
      owned = await createAdapterRuntime(
        config,
        {
          machineId: config.machineId,
          sessionId: ctx.sessionManager.getSessionId(),
          runtimeNonce: freshId(),
        },
        pi,
        () => current,
        managed === undefined ? undefined : reloadManagedLauncher(getAgentDir(), config, managed),
      );
      diagnostic = "enabled";
    } catch {
      diagnostic =
        "configuration or startup failed. Check <agent dir>/session-communication.json (valid configuration, at most 32 KiB), use /comms doctor, then /comms reconnect to retry activation";
      ctx.ui.setStatus("session-communication", "Peers: configuration/startup failed");
    }
  });
  pi.on("session_shutdown", async () => {
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
  const activatePlan =
    (ctx: ExtensionContext): ActivatePlan =>
    async (plan, setup, replace) => {
      if (owned !== undefined && replace !== true) {
        throw new Error(
          "An existing runtime must be explicitly disabled before replacement; volatile state would be lost",
        );
      }
      if (owned !== undefined) {
        if (!ctx.isIdle()) {
          throw new Error(
            "Configuration saved; this Pi is busy and was not replaced. Activation remains pending.",
          );
        }
        await owned.dispose();
        owned = undefined;
      }
      current = ctx;
      owned = await createAdapterRuntime(
        plan.adapter,
        {
          machineId: plan.adapter.machineId,
          sessionId: ctx.sessionManager.getSessionId(),
          runtimeNonce: freshId(),
        },
        pi,
        () => current,
        reloadManagedLauncher(getAgentDir(), plan.adapter, setup),
      );
      try {
        await owned.session.reconnect();
      } catch {
        throw new Error(
          "Configuration saved; activation pending: guarded gateway registration unavailable. Existing sessions may still use old trust until the old gateway exits; no control request was replayed.",
        );
      }
      if (!owned.session.status().connected) {
        throw new Error(
          "Configuration saved; activation pending: guarded gateway registration failed. Existing sessions may still use the old configuration until that gateway exits.",
        );
      }
      diagnostic = "enabled";
    };
  const mutate = async (action: string, ctx: ExtensionContext): Promise<void> => {
    try {
      if (action === "reset") {
        await resetCommand(getAgentDir(), ctx, async () => {
          await owned?.dispose();
          owned = undefined;
          diagnostic = "participation disabled";
        });
      } else {
        await setupCommand(getAgentDir(), ctx, activatePlan(ctx), testBackend, async (fresh) => {
          if (!(await reconnectCurrent(ctx, fresh))) {
            throw new Error("Guarded registration unavailable; activation pending or unconfirmed");
          }
        });
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : "Communication mutation refused; no changes made",
        "warning",
      );
    }
  };
  const reconnectCurrent = async (ctx: ExtensionContext, fresh = false): Promise<boolean> => {
    if (owned === undefined) {
      try {
        const config = await loadConfiguration(getAgentDir());
        if (config !== undefined) {
          const managed = await readManaged(getAgentDir(), config);
          current = ctx;
          owned = await createAdapterRuntime(
            config,
            {
              machineId: config.machineId,
              sessionId: ctx.sessionManager.getSessionId(),
              runtimeNonce: freshId(),
            },
            pi,
            () => current,
            managed === undefined
              ? undefined
              : reloadManagedLauncher(getAgentDir(), config, managed),
          );
          diagnostic = "enabled";
        }
      } catch {
        ctx.ui.notify(
          "Activation unavailable; run /comms doctor. No runtime was replaced and no uncertain sends were replayed.",
          "warning",
        );
      }
    }
    const session = owned?.session;
    if (session !== undefined) {
      try {
        await session.reconnect(fresh);
      } catch {
        ctx.ui.notify(
          "Managed activation unavailable or unconfirmed; no admitted work was replayed. Passive reconnect never restarts a shared gateway. If an old generation survives, /comms setup → Activate saved configuration offers one explicitly reviewed restart; /comms status shows bounded accounting.",
          "warning",
        );
      }
    }
    return owned?.session.status().connected === true;
  };
  const registerCommand = (name: string, legacy: boolean): void => {
    const actions = legacy
      ? ["status", "reconnect"]
      : ["status", "setup", "doctor", "reconnect", "reset"];
    pi.registerCommand(name, {
      description: legacy
        ? "Compatibility alias for /comms status or reconnect"
        : "Communication status, read-only doctor, or bounded reconnect",
      getArgumentCompletions: (prefix) => {
        const items = actions
          .filter((action) => action.startsWith(prefix))
          .map((action) => ({ value: action, label: action }));
        return items.length === 0 ? null : items;
      },
      handler: async (args, ctx) => {
        const action = args.trim() || "status";
        if (!actions.includes(action)) {
          ctx.ui.notify(
            `Usage: /${name} [${actions.join("|")}]${legacy ? "; canonical command: /comms" : ""}`,
            "warning",
          );
          return;
        }
        if (action === "setup" || action === "reset") {
          await mutate(action, ctx);
          return;
        }
        if (action === "doctor") {
          ctx.ui.notify(
            `${await doctor(getAgentDir())}\n${diagnostics(owned?.session.status(), diagnostic)}`,
            "info",
          );
          return;
        }
        if (action === "reconnect") {
          await reconnectCurrent(ctx);
        }
        const session = owned?.session;
        ctx.ui.notify(
          `${diagnostics(session?.status(), diagnostic)}\n${await remoteSnapshot(getAgentDir())}`,
          "info",
        );
      },
    });
  };
  registerCommand("comms", false);
  registerCommand("session-communication", true);
}
