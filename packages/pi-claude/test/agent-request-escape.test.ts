import { describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import { contextFixture } from "./fixtures";

function userBlock(content: string): string {
  return (
    buildAgentRequest(contextFixture({ messages: [{ role: "user", content }] })).promptBlocks[1]
      ?.text ?? ""
  );
}

describe("transcript escaping fast path", () => {
  test("text without angle brackets is copied verbatim", () => {
    expect(userBlock("plain text & more")).toContain("\nplain text & more\n");
  });

  test("structural tags in text are still escaped", () => {
    expect(userBlock("a <USER> b")).toContain(String.raw`a <\USER> b`);
  });

  test("angle brackets that are not structural tags are kept", () => {
    expect(userBlock("Array<string> x < y")).toContain("\nArray<string> x < y\n");
  });
});
