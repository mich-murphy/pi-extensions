/** Synthetic usage-limit producer; no transport, tools, credentials, or timer patches. */
import { appendFileSync } from "node:fs";
import { env } from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Resolve the checkout-pinned physical entry: Pi aliases the bare pi-ai import
// to compat, which does not expose the stream constructor at runtime.
import { createAssistantMessageEventStream } from "../../../../node_modules/@earendil-works/pi-ai/dist/index.js";
import type { AssistantMessage } from "../../../../node_modules/@earendil-works/pi-ai/dist/index.js";

export default function synthetic(pi: ExtensionAPI): void {
  pi.registerCommand("fixture-work", {
    description: "Start synthetic extension work",
    handler: async () => {
      pi.sendMessage(
        { customType: "fixture-work", content: "extension work", display: true },
        { triggerTurn: true },
      );
    },
  });
  pi.registerCommand("fixture-user", {
    description: "Start synthetic extension user input",
    handler: async () => {
      pi.sendUserMessage("extension user work");
    },
  });
  let requests = 0;
  pi.registerProvider("resume-fixture", {
    api: "resume-fixture",
    baseUrl: "offline://fixture",
    apiKey: "synthetic-not-a-secret",
    models: [
      {
        id: "fixture",
        name: "Offline resume fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 1024,
      },
    ],
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const index = ++requests;
      void (async () => {
        const scenario = env.RESUME_SCENARIO ?? "limit";
        const at = Date.now();
        let resetsAt = at + 2000;
        if (scenario === "past") {
          resetsAt = at - 1000;
        }
        if (scenario === "far") {
          resetsAt = at + 18_060_000;
        }
        const payload = { index, at, resetsAt, scenario, messages: context.messages };
        await options?.onPayload?.(payload, model);
        const record = env.RESUME_RECORD;
        if (record === undefined || record === "") {
          throw new Error("RESUME_RECORD is required");
        }
        appendFileSync(record, `${JSON.stringify(payload)}\n`);
        const first = index === 1;
        if (first && scenario !== "error" && scenario !== "plain") {
          let publishedReset: unknown = resetsAt;
          if (scenario === "invalid") {
            publishedReset = "tomorrow";
          }
          if (scenario === "nan") {
            publishedReset = Number.NaN;
          }
          if (scenario === "date") {
            publishedReset = 9e15;
          }
          const notice = {
            provider: scenario === "mismatch" ? "unrelated-provider" : "resume-fixture",
            resetsAt: publishedReset,
          };
          pi.events.emit("usage-limit", scenario === "missing" ? {} : notice);
        }
        const failed = first && scenario !== "plain" && scenario !== "success";
        const text = failed ? "FAILED_ATTEMPT_SENTINEL" : `FIXTURE_OK_${index}`;
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: at,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: failed ? "error" : "stop",
          ...(failed ? { errorMessage: "Synthetic terminal failure" } : {}),
        };
        stream.push({ type: "start", partial: { ...message, stopReason: "pending", content: [] } });
        if (failed) {
          stream.push({ type: "error", reason: "error", error: message });
        } else {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      })();
      return stream;
    },
  });
}
