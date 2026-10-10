import process from "node:process";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { createAgentSdkStream } from "./bridge";
import type { AgentSdkRun } from "./bridge";
import { cacheDiagnosticsTracker, parseCacheDiagnosticsMode } from "./cache-diagnostics";
import { createCommandRunner } from "./command-runtime";
import type { CommandRunner } from "./command-runtime";
import { formatModelStatus, models, providerModel } from "./models";
import { inspectBashCommand, sanitizeBashContent, sanitizeContextMessages } from "./output-safety";
import { ClaudeUsageQueries, formatClaudeUsageStatus, inspectClaudeUsage } from "./sdk-usage";
import {
  ClaudeSdkVersionSources,
  formatClaudeSdkVersionStatus,
  inspectClaudeSdkVersions,
} from "./sdk-version-status";
import { createClaudeAgentSdkRunner } from "./sdk/runner";

/** Services the slash commands run against. */
type CommandServices = ClaudeSdkVersionSources | ClaudeUsageQueries;

const commandLayer: Layer.Layer<CommandServices> = Layer.mergeAll(
  ClaudeSdkVersionSources.layer,
  ClaudeUsageQueries.layer,
);

function registerStatusCommands(
  pi: ExtensionAPI,
  observedModels: ReadonlyMap<string, string>,
  commands: CommandRunner<CommandServices>,
): void {
  pi.registerCommand("claude-sdk-status", {
    description: "Show Agent SDK versions and observed model mappings",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      const notice = await commands.report(inspectClaudeSdkVersions(), (status) => ({
        text: `${formatClaudeSdkVersionStatus(status)}\n\n${formatModelStatus(observedModels)}`,
        level: status.updateSuggested ? "warning" : "info",
      }));
      if (notice !== undefined) {
        ctx.ui.notify(notice.text, notice.level);
      }
    },
  });
  pi.registerCommand("claude-sdk-usage", {
    description: "Show remaining Claude subscription usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      const notice = await commands.report(inspectClaudeUsage(), (status) => ({
        text: formatClaudeUsageStatus(status),
        level: "info",
      }));
      if (notice !== undefined) {
        ctx.ui.notify(notice.text, notice.level);
      }
    },
  });
}

function registerSafetyHooks(pi: ExtensionAPI): void {
  // A section, not a returned systemPrompt: returning one replaces the whole prompt and drops
  // the sections other extensions set in the same event.
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections["bash-output-safety"] =
      "Bash output safety: never cat an executable or print raw binary/base64 data. Use file, otool, or strings for executables, and inspect encoded files via metadata instead of stdout.";
  });
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) {
      return undefined;
    }
    const reason = inspectBashCommand(event.input.command);
    return reason === undefined ? undefined : { block: true, reason };
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "bash") {
      return undefined;
    }
    const sanitized = sanitizeBashContent(event.content);
    if (!sanitized.detected) {
      return undefined;
    }
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
    models: models.map((model) => providerModel(model)),
    streamSimple: (model, context, options) =>
      createAgentSdkStream({ model, context, options, run: runClaudeAgentSdk }),
  });
}

/** Register the Claude Agent SDK provider and bash-output safety hooks. */
export default function registerClaudeSdkProvider(pi: ExtensionAPI): void {
  // Selector -> concrete model last observed on a real turn, for /claude-sdk-status.
  const observedModels = new Map<string, string>();
  const runClaudeAgentSdk = createClaudeAgentSdkRunner({
    // The environment is read here, at the composition root, and nowhere deeper.
    cacheDiagnostics: Effect.runSync(
      cacheDiagnosticsTracker(parseCacheDiagnosticsMode(process.env)),
    ),
    modelObserver: (observation) => {
      observedModels.set(observation.selector, observation.canonicalModel);
    },
  });
  const commands = createCommandRunner(commandLayer);
  pi.on("session_shutdown", async () => {
    await commands.dispose();
  });
  registerStatusCommands(pi, observedModels, commands);
  registerSafetyHooks(pi);
  registerProvider(pi, runClaudeAgentSdk);
}
