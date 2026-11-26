import { StringEnum } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-ai";
import type {
  AgentToolUpdateCallback,
  EntryRenderOptions,
  ExtensionContext,
  MessageEndEvent,
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
import { isParallelBatch, isReadOnlyTool } from "./batch.ts";
import type { BatchCall } from "./batch.ts";
import { ClassifyOutcome, classifyRecord } from "./classify.ts";
import type { ClassifierRegistry } from "./classify.ts";
import { groupId, reportFingerprint, signalFingerprint } from "./fingerprint.ts";
import { appendEvent, IMPACTS, KINDS } from "./ledger.ts";
import type { Clock, EventDraft, LedgerEvent, RecordEvent } from "./ledger.ts";
import { createAttribution } from "./owner.ts";
import type { Attribution, CommandSource, ToolSource } from "./owner.ts";

export const FEEDBACK_TOOL = "harness_feedback";
export const FEEDBACK_NOTE_TYPE = "feedback-report";
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
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: FeedbackDetails;
  readonly isError?: boolean;
};

export type FeedbackContext = {
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  readonly model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> | undefined;
  readonly modelRegistry: ClassifierRegistry;
};

export type FeedbackCommandContext = {
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
};

export type FeedbackTool = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: Array<string>;
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
    onUpdate: AgentToolUpdateCallback<FeedbackDetails> | undefined,
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
  options: EntryRenderOptions,
  theme: Pick<Theme, "fg">,
) => Component | undefined;

export type FeedbackRegistration = {
  readonly registerTool: (tool: FeedbackTool) => void;
  readonly registerEntryRenderer: (customType: string, renderer: NoteRenderer) => void;
  readonly registerCommand: (name: string, options: OnOffCommand<FeedbackCommandContext>) => void;
  readonly on: {
    (
      name: "tool_execution_end",
      handler: (event: ToolExecutionEndEvent, ctx: FeedbackContext) => Promise<void>,
    ): void;
    (name: "message_end", handler: (event: Pick<MessageEndEvent, "message">) => void): void;
  };
  readonly appendEntry: (customType: string, data: FeedbackNote) => void;
  readonly getAllTools: () => ReadonlyArray<ToolSource>;
  readonly getCommands: () => ReadonlyArray<CommandSource>;
  readonly getActiveTools: () => Array<string>;
  readonly setActiveTools: (names: Array<string>) => void;
};

export type FeedbackDependencies = {
  readonly ledger: string;
  readonly packagesDir: string;
  readonly ownPackages: ReadonlyArray<string>;
  readonly agentDir: string;
  readonly home: string;
  readonly piVersion: string;
  readonly clock?: Clock;
  readonly schedule?: (task: () => Promise<void>) => void;
};

function serialQueue(): (task: () => Promise<void>) => void {
  let tail: Promise<void> = Promise.resolve();

  return (task) => {
    tail = tail.then(task, task);
  };
}

function isRecordEvent(event: LedgerEvent): event is RecordEvent {
  return event.type === "report" || event.type === "signal";
}

const decodeNote = Schema.decodeUnknownOption(
  Schema.Struct({ group: Schema.String, owner: Schema.String, summary: Schema.String }),
);

function result(text: string, details: FeedbackDetails, isError = false): FeedbackResult {
  const response: Omit<FeedbackResult, "isError"> & { isError?: boolean } = {
    content: [{ type: "text", text }],
    details,
  };

  if (isError) {
    response.isError = isError;
  }

  return response;
}

const isTextPart = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));

const decodeToolResult = Schema.decodeUnknownOption(
  Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
);

export function errorText(toolResult: unknown): string {
  const decoded = decodeToolResult(toolResult);

  return Option.isSome(decoded)
    ? decoded.value.content.flatMap((part) => (isTextPart(part) ? [part.text] : [])).join("\n")
    : "";
}

function recordProvenance(ctx: FeedbackContext, piVersion: string, attribution: Attribution) {
  type RecordEvidence = { evidence?: NonNullable<Attribution["evidence"]> };

  const evidence: RecordEvidence = {};

  if (attribution.evidence !== undefined) {
    evidence.evidence = attribution.evidence;
  }

  const provenance: typeof evidence & { piVersion: string; model?: string } = {
    ...evidence,
    piVersion,
  };

  if (ctx.model !== undefined) {
    provenance.model = `${ctx.model.provider}/${ctx.model.id}`;
  }

  return provenance;
}

