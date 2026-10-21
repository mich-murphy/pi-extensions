import type { Context, SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import { contextFixture, transcriptFixture } from "./fixtures";
import type { MessageFixture } from "./fixtures";

const readCall: MessageFixture = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json" } }],
};
const readResult: MessageFixture = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  isError: false,
  content: [{ type: "text", text: "{}" }],
};

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const bashTool = { name: "bash", description: "Run a command", parameters: { type: "object" } };

function systemMessage(fields: Partial<SystemMessage>): SystemMessage {
  return { role: "system", content: "", timestamp: 0, ...fields };
}

function requestFor(messages: readonly MessageFixture[], tools: Context["tools"] = []) {
  return buildAgentRequest(contextFixture({ systemPrompt: "s", messages, tools }));
}

function userEntries(count: number): MessageFixture[] {
  return Array.from({ length: count }, (_, index) => ({ role: "user", content: `entry ${index}` }));
}

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

    expect(transcriptOf(request).map((block) => block.text)).toStrictEqual([
      '{"role":"user","content":[{"type":"text","text":"Read the package file"}]}',
      '{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"package.json"}}]}',
      String.raw`{"role":"toolResult","toolCallId":"call-1","toolName":"read","isError":false,"content":[{"type":"text","text":"{\"name\":\"demo\"}"}]}`,
    ]);
  });

  test("omits an assistant message that carried only thinking", () => {
    const request = requestFor([
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }] },
    ]);

    expect(transcriptOf(request)).toHaveLength(1);
    expect(request.cacheBreakpoints).toStrictEqual([0, 1]);
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
    expect(entry?.images).toStrictEqual([{ data: "dXNlci1pbWFnZQ==", mediaType: "image/png" }]);
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
    expect(entries[1]?.images).toStrictEqual([
      { data: "dG9vbC1pbWFnZQ==", mediaType: "image/jpeg" },
    ]);
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
    expect(request.systemPrompt).toContain('Every gateway call must include an "arguments" object');
    expect(request.systemPrompt).toContain('never alongside "name"');
    expect(request.toolDescription).toContain('The "arguments" object is required');
    expect(request.toolDescription).toContain("never at the gateway's top level");
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
    expect(request.toolNames).toStrictEqual(new Set(["read"]));
  });

  test.each([
    [2, [0, 2]],
    [40, [0, 20, 40]],
    [41, [0, 1, 21, 41]],
    [62, [0, 22, 42, 62]],
  ])(
    "caches the preamble and the newest of %i entries, splitting gaps wider than the lookback, never the closing instruction",
    (count, breakpoints) => {
      const request = requestFor(userEntries(count));
      expect(request.promptBlocks).toHaveLength(count + 2);
      expect(request.cacheBreakpoints).toStrictEqual(breakpoints);
    },
  );

  test("also caches the previous request's tail, so a wide tool fan-out still reads the earlier conversation", () => {
    const calls = Array.from({ length: 25 }, (_, index) => ({
      type: "toolCall" as const,
      id: `call-${index}`,
      name: "read",
      arguments: { path: `${index}` },
    }));
    const results = calls.map(({ id }): MessageFixture => ({ ...readResult, toolCallId: id }));
    const request = requestFor([
      { role: "user", content: "Read everything" },
      { role: "assistant", content: calls },
      ...results,
    ]);

    expect(request.cacheBreakpoints).toStrictEqual([0, 1, 7, 27]);
  });

  test("counts each image as its own wire block when splitting gaps", () => {
    const images = Array.from({ length: 30 }, () => ({
      type: "image" as const,
      data: "aW1n",
      mimeType: "image/png",
    }));
    const request = requestFor([
      { role: "user", content: "before" },
      { role: "user", content: images },
      { role: "user", content: "after" },
    ]);

    expect(request.cacheBreakpoints).toStrictEqual([0, 2, 3]);
  });

  test("caches only the preamble for an empty transcript", () => {
    expect(requestFor([]).cacheBreakpoints).toStrictEqual([0]);
  });
});

