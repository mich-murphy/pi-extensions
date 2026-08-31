import {
  type ExtensionAPI,
  isToolCallEventType,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { type AgentSdkRun, createAgentSdkStream } from "./bridge";
import { cacheDiagnosticsFromEnvironment } from "./cache-diagnostics";
import { inspectBashCommand, sanitizeBashContent, sanitizeContextMessages } from "./output-safety";
import { createClaudeAgentSdkRunner } from "./sdk/runner";
import { formatClaudeUsageStatus, inspectClaudeUsage } from "./sdk-usage";
import { formatClaudeSdkVersionStatus, inspectClaudeSdkVersions } from "./sdk-version-status";

/** Models exposed by the official Claude Agent SDK provider. */
export const models: ReadonlyArray<ProviderModelConfig> = [
  { id: "sonnet", name: "Claude Sonnet (official Agent SDK)", reasoning: true },
  { id: "opus", name: "Claude Opus (official Agent SDK)", reasoning: true },
  { id: "fable", name: "Claude Fable (official Agent SDK)", reasoning: true },
  { id: "haiku", name: "Claude Haiku (official Agent SDK)", reasoning: false },
].map<ProviderModelConfig>(({ id, name, reasoning }) => ({
  id,
  name,
  reasoning,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
}));

function registerStatusCommands(pi: ExtensionAPI): void {
  pi.registerCommand("claude-sdk-status", {
    description: "Show Agent SDK and Claude Code versions",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const result = await inspectClaudeSdkVersions();
      if (result._tag === "err") {
        ctx.ui.notify(result.error.message, "error");
        return;
      }
      ctx.ui.notify(
        formatClaudeSdkVersionStatus(result.value),
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
    models: [...models],
    streamSimple: (model, context, options) =>
      createAgentSdkStream(model, context, options, runClaudeAgentSdk),
  });
}

/** Register the Claude Agent SDK provider and bash-output safety hooks. */
export default function registerClaudeSdkProvider(pi: ExtensionAPI): void {
  const runClaudeAgentSdk = createClaudeAgentSdkRunner(
    undefined,
    cacheDiagnosticsFromEnvironment(),
  );
  registerStatusCommands(pi);
  registerSafetyHooks(pi);
  registerProvider(pi, runClaudeAgentSdk);
}