function reportDraft(
  ctx: FeedbackContext,
  piVersion: string,
  params: FeedbackParams,
  record: Pick<RecordEvent, "session" | "fingerprint"> & { attribution: Attribution },
): EventDraft {
  type ReportDraft = Extract<EventDraft, { type: "report" }>;

  const report: Omit<ReportDraft, "workaround" | "impact"> & { workaround?: string } = {
    type: "report",
    session: record.session,
    owner: record.attribution.owner,
    fingerprint: record.fingerprint,
    kind: params.kind,
    component: params.component,
    summary: params.summary,
    expected: params.expected,
    actual: params.actual,
  };

  if (params.workaround !== undefined) {
    report.workaround = params.workaround;
  }

  return {
    ...report,
    impact: params.impact,
    ...recordProvenance(ctx, piVersion, record.attribution),
  };
}

function signalDraft(
  ctx: FeedbackContext,
  piVersion: string,
  attribution: Attribution,
  failure: { tool: string; error: string; ordered: boolean },
): EventDraft {
  type SignalDraft = Extract<EventDraft, { type: "signal" }>;

  const { tool, error, ordered } = failure;

  const signal: Omit<SignalDraft, "cause"> & { cause?: NonNullable<SignalDraft["cause"]> } = {
    type: "signal",
    session: ctx.sessionManager.getSessionId(),
    owner: attribution.owner,
    fingerprint: signalFingerprint(tool, error),
    tool,
    error,
  };

  if (ordered) {
    signal.cause = "parallel-batch";
  }

  return { ...signal, ...recordProvenance(ctx, piVersion, attribution) };
}

function toolCallsOf(message: MessageEndEvent["message"]): ReadonlyArray<BatchCall> | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }

  return message.content.flatMap((part) =>
    part.type === "toolCall" ? [{ id: part.id, name: part.name, args: part.arguments }] : [],
  );
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
  const schedule = dependencies.schedule ?? serialQueue();
  let unclassified = 0;

  const classifyLater = (ctx: FeedbackContext, event: LedgerEvent, input?: JsonObject): void => {
    if (!isRecordEvent(event)) {
      return;
    }

    const registry = ctx.modelRegistry;
    schedule(async () => {
      try {
        const outcome = await classifyRecord({ registry, ledger, record: event, input, clock });
        unclassified += ClassifyOutcome.$is("classified")(outcome) ? outcome.failed : 0;
      } catch {
        unclassified += 1;
      }
    });
  };

  const owners = createAttribution(pi, dependencies);
  const readOnly = (name: string): boolean => isReadOnlyTool(owners.toolNamed(name));
  let batch: ReadonlyArray<BatchCall> = [];
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

    const attribution = owners.forReport(params.component, params.actual);
    const { owner } = attribution;
    filed.add(key);

    try {
      const event = await appendEvent(
        ledger,
        reportDraft(ctx, piVersion, params, { session, fingerprint, attribution }),
        clock,
      );

      classifyLater(ctx, event);
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

  pi.on("message_end", (event) => {
    batch = toolCallsOf(event.message) ?? batch;
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!enabled || !event.isError || event.toolName === FEEDBACK_TOOL) {
      return;
    }

    const error = errorText(event.result);
    const attribution = owners.forSignal(event.toolName, error);
    const failing = batch.find((call) => call.id === event.toolCallId);
    const ordered = failing !== undefined && isParallelBatch(failing, error, batch, readOnly);

    try {
      const recorded = await appendEvent(
        ledger,
        signalDraft(ctx, piVersion, attribution, { tool: event.toolName, error, ordered }),
        clock,
      );

      classifyLater(ctx, recorded, failing?.args);
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
        ` Ledger: ${ledger}.${unwritten > 0 ? ` ${unwritten} tool errors could not be written to it.` : ""}${unclassified > 0 ? ` ${unclassified} classifier calls failed.` : ""}`,
    }),
  );
}
