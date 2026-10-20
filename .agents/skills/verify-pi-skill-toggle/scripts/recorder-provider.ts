/**
 * Offline recorder provider for the verify-pi-skill-toggle skill's model journeys.
 *
 * Registers `recorder/codex-like` (mid-conversation system messages supported) and
 * `recorder/collapse-like` (not supported). Every request's full TranscriptContext and
 * session id is appended as one JSONL line to `$PI_SKILL_TOGGLE_RECORDER_FILE`. The reply is
 * canned text, or the tool calls a prompt scripts (see `scriptedCalls`). No network access.
 */
import { appendFileSync } from "node:fs";
import { env } from "node:process";

// Pi's extension alias resolves pi-ai to its compat entry, which does not export
// createAssistantMessageEventStream, so a minimal async-iterable stream is used instead.
class RecorderStream<E, R> implements AsyncIterable<E> {
  private readonly events: E[] = [];
  private readonly waiters: ((value: IteratorResult<E>) => void)[] = [];
  private finished = false;
  private resolveResult!: (value: R) => void;
  private readonly final = new Promise<R>((resolve) => {
    this.resolveResult = resolve;
  });

  push(event: E): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.events.push(event);
    }
  }

  end(result: R): void {
    this.finished = true;
    this.resolveResult(result);
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async result(): Promise<R> {
    return this.final;
  }

  [Symbol.asyncIterator](): AsyncIterator<E> {
    return {
      next: async () => {
        const event = this.events.shift();
        if (event !== undefined) {
          return { value: event, done: false };
        }
        if (this.finished) {
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<E>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

const API = "skill-toggle-recorder";
const READ_FILES = "READ-FILES: ";
const RUN_BASH = "RUN-BASH: ";
const SPAWN_CHILD = "SPAWN-CHILD";

type RecorderMessage = { readonly role: string; readonly content?: unknown };
type ScriptedCall = { readonly name: string; readonly arguments: Record<string, unknown> };

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block: unknown) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("\n");
}

/** The rest of each line after a marker, wherever the marker appears in the line. */
function markedLines(text: string, marker: string): string[] {
  return text.split("\n").flatMap((line) => {
    const at = line.indexOf(marker);
    return at === -1 ? [] : [line.slice(at + marker.length).trim()];
  });
}

function fileAndShellCalls(text: string): ScriptedCall[] {
  return [
    ...markedLines(text, READ_FILES).flatMap((line) =>
      line
        .split("|")
        .filter(Boolean)
        .map((path) => ({ name: "read", arguments: { path } })),
    ),
    ...markedLines(text, RUN_BASH).map((command) => ({ name: "bash", arguments: { command } })),
  ];
}

/**
 * Tool calls the recorder makes for the pending user prompt, or none for a plain reply.
 *
 * - A `SPAWN-CHILD` line calls the `subagent` tool; every line after it becomes the child's task.
 * - Otherwise each `READ-FILES: a|b` line reads each path, and each `RUN-BASH: cmd` line runs it.
 */
function scriptedCalls(messages: readonly RecorderMessage[]): readonly ScriptedCall[] {
  let lastAssistant = -1;
  for (const [position, { role }] of messages.entries()) {
    if (role === "assistant") {
      lastAssistant = position;
    }
  }
  const pending = messages.slice(lastAssistant + 1);
  if (pending.some(({ role }) => role === "toolResult")) {
    return [];
  }
  const text = pending
    .filter(({ role }) => role === "user")
    .map(({ content }) => textOf(content))
    .join("\n");
  const spawn = text.indexOf(SPAWN_CHILD);
  if (spawn === -1) {
    return fileAndShellCalls(text);
  }
  const task = text.slice(spawn + SPAWN_CHILD.length).trim();
  return [
    {
      name: "subagent",
      arguments: {
        prompt: task,
        description: "verify child reads",
        subagent_type: "general-purpose",
      },
    },
  ];
}
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function recorderModel(id: string, name: string, midConvo: boolean) {
  return {
    id,
    name,
    api: API,
    reasoning: false,
    input: ["text" as const],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 8192,
    ...(midConvo ? { compat: { supportsMidConvoSystemMessages: true } } : {}),
  };
}

type RecorderModel = {
  readonly id: string;
  readonly api: string;
  readonly provider: string;
  readonly compat?: unknown;
};
type RecorderOptions = {
  readonly onPayload?: (payload: unknown, model: RecorderModel) => unknown;
  readonly sessionId?: string;
};
type RecorderApi = {
  readonly registerProvider: (name: string, config: unknown) => void;
};

export default function registerRecorder(pi: RecorderApi): void {
  let requests = 0;
  pi.registerProvider("recorder", {
    name: "Offline prompt recorder",
    baseUrl: "recorder://offline",
    apiKey: "recorder-offline",
    api: API,
    models: [
      recorderModel("codex-like", "Recorder (mid-convo system messages)", true),
      recorderModel("collapse-like", "Recorder (collapsed system prompt)", false),
    ],
    streamSimple: (
      model: RecorderModel,
      context: { readonly messages: readonly RecorderMessage[] },
      options?: RecorderOptions,
    ) => {
      const stream = new RecorderStream<unknown, unknown>();
      requests += 1;
      const index = requests;
      void (async () => {
        let payload: unknown = {
          index,
          at: Date.now(),
          model: model.id,
          sessionId: options?.sessionId ?? null,
          compat: model.compat ?? null,
          messages: context.messages,
        };
        const replaced: unknown = await options?.onPayload?.(payload, model);
        if (replaced !== undefined) {
          payload = replaced;
        }
        const file = env.PI_SKILL_TOGGLE_RECORDER_FILE;
        if (file !== undefined && file !== "") {
          appendFileSync(file, `${JSON.stringify(payload)}\n`);
        }
        const calls = scriptedCalls(context.messages);
        const text = `Recorded request ${index}.`;
        const input = Math.ceil(JSON.stringify(context.messages).length / 4);
        const toolCalls = calls.map((call, position) => ({
          type: "toolCall",
          id: `call-${index}-${position}`,
          name: call.name,
          arguments: call.arguments,
        }));
        const message = {
          role: "assistant",
          content: toolCalls.length > 0 ? toolCalls : [{ type: "text", text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input,
            output: 6,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: input + 6,
            cost: { ...ZERO_COST, total: 0 },
          },
          stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        const partial = { ...message, content: [], stopReason: "pending" };
        stream.push({ type: "start", partial });
        if (toolCalls.length > 0) {
          for (const [contentIndex, toolCall] of toolCalls.entries()) {
            const sofar = { ...partial, content: toolCalls.slice(0, contentIndex + 1) };
            stream.push({ type: "toolcall_start", contentIndex, partial: sofar });
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: sofar });
          }
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
          return;
        }
        const done = { ...partial, content: [{ type: "text", text }] };
        stream.push({ type: "text_start", contentIndex: 0, partial: done });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: done });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: done });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      })();
      return stream;
    },
  });
}
