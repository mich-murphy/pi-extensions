import { isAbsolute, relative, sep } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  Theme,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Option, Schema } from "effect";
import { Type } from "typebox";
import type { Static } from "typebox";
import { onOffCommand } from "../shared/on-off-command.ts";
import type { OnOffCommand } from "../shared/on-off-command.ts";
import { groupId, reportFingerprint, signalFingerprint } from "./fingerprint.ts";
import { appendEvent, IMPACTS, KINDS } from "./ledger.ts";
import type { Clock } from "./ledger.ts";

export const FEEDBACK_TOOL = "harness_feedback";
export const FEEDBACK_NOTE_TYPE = "feedback-report";
const UNATTRIBUTED = "unattributed";
export const REPORTS_PER_SESSION = 5;

const SHORT_TEXT = 200;
const LONG_TEXT = 1000;

const FEEDBACK_PARAMETERS = Type.Object({
  kind: StringEnum(KINDS, { description: "What went wrong." }),
  component: Type.String({
    minLength: 1,
    maxLength: SHORT_TEXT,
    description:
      "The tool, extension, skill or instruction file involved, such as edit, pi-claude or AGENTS.md.",
  }),
  summary: Type.String({ minLength: 1, maxLength: SHORT_TEXT, description: "One line." }),
  expected: Type.String({ maxLength: LONG_TEXT, description: "What you expected to happen." }),
  actual: Type.String({
    minLength: 1,
    maxLength: LONG_TEXT,
    description: "What actually happened: the error, output or behaviour you saw.",
  }),
  workaround: Type.Optional(
    Type.String({ maxLength: LONG_TEXT, description: "What you did instead, if anything." }),
  ),
  impact: StringEnum(IMPACTS, { description: "Whether it stopped the task or only slowed it." }),
});

export type FeedbackParams = Static<typeof FEEDBACK_PARAMETERS>;

export type FeedbackDetails =
  | { readonly status: "recorded"; readonly group: string; readonly owner: string }
  | { readonly status: "duplicate" | "limit" | "off" | "failed" };

export type FeedbackResult = {
  readonly content: { readonly type: "text"; readonly text: string }[];
  readonly details: FeedbackDetails;
  readonly isError?: boolean;
};

export type FeedbackContext = {
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  readonly model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> | undefined;
};

export type FeedbackCommandContext = {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
};

export type FeedbackTool = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: string[];
  readonly parameters: typeof FEEDBACK_PARAMETERS;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  readonly execute: (
    toolCallId: string,
    params: FeedbackParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: FeedbackContext,
  ) => Promise<FeedbackResult>;
};

export type FeedbackNote = {
  readonly group: string;
  readonly owner: string;
  readonly summary: string;
};

export type NoteRenderer = (
  entry: { readonly data?: unknown },
  options: unknown,
  theme: Pick<Theme, "fg">,
) => Component | undefined;

export type ToolSource = { readonly name: string; readonly sourceInfo: { readonly path: string } };

export type FeedbackRegistration = {
  readonly registerTool: (tool: FeedbackTool) => void;
  readonly registerEntryRenderer: (customType: string, renderer: NoteRenderer) => void;
  readonly registerCommand: (name: string, options: OnOffCommand<FeedbackCommandContext>) => void;
  readonly on: (
    name: "tool_execution_end",
    handler: (event: ToolExecutionEndEvent, ctx: FeedbackContext) => Promise<void>,
  ) => unknown;
  readonly appendEntry: (customType: string, data: FeedbackNote) => void;
  readonly getAllTools: () => readonly ToolSource[];
  readonly getActiveTools: () => string[];
  readonly setActiveTools: (names: string[]) => void;
};

export type FeedbackDependencies = {
  readonly ledger: string;
  readonly packagesDir: string;
  readonly ownPackages: readonly string[];
  readonly piVersion: string;
  readonly clock?: Clock;
};

const decodeNote = Schema.decodeUnknownOption(
  Schema.Struct({ group: Schema.String, owner: Schema.String, summary: Schema.String }),
);

function result(text: string, details: FeedbackDetails, isError = false): FeedbackResult {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError } : {}) };
}

