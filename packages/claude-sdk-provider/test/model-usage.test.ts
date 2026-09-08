import { describe, expect, test } from "vitest";
import { contextWindowForModel, mainLoopModel } from "../sdk/model-usage";

describe("mainLoopModel", () => {
  test("reads the model from a message_start stream event", () => {
    expect(
      mainLoopModel({
        type: "stream_event",
        event: { type: "message_start", message: { model: "claude-fable-5-1" } },
      }),
    ).toBe("claude-fable-5-1");
  });

  test("reads the model from an assistant message", () => {
    expect(mainLoopModel({ type: "assistant", message: { model: "claude-sonnet-5" } })).toBe(
      "claude-sonnet-5",
    );
  });

  test("ignores other stream events and message types", () => {
    expect(
      mainLoopModel({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      }),
    ).toBeUndefined();
    expect(mainLoopModel({ type: "user" })).toBeUndefined();
    expect(mainLoopModel(undefined)).toBeUndefined();
  });

  test("rejects non-string models", () => {
    expect(
      mainLoopModel({
        type: "stream_event",
        event: { type: "message_start", message: { model: 42 } },
      }),
    ).toBeUndefined();
    expect(mainLoopModel({ type: "assistant", message: {} })).toBeUndefined();
  });
});

describe("contextWindowForModel", () => {
  const result = {
    type: "result",
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        canonicalModel: "claude-haiku-4-5",
        contextWindow: 200_000,
      },
      "claude-fable-5-1": { canonicalModel: "claude-fable-5-1", contextWindow: 1_000_000 },
    },
  };

  test("matches an entry by key or canonical model", () => {
    expect(contextWindowForModel(result, "claude-fable-5-1")).toBe(1_000_000);
    expect(contextWindowForModel(result, "claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("matches a dated entry through its canonical model", () => {
    expect(contextWindowForModel(result, "claude-haiku-4-5")).toBe(200_000);
  });

  test("returns undefined for unknown models or missing windows", () => {
    expect(contextWindowForModel(result, "claude-opus-5")).toBeUndefined();
    expect(
      contextWindowForModel(
        { modelUsage: { "claude-fable-5-1": { contextWindow: 0 } } },
        "claude-fable-5-1",
      ),
    ).toBeUndefined();
    expect(contextWindowForModel({ type: "result" }, "claude-fable-5-1")).toBeUndefined();
    expect(contextWindowForModel({ modelUsage: "nope" }, "claude-fable-5-1")).toBeUndefined();
  });
});
