import process from "node:process";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type {
  MessageEndEvent,
  MessageEndEventResult,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  RegisteredCommand,
  SessionShutdownEvent,
  ToolResultEvent,
  ProviderConfig,
  ToolCallEventResult,
  ToolResultEventResult,
  ContextEvent,
  ContextEventResult,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Option } from "effect";
import { USAGE_LIMIT_CHANNEL } from "../shared/usage-limit";
import type { UsageLimitNotice } from "../shared/usage-limit";
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
import {
  blockValidationRecovery,
  decodeValidationInput,
  normalizeValidationResult,
  validationRecoveryTool,
  VALIDATION_ERROR_TOOL,
} from "./validation-recovery";

export type ClaudeEvents = {
  readonly before_agent_start: {
    readonly systemPromptOptions: { readonly sections: Record<string, string> };
  };
  readonly message_end: Pick<MessageEndEvent, "message">;
  readonly tool_call: ToolCallEvent;
  readonly tool_result: Pick<ToolResultEvent, "toolName" | "content">;
  readonly context: { readonly messages: ContextEvent["messages"] };
  readonly session_shutdown: SessionShutdownEvent;
};

export type ClaudeContext = Pick<ExtensionContext, "hasUI"> & {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
};

export type ClaudeHandlers = {
  [K in keyof ClaudeEvents]: (
    event: ClaudeEvents[K],
    ctx: ClaudeContext & {
      readonly sessionManager?: Pick<ExtensionContext["sessionManager"], "getBranch">;
    },
  ) => {
    readonly before_agent_start: undefined;
    readonly message_end: MessageEndEventResult | undefined;
    readonly tool_call: Pick<ToolCallEventResult, "block" | "reason"> | undefined;
    readonly tool_result: Pick<ToolResultEventResult, "content"> | undefined;
    readonly context: Pick<ContextEventResult, "messages">;
    readonly session_shutdown: Promise<void>;
  }[K];
};

export function usageLimitPublisher(
  events: Pick<ExtensionAPI["events"], "emit">,
): (limit: UsageLimitObservation) => void {
  return ({ resetsAt }) => {
    const notice: UsageLimitNotice = { provider: "claude", resetsAt };
    events.emit(USAGE_LIMIT_CHANNEL, notice);
  };
}

export type ClaudeRegistration = Pick<ExtensionAPI, "registerTool"> & {
  readonly events: Pick<ExtensionAPI["events"], "emit">;
  readonly registerCommand: (
    name: string,
    options: Pick<RegisteredCommand, "description" | "getArgumentCompletions"> & {
      readonly handler: (args: string, ctx: ClaudeContext) => Promise<void>;
    },
  ) => void;
  readonly registerProvider: (name: string, config: ProviderConfig) => void;
  readonly on: {
    (name: "before_agent_start", handler: ClaudeHandlers["before_agent_start"]): void;
    (name: "message_end", handler: ClaudeHandlers["message_end"]): void;
    (name: "tool_call", handler: ClaudeHandlers["tool_call"]): void;
    (name: "tool_result", handler: ClaudeHandlers["tool_result"]): void;
    (name: "context", handler: ClaudeHandlers["context"]): void;
    (name: "session_shutdown", handler: ClaudeHandlers["session_shutdown"]): void;
  };
};

type CommandServices = ClaudeSdkVersionSources | ClaudeUsageQueries;

const commandLayer: Layer.Layer<CommandServices> = Layer.mergeAll(
  ClaudeSdkVersionSources.layer,
  ClaudeUsageQueries.layer,
);

const CLAUDE_ACTIONS = ["status", "usage"] as const;

function isClaudeAction(value: string): value is (typeof CLAUDE_ACTIONS)[number] {
  return CLAUDE_ACTIONS.some((action) => action === value);
}

function registerClaudeCommand(
  pi: ClaudeRegistration,
  observedModels: ReadonlyMap<string, string>,
  commands: CommandRunner<CommandServices>,
): void {
  pi.registerCommand("claude", {
    description:
      "Show Agent SDK versions and observed model mappings (status, the default) or remaining Claude subscription usage (usage)",
    getArgumentCompletions: (prefix) =>
      CLAUDE_ACTIONS.filter((action) => action.startsWith(prefix)).map((value) => ({
        value,
        label: value,
      })),
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      const action = args.trim() === "" ? "status" : args.trim();
      if (!isClaudeAction(action)) {
        ctx.ui.notify("Usage: /claude [status|usage]", "warning");
        return;
      }
      const notice =
        action === "status"
          ? await commands.report(inspectClaudeSdkVersions(), (status) => ({
              text: `${formatClaudeSdkVersionStatus(status)}\n\n${formatModelStatus(observedModels)}`,
              level: status.updateSuggested || status.belowMinimum ? "warning" : "info",
            }))
          : await commands.report(inspectClaudeUsage(), (status) => ({
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
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections["bash-output-safety"] =
      "Bash output safety: never cat an executable or print raw binary/base64 data. Use file, otool, or strings for executables, and inspect encoded files via metadata instead of stdout.";
    event.systemPromptOptions.sections["claude-scratchpad"] =
      "Claude SDK queries are stateless: native session IDs and suggested scratchpad directories change each turn. Pi owns conversation continuity. Reuse scratch files explicitly recorded in this Pi conversation; a changed native session ID does not make earlier files foreign. Do not move or delete scratch directories just to match a new SDK session ID.";
    return undefined;
  });
  pi.on("message_end", (event, ctx) => {
    const { message } = event;
    if (
      message.role !== "toolResult" ||
      message.toolName !== VALIDATION_ERROR_TOOL ||
      !message.isError
    ) {
      return undefined;
    }
    return normalizeValidationResult(
      message,
      ctx.sessionManager
        ?.getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])) ?? [],
    );
  });
  pi.on("tool_call", (event) => {
    const recovery =
      event.toolName === VALIDATION_ERROR_TOOL
        ? blockValidationRecovery(
            event.toolName,
            Option.getOrUndefined(decodeValidationInput(event.input)),
          )
        : undefined;
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
        `Quarantined ${sanitized.detected}-like bash output; it was kept out of the context.`,
        "warning",
      );
    }
    return { content: sanitized.content };
  });
  pi.on("context", (event) => ({ messages: sanitizeContextMessages(event.messages) }));
}

function registerProvider(pi: ClaudeRegistration, runClaudeAgentSdk: AgentSdkRun): void {
  pi.registerProvider("claude", {
    name: "Claude subscription via official Agent SDK",
    baseUrl: "agent-sdk://local-claude-code",
    apiKey: "claude-managed-auth",
    api: "claude",
    models: models.map((model) => providerModel(model)),
    streamSimple: (model, context, options) =>
      createAgentSdkStream({ model, context, options, run: runClaudeAgentSdk }),
  });
}

export default function registerClaudeProvider(pi: ClaudeRegistration): void {
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
  registerClaudeCommand(pi, observedModels, commands);
  registerSafetyHooks(pi);
  registerProvider(pi, runClaudeAgentSdk);
}
