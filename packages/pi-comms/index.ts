import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfiguration } from "./adapter/config.js";
import { diagnostics } from "./adapter/presentation.js";
import { createAdapterRuntime } from "./adapter/runtime.js";
import { registerTools } from "./adapter/tools.js";
import { freshId } from "./adapter/transport.js";
import { doctor } from "./onboarding/doctor.js";

/** Opt-in user configuration only. Never starts/installs a gateway or exports project state. */
export default function sessionCommunication(pi: ExtensionAPI): void {
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
      owned = await createAdapterRuntime(
        config,
        {
          machineId: config.machineId,
          sessionId: ctx.sessionManager.getSessionId(),
          runtimeNonce: freshId(),
        },
        pi,
        () => current,
      );
      diagnostic = "enabled";
    } catch {
      diagnostic =
        "configuration or startup failed. Check <agent dir>/session-communication.json (valid configuration, at most 32 KiB), confirm the gateway is running, then /reload";
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
  const registerCommand = (name: string, legacy: boolean): void => {
    const actions = legacy ? ["status", "reconnect"] : ["status", "doctor", "reconnect"];
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
        if (action === "doctor") {
          ctx.ui.notify(
            `${await doctor(getAgentDir())}\n${diagnostics(owned?.session.status(), diagnostic)}`,
            "info",
          );
          return;
        }
        const session = owned?.session;
        if (action === "reconnect" && session !== undefined) {
          try {
            await session.reconnect();
          } catch {
            ctx.ui.notify(
              "Session gateway unavailable; no admitted work was replayed. Check that the configured gateway is running and its socket is accessible, then use /comms status for bounded accounting.",
              "warning",
            );
          }
        }
        ctx.ui.notify(diagnostics(session?.status(), diagnostic), "info");
      },
    });
  };
  registerCommand("comms", false);
  registerCommand("session-communication", true);
}
