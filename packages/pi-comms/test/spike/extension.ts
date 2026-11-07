import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function requiredEnvironment(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error("Spike requires isolated log and socket paths");
  }
  return value;
}
function noticeMatches(details: unknown, noticeId: string | undefined): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    "noticeId" in details &&
    details.noticeId === noticeId
  );
}
function onAbort(signal: AbortSignal | undefined, action: () => void): void {
  if (signal?.aborted === true) {
    action();
  } else {
    signal?.addEventListener("abort", action, { once: true });
  }
}
function responseSignal(options: SimpleStreamOptions | undefined): AbortSignal | undefined {
  return options?.signal;
}
function responseAborted(options: SimpleStreamOptions | undefined): boolean {
  return responseSignal(options)?.aborted === true;
}
function responseFailure(selected: string): boolean {
  return ["error", "retry-once", "overflow-once", "compact-fail"].includes(selected);
}
function responseStop(aborted: boolean, failure: boolean): AssistantMessage["stopReason"] {
  if (aborted) {
    return "aborted";
  }
  return failure ? "error" : "stop";
}
function responseError(selected: string): string {
  const errors: Record<string, string> = {
    "retry-once": "529 overloaded",
    "overflow-once": "prompt is too long",
  };
  return errors[selected] ?? "synthetic offline failure";
}
function responseContent(
  index: number,
  take: boolean,
  failed: boolean,
): AssistantMessage["content"] {
  if (failed) {
    return [];
  }
  if (take) {
    return [{ type: "toolCall", id: `take-${index}`, name: "spike_take", arguments: {} }];
  }
  return [{ type: "text", text: `Offline scheduling response ${index}` }];
}
function responseMessage(
  model: Model<Api>,
  index: number,
  selected: string,
  aborted: boolean,
  take: boolean,
): AssistantMessage {
  const failure = responseFailure(selected);
  const failed = failure || aborted;
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: responseContent(index, take, failed),
    stopReason: take ? "toolUse" : responseStop(aborted, failure),
    ...(failed ? { errorMessage: responseError(selected) } : {}),
    timestamp: Date.now(),
    usage: {
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
async function recordPayload(
  options: SimpleStreamOptions | undefined,
  payload: unknown,
  model: Model<Api>,
) {
  return options?.onPayload?.(payload, model);
}

type Control = { op: string; id?: string; content?: string; mode?: string; filter?: boolean };

/** Test-only local control surface. No transport/protocol implementation. */
// eslint-disable-next-line import/no-default-export -- Pi loads a fixture extension's default export.
export default function spike(pi: ExtensionAPI): void {
  const nonce = randomBytes(16).toString("hex");
  const file = requiredEnvironment("PI_SPIKE_LOG");
  const socketPath = requiredEnvironment("PI_SPIKE_SOCKET");
  const log = (type: string, data: unknown = {}) => {
    appendFileSync(file, `${JSON.stringify({ type, nonce, data })}\n`);
  };
  let context: ExtensionContext | undefined;
  let mode = "success";
  let filter = false;
  let settlePush = false;
  let holdSettled = false;
  let releaseSettled: (() => void) | undefined;
  let release: (() => void) | undefined;
  let request = 0;
  let inboxDelivery = false;
  let wakeNeeded = false;
  let idleNoticeInFlight: string | undefined;
  let noticeSequence = 0;
  const inbox = new Map<string, string>();
  const receipts = new Map<string, string>();
  const outstanding = new Map<string, number>();
  const state = () => ({
    nonce,
    receipts: receipts.size,
    outstanding: [...outstanding.keys()],
    bytes: [...outstanding.values()].reduce((sum, bytes) => sum + bytes, 0),
    idle: context?.isIdle(),
    idleNoticeInFlight,
    pending: context?.hasPendingMessages(),
  });
  const pumpIdleNotice = () => {
    if (!wakeNeeded || context?.isIdle() !== true || idleNoticeInFlight !== undefined) {
      return;
    }
    wakeNeeded = false;
    noticeSequence += 1;
    idleNoticeInFlight = `notice-${noticeSequence}`;
    pi.sendMessage(
      {
        customType: "spike-notice",
        content: "INBOX_NOTICE: call spike_take",
        display: false,
        details: { noticeId: idleNoticeInFlight },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    log("notice_submitted", { source: "idle", noticeId: idleNoticeInFlight });
  };
  const deferredChecks = new Set<ReturnType<typeof setImmediate>>();
  const checkIdleAfterHook = () => {
    if (deferredChecks.size > 0) {
      return;
    }
    const handle = setImmediate(() => {
      deferredChecks.delete(handle);
      // One check, not a polling loop. Active agent runs use before_settle instead.
      pumpIdleNotice();
    });
    deferredChecks.add(handle);
  };
  const hasCapacity = (bytes: number) =>
    outstanding.size < 4 && state().bytes + bytes <= 4096 && receipts.size < 32;
  const duplicate = (existing: string, content: string) => ({
    tag: existing === content ? "duplicate_admitted" : "id_conflict",
    ...state(),
  });
  const admit = (id: string, content: string) => {
    if (context === undefined) {
      return { tag: "unavailable", ...state() };
    }
    const existing = receipts.get(id);
    if (existing !== undefined) {
      return duplicate(existing, content);
    }
    const bytes = Buffer.byteLength(content);
    if (!hasCapacity(bytes)) {
      return { tag: "overloaded", ...state() };
    }
    receipts.set(id, content);
    outstanding.set(id, bytes);
    if (inboxDelivery) {
      inbox.set(id, content);
      // Busy arrivals remain in our bounded inbox; never enter an opaque native queue.
      wakeNeeded = true;
      pumpIdleNotice();
      return { tag: "admitted", ...state() };
    }
    log("admitted", { id, ...state() });
    // Reserve before void submission. Never retry or infer rejection from an async failure.
    // eslint-disable-next-line typescript/no-confusing-void-expression -- Spike asserts the actual public void return, not a delivery receipt.
    const result = pi.sendMessage(
      { customType: "spike-peer", content, display: true, details: { id } },
      { triggerTurn: true, deliverAs: "steer" },
    );
    log("submitted", { id, returnType: typeof result });
    return { tag: "admitted", ...state() };
  };
  const controls: Record<string, (command: Control) => unknown> = {
    "inbox-delivery": () => {
      inboxDelivery = true;
      return state();
    },
    push: (command) => admit(command.id ?? "missing", command.content ?? "missing"),
    mode: (command) => {
      mode = command.mode ?? "success";
      filter = command.filter ?? false;
      return state();
    },
    release: () => {
      release?.();
      releaseSettled?.();
      return state();
    },
    "hold-settled": () => {
      holdSettled = true;
      return state();
    },
    "settle-push": () => {
      settlePush = true;
      return state();
    },
  };
  const control = (command: Control) => (controls[command.op] ?? state)(command);
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (!input.endsWith("\n")) {
        return;
      }
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Isolated test controller writes this fixture-only shape.
      const command = JSON.parse(input) as Control;
      pi.events.emit("spike:control", command);
      const result = control(command);
      log("control", { command, result });
      socket.end(`${JSON.stringify(result)}\n`);
    });
  });
  pi.on("session_start", (event, ctx) => {
    context = ctx;
    server.listen(socketPath);
    log("session_start", event);
  });
  pi.on("session_shutdown", async (event) => {
    log("session_shutdown", event);
    context = undefined;
    for (const handle of deferredChecks) {
      clearImmediate(handle);
    }
    deferredChecks.clear();
    release?.();
    releaseSettled?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    context = undefined;
  });
  pi.registerCommand("spike-reload", {
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  const observeNotice = (details: unknown) => {
    if (noticeMatches(details, idleNoticeInFlight)) {
      log("notice_observed", { noticeId: idleNoticeInFlight });
      idleNoticeInFlight = undefined;
    }
  };
  const observePeer = (value: unknown) => {
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- This fixture exclusively authors spike-peer details.
    const details = value as { id: string };
    outstanding.delete(details.id);
    log("host_observed", { id: details.id, ...state() });
  };
  pi.on("message_end", (event) => {
    if (event.message.role !== "custom") {
      return;
    }
    switch (event.message.customType) {
      case "spike-notice": {
        observeNotice(event.message.details);
        break;
      }
      case "spike-peer": {
        observePeer(event.message.details);
        break;
      }
    }
  });
  pi.on("context", (event) => {
    log("context", { filter, roles: event.messages.map((message) => message.role) });
    if (filter) {
      return { messages: event.messages.filter((message) => message.role !== "custom") };
    }
    return undefined;
  });
  pi.on("agent_start", () => {
    log("agent_start");
  });
  pi.on("agent_end", () => {
    log("agent_end", state());
  });
  pi.on("agent_before_settle", (event) => {
    log("agent_before_settle", state());
    if (inboxDelivery && wakeNeeded) {
      wakeNeeded = false;
      log("notice_boundary", { source: "before_settle" });
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "spike-notice",
            content: "INBOX_NOTICE: call spike_take",
            display: false,
          },
        ],
        continue: true,
      };
    }
    return undefined;
  });
  pi.on("agent_settled", (event) => {
    // An aborted run discards its wake intent, not the adapter-owned inbox.
    // No automatic re-notice; a later new admission can request a fresh wake.
    wakeNeeded = false;
    log("settled_first", { ...event, ...state() });
    if (settlePush) {
      settlePush = false;
      admit("settled-push", "PEER: settled-push");
    }
  });
  pi.on("agent_settled", async () => {
    if (holdSettled) {
      holdSettled = false;
      log("settled_gate", state());
      await new Promise<void>((resolve) => {
        releaseSettled = resolve;
      });
      releaseSettled = undefined;
    }
    log("settled_last", state());
  });
  pi.on("session_before_compact", async (event) => {
    log("before_compact", { reason: event.reason, willRetry: event.willRetry });
    if (mode === "compact-hold") {
      log("compact_gate", { idle: context?.isIdle() });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      release = undefined;
    }
    if (mode === "compact-fail") {
      // Exercise the default compactor against the same offline failing model.
      return undefined;
    }
    return {
      compaction: {
        summary: "Offline summary; no receipt or model-read claim.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
  pi.on("session_compact", (event) => {
    log("compacted", { reason: event.reason, willRetry: event.willRetry, idle: context?.isIdle() });
    checkIdleAfterHook();
  });
  pi.on("session_compact_failed", (event) => {
    log("compact_failed", event);
    if (!event.aborted) {
      checkIdleAfterHook();
    }
  });
  pi.registerTool({
    name: "spike_take",
    label: "Take offline inbox",
    description: "Explicitly transfer bounded inbox entries, at most once",
    parameters: Type.Object({}),
    async execute() {
      const messages = [...inbox].map(([id, content]) => ({ id, content }));
      inbox.clear();
      for (const message of messages) {
        outstanding.delete(message.id);
      }
      log("inbox_taken", { messages });
      return {
        content: [{ type: "text", text: JSON.stringify(messages) }],
        details: { count: messages.length },
      };
    },
  });
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  const holdResponse = async (signal: AbortSignal | undefined, index: number) => {
    await new Promise<void>((resolve) => {
      release = resolve;
      onAbort(signal, () => {
        log("abort_seen", { index });
        void delay(150).then(resolve);
      });
    });
    release = undefined;
  };
  const takeAvailable = (lastRole: string | undefined) =>
    inboxDelivery && lastRole !== "toolResult" && inbox.size > 0;
  const shouldTake = (selected: string, aborted: boolean, lastRole: string | undefined) => {
    if (responseFailure(selected) || aborted) {
      return false;
    }
    return takeAvailable(lastRole);
  };
  pi.registerProvider("spike", {
    baseUrl: "offline://spike",
    apiKey: "offline-not-a-credential",
    api: "spike-offline",
    models: [
      {
        id: "recorder",
        name: "Offline lifecycle recorder",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 1024,
      },
    ],
    streamSimple: (model, transcript, options) => {
      request += 1;
      const index = request;
      const selected = mode;
      if (["retry-once", "overflow-once"].includes(mode)) {
        mode = "success";
      }
      const final = (async (): Promise<AssistantMessage> => {
        const payload: unknown = await recordPayload(
          options,
          { index, messages: transcript.messages },
          model,
        );
        log("request", { index, selected, messages: transcript.messages, payload });
        if (selected === "hold") {
          await holdResponse(responseSignal(options), index);
        }
        // Keep synthetic response time strictly after an immediately preceding compaction.
        await delay(5);
        const aborted = responseAborted(options);
        const take = shouldTake(selected, aborted, transcript.messages.at(-1)?.role);
        return responseMessage(model, index, selected, aborted, take);
      })();
      const stream = createAssistantMessageEventStream();
      void final.then((message) => {
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else {
          stream.push({
            type: "start",
            partial: { ...message, content: [], stopReason: "pending" },
          });
          stream.push({
            type: "done",
            reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
            message,
          });
        }
        stream.end(message);
        return undefined;
      });
      return stream;
    },
  });
}
