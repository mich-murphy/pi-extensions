import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { type AgentSdkRun, createAgentSdkStream } from "./bridge";
import { cacheDiagnosticsFromEnvironment } from "./cache-diagnostics";
import { formatModelStatus, models, providerModel } from "./models";
import { inspectBashCommand, sanitizeBashContent, sanitizeContextMessages } from "./output-safety";
import { createClaudeAgentSdkRunner } from "./sdk/runner";
import { formatClaudeUsageStatus, inspectClaudeUsage } from "./sdk-usage";
import { formatClaudeSdkVersionStatus, inspectClaudeSdkVersions } from "./sdk-version-status";

export { models } from "./models";

function registerStatusCommands(
  pi: ExtensionAPI,
  observedModels: ReadonlyMap<string, string>,
): void {
  pi.registerCommand("claude-sdk-status", {
    description: "Show Agent SDK versions and observed model mappings",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const result = await inspectClaudeSdkVersions();
      if (result._tag === "err") {
        ctx.ui.notify(result.error.message, "error");
        return;
      }
      ctx.ui.notify(
        `${formatClaudeSdkVersionStatus(result.value)}\n\n${formatModelStatus(observedModels)}`,
        result.value.updateSuggested ? "warning" : "info",
      );
    },
  });
  pi.registerCommand("claude-sdk-usage", {
    description: "Show remaining Claude subscription usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const result = await inspectClaudeUsage();
      if (result._tag === "err") {
        ctx.ui.notify(result.error.message, "error");
        return;
      }
      ctx.ui.notify(formatClaudeUsageStatus(result.value), "info");
    },
  });
}

function registerSafetyHooks(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nBash output safety: never cat an executable or print raw binary/base64 data. Use file, otool, or strings for executables, and inspect encoded files via metadata instead of stdout.`,
  }));
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const reason = inspectBashCommand(event.input.command);
    if (reason) return { block: true, reason };
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "bash") return;
    const sanitized = sanitizeBashContent(event.content);
    if (!sanitized.detected) return;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Quarantined ${sanitized.detected}-like bash output before it entered context. Compact or start a new session if similar output was recorded earlier.`,
        "warning",
      );
    }
    return { content: sanitized.content };
  });
  pi.on("context", (event) => ({ messages: sanitizeContextMessages(event.messages) }));
}

function registerProvider(pi: ExtensionAPI, runClaudeAgentSdk: AgentSdkRun): void {
  pi.registerProvider("claude-sdk", {
    name: "Claude subscription via official Agent SDK",
    baseUrl: "agent-sdk://local-claude-code",
    apiKey: "claude-sdk-managed-auth",
    api: "claude-sdk",
    models: models.map(providerModel),
    streamSimple: (model, context, options) =>
      createAgentSdkStream(model, context, options, runClaudeAgentSdk),
  });
}

/** Register the Claude Agent SDK provider and bash-output safety hooks. */
export default function registerClaudeSdkProvider(pi: ExtensionAPI): void {
  // Selector -> concrete model last observed on a real turn, for /claude-sdk-status.
  const observedModels = new Map<string, string>();
  const runClaudeAgentSdk = createClaudeAgentSdkRunner(undefined, {
    cacheDiagnostics: cacheDiagnosticsFromEnvironment(),
    modelObserver: (observation) => {
      observedModels.set(observation.selector, observation.canonicalModel);
    },
  });
  registerStatusCommands(pi, observedModels);
  registerSafetyHooks(pi);
  registerProvider(pi, runClaudeAgentSdk);
}