describe("prompt and tools replayed from the transcript", () => {
  test("reads the Pi prompt and tool catalog from the leading system message", () => {
    const request = buildAgentRequest(
      transcriptFixture([
        systemMessage({ content: "Repository rule: run tests.", toolsAdded: [readTool] }),
        { role: "user", content: "Inspect package.json" },
      ]),
    );

    expect(request.promptBlocks[0]?.text).toContain(
      "Pi working instructions:\n\nRepository rule: run tests.",
    );
    expect(request.toolNames).toStrictEqual(new Set(["read"]));
    expect(request.toolDescription).toContain('"required":["path"]');
  });

  test("applies a mid-conversation system message's added and removed tools", () => {
    const request = buildAgentRequest(
      transcriptFixture([
        systemMessage({ content: "Base prompt.", toolsAdded: [readTool, bashTool] }),
        { role: "user", content: "Search the web" },
        systemMessage({
          content: "Web access is enabled.",
          toolsAdded: [{ name: "web_search", description: "Search", parameters: {} }],
          toolsRemoved: [{ name: "bash" }],
        }),
      ]),
    );

    expect(request.toolNames).toStrictEqual(new Set(["read", "web_search"]));
    expect(request.promptBlocks[0]?.text).toContain("Base prompt.");
    expect(request.promptBlocks[0]?.text).toContain("Web access is enabled.");
    expect(request.toolDescription).toContain('"name":"web_search"');
    expect(request.toolDescription).not.toContain('"name":"bash"');
  });

  test("keeps system messages out of the JSONL transcript, which carries conversation only", () => {
    const request = buildAgentRequest(
      transcriptFixture([
        systemMessage({ content: "Base prompt.", toolsAdded: [readTool] }),
        { role: "user", content: "Hello" },
        systemMessage({ content: "An extra instruction.", toolsAdded: [bashTool] }),
      ]),
    );

    expect(transcriptOf(request).map((block) => block.text)).toStrictEqual([
      '{"role":"user","content":[{"type":"text","text":"Hello"}]}',
    ]);
  });

  test("reports an empty catalog only when the transcript declares no tools", () => {
    const request = buildAgentRequest(
      transcriptFixture([
        systemMessage({ content: "Base prompt." }),
        { role: "user", content: "Hi" },
      ]),
    );

    expect(request.toolNames).toStrictEqual(new Set());
    expect(request.toolDescription).toContain("Available Pi tools: []");
  });
});

describe("stable transcript caching", () => {
  test("keeps the transcript prefix (text and images) byte-identical as entries are appended, so a later turn can hit cache on it", () => {
    const messages: MessageFixture[] = [
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

    const stablePrefix = before.promptBlocks.slice(0, -1);
    expect(after.promptBlocks.slice(0, stablePrefix.length)).toStrictEqual(stablePrefix);
    expect(stablePrefix[1]?.images).toStrictEqual([
      { data: "aW1hZ2Utb25l", mediaType: "image/png" },
    ]);

    expect(before.cacheBreakpoints).toStrictEqual([0, 1, 2]);
    expect(after.cacheBreakpoints).toStrictEqual([0, 1, 3]);
  });

  test("a mid-conversation section or tool change updates the preamble and catalog to Pi's current state, leaving conversation entries unchanged", () => {
    const base: MessageFixture[] = [
      systemMessage({
        content: "Base prompt.",
        sections: { rules: "<rules>a</rules>" },
        toolsAdded: [readTool],
      }),
      { role: "user", content: "Hello" },
      readCall,
      readResult,
    ];
    const before = buildAgentRequest(transcriptFixture(base));
    const after = buildAgentRequest(
      transcriptFixture([
        ...base,
        systemMessage({
          sections: { rules: "<rules>b</rules>" },
          toolsAdded: [bashTool],
          toolsRemoved: [{ name: "read" }],
        }),
        { role: "user", content: "Now run it" },
      ]),
    );

    expect(after.promptBlocks[0]?.text).toContain("<rules>b</rules>");
    expect(after.promptBlocks[0]?.text).not.toContain("<rules>a</rules>");
    expect(after.toolDescription).toContain('"name":"bash"');
    expect(after.toolDescription).not.toContain('"name":"read"');
    expect(after.toolNames).toStrictEqual(new Set(["bash"]));
    const conversation = transcriptOf(before);
    expect(transcriptOf(after).slice(0, conversation.length)).toStrictEqual(conversation);
    expect(transcriptOf(after).map((block) => block.text)).not.toContainEqual(
      expect.stringContaining('"role":"system"'),
    );
  });
});
