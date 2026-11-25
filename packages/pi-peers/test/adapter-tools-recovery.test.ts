import { describe, expect, test } from "vitest";
import { registerTools } from "../adapter/tools.js";
import type { ToolArguments } from "../adapter/tools.js";
import { ConnectionFailure } from "../adapter/transport.js";
import { Refusal } from "../onboarding/refusal.js";
import { toolRecorder } from "./adapter-tool-fixture.js";
import { toolSession } from "./tool-session-fixture.js";

async function call(name: string, failure: Error, args: ToolArguments = {}) {
  const tools = toolRecorder();

  const session = toolSession({
    recoverForTool: async () => {
      await Promise.resolve();
      throw failure;
    },
  });

  registerTools(tools, () => session);

  return tools.run(name, args);
}

const outdated = new Refusal(
  "the gateway program is out of date: it does not speak peers protocol v2",
  "Run pi update to update the gateway, then choose Setup in /peers",
);

const OUTDATED_NOTE =
  "The gateway program is out of date: it does not speak peers protocol v2. Run pi update to update the gateway, then choose Setup in /peers. Ask the user to do this; do not retry.";

const NOT_CONNECTED =
  "Peers could not connect in this session. Ask the user to run `/peers status`.";

describe("tool recovery failures", () => {
  test.each([
    [outdated, OUTDATED_NOTE],
    [new Error("startup failed"), NOT_CONNECTED],
  ])(
    "a failure while reconnecting is unavailable, not invalid input: %s",
    async (failure, note) => {
      const result = await call("peers_list", failure);
      expect(result).toMatchObject({
        isError: true,
        details: { value: { tag: "error", code: "unavailable", note } },
        structuredContent: { ok: false, code: "unavailable", note },
      });
      expect(result.content[0]?.text).toBe(note);
    },
  );
  test("an out-of-date gateway during a send is unavailable with the update step", async () => {
    const result = await call("peers_send", outdated, {
      to: "s-0000",
      kind: "update",
      content: "x",
    });

    expect(result).toMatchObject({ isError: true, details: { value: { code: "unavailable" } } });
    expect(result.content[0]?.text).toBe(OUTDATED_NOTE);
  });
  test("a connection failure while reconnecting keeps its own code", async () => {
    const result = await call("peers_list", new ConnectionFailure("protocol_error", false));
    expect(result).toMatchObject({ isError: true, details: { value: { code: "protocol_error" } } });
  });
});
