import { describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import { contextFixture } from "./fixtures";

const readCall = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } }],
};
const readResult = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  isError: false,
  content: [{ type: "text", text: "{}" }],
};

function requestFor(messages: ReadonlyArray<unknown>, tools: ReadonlyArray<unknown> = []) {
  return buildAgentRequest(contextFixture({ systemPrompt: "s", messages, tools }));
}

// promptBlocks = [preamble, ...transcript entries, closing instruction].
function transcriptOf(request: ReturnType<typeof buildAgentRequest>) {
  return request.promptBlocks.slice(1, -1);
}

describe("conversation serialization", () => {
  test("preserves text, tool calls, and tool results as a JSONL transcript, dropping thinking", () => {
    const request = requestFor([
      { role: "user", content: "Read the package file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning", thinkingSignature: "signature" },
          ...readCall.content,
        ],
      },
      { ...readResult, content: [{ type: "text", text: '{"name":"demo"}' }] },
    ]);

    expect(transcriptOf(request).map((block) => block.text)).toEqual([
      '{"role":"user","content":[{"type":"text","text":"Read the package file"}]}',
      '{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"package.json"}}]}',
      '{"role":"toolResult","toolCallId":"call-1","toolName":"read","isError":false,"content":[{"type":"text","text":"{\\"name\\":\\"demo\\"}"}]}',
    ]);
  });

  test("omits an assistant message that carried only thinking", () => {
    const request = requestFor([
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }] },
    ]);

    expect(transcriptOf(request)).toHaveLength(1);
    expect(request.cacheBreakpoint).toBe(1);
  });

  test("forwards a user message's image bytes as an attachment, not embedded in the JSONL text", () => {
    const [entry] = transcriptOf(
      requestFor([
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            { type: "image", data: "dXNlci1pbWFnZQ==", mimeType: "image/png" },
          ],
        },
      ]),
    );

    expect(entry?.text).toBe(
      '{"role":"user","content":[{"type":"text","text":"What is in this screenshot?"},{"type":"image","mediaType":"image/png","imageRef":0}]}',
    );
    expect(entry?.images).toEqual([{ data: "dXNlci1pbWFnZQ==", mediaType: "image/png" }]);
  });

  test("forwards a toolResult message's image bytes (e.g. a screenshot tool) the same way as user images", () => {
    const entries = transcriptOf(
      requestFor([
        { role: "user", content: "Take a screenshot" },
        {
          ...readResult,
          toolName: "screenshot",
          content: [{ type: "image", data: "dG9vbC1pbWFnZQ==", mimeType: "image/jpeg" }],
        },
      ]),
    );

    expect(entries[1]?.text).toBe(
      '{"role":"toolResult","toolCallId":"call-1","toolName":"screenshot","isError":false,"content":[{"type":"image","mediaType":"image/jpeg","imageRef":0}]}',
    );
    expect(entries[1]?.images).toEqual([{ data: "dG9vbC1pbWFnZQ==", mediaType: "image/jpeg" }]);
  });
});

describe("agent request construction", () => {
  test("builds an honest Pi system prompt and a catalog for the deferred tool gateway", () => {
    const request = buildAgentRequest(
      contextFixture({
        systemPrompt: "Repository rule: run tests.",
        messages: [{ role: "user", content: "Inspect package.json" }],
        tools: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      }),
    );

    expect(request.systemPrompt).toContain("You are the model inside Pi Coding Agent");
    expect(request.systemPrompt).not.toContain("Repository rule: run tests.");
    expect(request.systemPrompt).not.toContain("You are Claude Code");
    expect(request.promptBlocks[0]?.text).toContain(
      "Pi working instructions:\n\nRepository rule: run tests.",
    );
    expect(request.promptBlocks.map((block) => block.text)).toContain(
      '{"role":"user","content":[{"type":"text","text":"Inspect package.json"}]}',
    );
    expect(request.toolDescription).toContain('"name":"read"');
    expect(request.toolDescription).toContain('"required":["path"]');
    expect(request.toolNames).toEqual(new Set(["read"]));
  });

  test("places the single cache breakpoint on the newest transcript entry, never the closing instruction", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ role: "user", content: `entry ${index}` }));

    // Entry N-1 is prompt block N because the preamble is block 0. The sanitized
    // failing session first broke at 41 entries, the old second-marker threshold.
    for (const count of [2, 40, 41, 62]) {
      const request = requestFor(entries(count));
      expect(request.promptBlocks).toHaveLength(count + 2);
      expect(request.cacheBreakpoint).toBe(count);
    }
  });

  test("requests no cache breakpoint for an empty transcript", () => {
    expect(requestFor([]).cacheBreakpoint).toBeUndefined();
  });
});

describe("stable transcript caching", () => {
  test("keeps the transcript prefix (text and images) byte-identical as entries are appended, so a later turn can hit cache on it", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          { type: "image", data: "aW1hZ2Utb25l", mimeType: "image/png" },
        ],
      },
      readCall,
    ];

    const before = requestFor(messages);
    const after = requestFor([...messages, readResult]);

    // Everything except the closing instruction is the prefix a later turn must reproduce.
    const stablePrefix = before.promptBlocks.slice(0, -1);
    expect(after.promptBlocks.slice(0, stablePrefix.length)).toEqual(stablePrefix);
    expect(stablePrefix[1]?.images).toEqual([{ data: "aW1hZ2Utb25l", mediaType: "image/png" }]);

    // The breakpoint moves forward onto the newest entry each turn.
    expect(before.cacheBreakpoint).toBe(stablePrefix.length - 1);
    expect(after.cacheBreakpoint).toBe(stablePrefix.length);
  });
});