function isTextPart(part: unknown): part is { readonly type: "text"; readonly text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

export function errorText(toolResult: unknown): string {
  if (
    typeof toolResult !== "object" ||
    toolResult === null ||
    !("content" in toolResult) ||
    !Array.isArray(toolResult.content)
  ) {
    return "";
  }
  const parts: unknown[] = toolResult.content;
  return parts
    .filter((part) => isTextPart(part))
    .map((part) => part.text)
    .join("\n");
}

function runContext(ctx: FeedbackContext, piVersion: string) {
  return {
    piVersion,
    ...(ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` }),
  };
}

function createOwners(pi: FeedbackRegistration, dependencies: FeedbackDependencies) {
  const own: ReadonlySet<string> = new Set(dependencies.ownPackages);

  const packageAt = (path: string): string | undefined => {
    if (!isAbsolute(path)) {
      return undefined;
    }
    const inside = relative(dependencies.packagesDir, path);
    const name = inside.split(sep)[0] ?? "";
    return inside.startsWith("..") || isAbsolute(inside) || !own.has(name) ? undefined : name;
  };

  const toolOwner = (toolName: string): string => {
    const tool = pi.getAllTools().find((candidate) => candidate.name === toolName);
    return (tool === undefined ? undefined : packageAt(tool.sourceInfo.path)) ?? UNATTRIBUTED;
  };

  const reportOwner = (component: string): string => {
    const trimmed = component.trim();
    const first = trimmed.toLowerCase().split(/[\s/:]+/u)[0] ?? "";
    return own.has(first) ? first : toolOwner(trimmed);
  };

  return { toolOwner, reportOwner };
}

function renderNote(note: FeedbackNote, theme: Pick<Theme, "fg">): Component {
  return new Text(
    `${theme.fg("accent", "Harness feedback filed")} ${theme.fg("muted", `(${note.owner}, ${note.group})`)} ${note.summary}`,
    1,
    0,
  );
}

export function registerFeedback(
  pi: FeedbackRegistration,
  dependencies: FeedbackDependencies,
): void {
  const { ledger, piVersion, clock } = dependencies;
  const owners = createOwners(pi, dependencies);
  const filedBySession = new Map<string, Set<string>>();
  let enabled = true;
  let unwritten = 0;

  const record = async (ctx: FeedbackContext, params: FeedbackParams): Promise<FeedbackResult> => {
    const session = ctx.sessionManager.getSessionId();
    const fingerprint = reportFingerprint(params.component, params.kind);
    const key = `${fingerprint}\n${params.summary.trim().toLowerCase()}`;
    const filed = filedBySession.get(session) ?? new Set<string>();
    filedBySession.set(session, filed);
    if (filed.has(key)) {
      return result("Already recorded in this session; nothing new was written.", {
        status: "duplicate",
      });
    }
    if (filed.size >= REPORTS_PER_SESSION) {
      return result(
        `This session has already filed ${REPORTS_PER_SESSION} reports; nothing was recorded.`,
        { status: "limit" },
      );
    }
    const owner = owners.reportOwner(params.component);
    filed.add(key);
    try {
      const event = await appendEvent(
        ledger,
        {
          type: "report",
          session,
          owner,
          fingerprint,
          kind: params.kind,
          component: params.component,
          summary: params.summary,
          expected: params.expected,
          actual: params.actual,
          ...(params.workaround === undefined ? {} : { workaround: params.workaround }),
          impact: params.impact,
          ...runContext(ctx, piVersion),
        },
        clock,
      );
      const group = groupId(owner, fingerprint);
      pi.appendEntry(FEEDBACK_NOTE_TYPE, {
        group,
        owner,
        summary: event.type === "report" ? event.summary : params.summary,
      });
      return result(`Recorded in group ${group} (owner ${owner}). Carry on with the task.`, {
        status: "recorded",
        group,
        owner,
      });
    } catch (error) {
      filed.delete(key);
      const reason = error instanceof Error ? error.message : String(error);
      return result(`Could not record the feedback: ${reason}`, { status: "failed" }, true);
    }
  };

  pi.registerTool({
    name: FEEDBACK_TOOL,
    label: "Harness feedback",
    description:
      "Record friction with the agent harness: a Pi tool, extension, skill or instruction that failed, misled you or was missing. Not for bugs in the user's project.",
    promptSnippet: "Report friction with Pi's tools, extensions, skills or instructions",
    promptGuidelines: [
      "Call harness_feedback when a Pi tool, extension, skill or instruction gets in your way, even if you found a workaround, then carry on with the task.",
      "Do not use harness_feedback for bugs in the user's project or failures of outside services.",
    ],
    parameters: FEEDBACK_PARAMETERS,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      enabled
        ? record(ctx, params)
        : result("Harness feedback is off for this session; nothing was recorded.", {
            status: "off",
          }),
  });

  pi.registerEntryRenderer(FEEDBACK_NOTE_TYPE, (entry, _options, theme) => {
    const note = Option.getOrUndefined(decodeNote(entry.data));
    return note === undefined ? undefined : renderNote(note, theme);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!enabled || !event.isError || event.toolName === FEEDBACK_TOOL) {
      return;
    }
    const error = errorText(event.result);
    try {
      await appendEvent(
        ledger,
        {
          type: "signal",
          session: ctx.sessionManager.getSessionId(),
          owner: owners.toolOwner(event.toolName),
          fingerprint: signalFingerprint(event.toolName, error),
          tool: event.toolName,
          error,
          ...runContext(ctx, piVersion),
        },
        clock,
      );
    } catch {
      unwritten += 1;
    }
  });

  pi.registerCommand(
    "feedback",
    onOffCommand<FeedbackCommandContext>({
      name: "feedback",
      label: "Harness feedback",
      description: "Turn harness feedback recording on or off for this session",
      enabled: () => enabled,
      apply: (next) => {
        enabled = next;
        const active = pi.getActiveTools().filter((name) => name !== FEEDBACK_TOOL);
        pi.setActiveTools(next ? [...active, FEEDBACK_TOOL] : active);
      },
      note: () =>
        ` Ledger: ${ledger}.${unwritten > 0 ? ` ${unwritten} tool errors could not be written to it.` : ""}`,
    }),
  );
}
