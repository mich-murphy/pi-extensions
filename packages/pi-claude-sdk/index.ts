import process from "node:process";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ProviderConfig,
  ToolCallEventResult,
  ToolResultEventResult,
  ContextEventResult,
} from "@earendil-works/pi-coding-agent";
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
import type { UsageLimitObservation } from "./sdk/runner";
import { blockValidationRecovery, validationRecoveryTool } from "./validation-recovery";

/** Event data consumed by the provider's safety hooks. */
export type ClaudeEvents = {
  readonly before_agent_start: {
    readonly systemPromptOptions: { readonly sections: Record<string, string> };
  };
  readonly tool_call: ToolCallEvent;
  readonly tool_result: Pick<ToolResultEvent, "toolName" | "content">;
  readonly context: { readonly messages: Parameters<typeof sanitizeContextMessages>[0] };
  readonly session_shutdown: unknown;
};

/** Hook callbacks registered by this provider. */
export type ClaudeHandlers = {
  [K in keyof ClaudeEvents]: (
    event: ClaudeEvents[K],
    ctx: Pick<ExtensionContext, "hasUI"> & {
      readonly ui: Pick<ExtensionContext["ui"], "notify">;
    },
  ) => {
    readonly before_agent_start: undefined;
    readonly tool_call: Pick<ToolCallEventResult, "block" | "reason"> | undefined;
    readonly tool_result: Pick<ToolResultEventResult, "content"> | undefined;
    readonly context: Pick<ContextEventResult, "messages">;
    readonly session_shutdown: Promise<void>;
  }[K];
};

/**
 * Event-bus channel announcing a usage limit with a known reset, for recovery extensions such as
 * pi-auto-resume. The payload is {@link UsageLimitNotice}.
 */
export const USAGE_LIMIT_CHANNEL = "usage-limit";

/** Payload published on {@link USAGE_LIMIT_CHANNEL} before the failed turn ends. */
type UsageLimitNotice = {
  /** Pi provider whose request hit the limit. */
  readonly provider: "claude-sdk";
  /** When the limit resets, in epoch milliseconds. */
  readonly resetsAt: number;
};

/**
 * Publish each observed usage limit on Pi's event bus.
 *
 * @param events - Pi's inter-extension event bus.
 * @returns A runner observer that emits a {@link UsageLimitNotice}.
 */
export function usageLimitPublisher(
  events: Pick<ExtensionAPI["events"], "emit">,
): (limit: UsageLimitObservation) => void {
  return ({ resetsAt }) => {
    const notice: UsageLimitNotice = { provider: "claude-sdk", resetsAt };
    events.emit(USAGE_LIMIT_CHANNEL, notice);
  };
}

/** Pi registration capabilities consumed by the provider. */
export type ClaudeRegistration = Pick<ExtensionAPI, "registerCommand" | "registerTool"> & {
  readonly events: Pick<ExtensionAPI["events"], "emit">;
  readonly registerProvider: (name: string, config: ProviderConfig) => void;
  readonly on: {
    (name: "before_agent_start", handler: ClaudeHandlers["before_agent_start"]): unknown;
    (name: "tool_call", handler: ClaudeHandlers["tool_call"]): unknown;
    (name: "tool_result", handler: ClaudeHandlers["tool_result"]): unknown;
    (name: "context", handler: ClaudeHandlers["context"]): unknown;
    (name: "session_shutdown", handler: ClaudeHandlers["session_shutdown"]): unknown;
  };
};

type CommandServices = ClaudeSdkVersionSources | ClaudeUsageQueries;

const commandLayer: Layer.Layer<CommandServices> = Layer.mergeAll(
  ClaudeSdkVersionSources.layer,
  ClaudeUsageQueries.layer,
);

function registerStatusCommands(
  pi: ClaudeRegistration,
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

function registerSafetyHooks(pi: ClaudeRegistration): void {
  // A section, not a returned systemPrompt: returning one replaces the whole prompt and drops
  // the sections other extensions set in the same event.
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections["bash-output-safety"] =
      "Bash output safety: never cat an executable or print raw binary/base64 data. Use file, otool, or strings for executables, and inspect encoded files via metadata instead of stdout.";
    return undefined;
  });
  pi.on("tool_call", (event) => {
    const recovery = blockValidationRecovery(event.toolName, event.input);
    if (recovery) {
      return recovery;
    }
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

function registerProvider(pi: ClaudeRegistration, runClaudeAgentSdk: AgentSdkRun): void {
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
export default function registerClaudeSdkProvider(pi: ClaudeRegistration): void {
  pi.registerTool(validationRecoveryTool);
  const observedModels = new Map<string, string>();
  const runClaudeAgentSdk = createClaudeAgentSdkRunner({
    validationRecovery: "pi-tool-loop",
    cacheDiagnostics: Effect.runSync(
      cacheDiagnosticsTracker(parseCacheDiagnosticsMode(process.env)),
    ),
    modelObserver: (observation) => {
      observedModels.set(observation.selector, observation.canonicalModel);
    },
    usageLimitObserver: usageLimitPublisher(pi.events),
  });
  const commands = createCommandRunner(commandLayer);
  pi.on("session_shutdown", async () => {
    await commands.dispose();
  });
  registerStatusCommands(pi, observedModels, commands);
  registerSafetyHooks(pi);
  registerProvider(pi, runClaudeAgentSdk);
}
