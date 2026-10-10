import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit, Result } from "effect";
import { createAgentSdkStream } from "./bridge";
import type { AgentSdkRun } from "./bridge";
import { cacheDiagnosticsFromEnvironment } from "./cache-diagnostics";
import { formatModelStatus, models, providerModel } from "./models";
import { inspectBashCommand, sanitizeBashContent, sanitizeContextMessages } from "./output-safety";
import { formatClaudeUsageStatus, inspectClaudeUsage } from "./sdk-usage";
import { formatClaudeSdkVersionStatus, inspectClaudeSdkVersions } from "./sdk-version-status";
import { createClaudeAgentSdkRunner } from "./sdk/runner";

// Command boundary: expected failures become a Result to render; defects rethrow unchanged.
async function runCommand<A, E extends Error>(
  program: Effect.Effect<A, E>,
): Promise<Result.Result<A, E>> {
  const exit = await Effect.runPromiseExit(program);
  if (Exit.isSuccess(exit)) {
    return Result.succeed(exit.value);
  }
  const failure = Cause.findError(exit.cause);
  if (Result.isSuccess(failure)) {
    return Result.fail(failure.success);
  }
  throw Cause.squash(exit.cause);
}

function registerStatusCommands(
  pi: ExtensionAPI,
  observedModels: ReadonlyMap<string, string>,
): void {
  pi.registerCommand("claude-sdk-status", {
    description: "Show Agent SDK versions and observed model mappings",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      const result = await runCommand(inspectClaudeSdkVersions());
      if (Result.isFailure(result)) {
        ctx.ui.notify(result.failure.message, "error");
        return;
      }
      ctx.ui.notify(
        `${formatClaudeSdkVersionStatus(result.success)}\n\n${formatModelStatus(observedModels)}`,
        result.success.updateSuggested ? "warning" : "info",
      );
    },
  });
  pi.registerCommand("claude-sdk-usage", {
    description: "Show remaining Claude subscription usage",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }
      const result = await runCommand(inspectClaudeUsage());
      if (Result.isFailure(result)) {
        ctx.ui.notify(result.failure.message, "error");
        return;
      }
      ctx.ui.notify(formatClaudeUsageStatus(result.success), "info");
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
    cacheDiagnostics: cacheDiagnosticsFromEnvironment(),
    modelObserver: (observation) => {
      observedModels.set(observation.selector, observation.canonicalModel);
    },
  });
  registerStatusCommands(pi, observedModels);
  registerSafetyHooks(pi);
  registerProvider(pi, runClaudeAgentSdk);
}
