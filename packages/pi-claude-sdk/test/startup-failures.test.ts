import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { assert, describe, expect, test } from "vitest";
import { buildAgentRequest } from "../agent-request";
import { createAgentSdkStream } from "../bridge";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { RunnerOptions, RunSdkQuery } from "../sdk/runner";
import { contextFixture, drain, resultMessage, sonnet } from "./fixtures";

const installed: RunnerOptions = {
  claudeExecutable: "/usr/bin/claude",
  sdkEnvironment: { PATH: "/bin" },
};

const readTool = {
  name: "read",
  description: "Read fixture",
  parameters: Type.Object({ path: Type.String() }),
};

/** Run one turn through the public stream and return the message Pi shows the user. */
async function shownToUser(query: RunSdkQuery, collaborators: RunnerOptions, tools = [readTool]) {
  const run = createClaudeAgentSdkRunner({ ...collaborators, runSdkQuery: query });
  const context = contextFixture({ messages: [{ role: "user", content: "hi" }], tools });
  const events = await drain(createAgentSdkStream({ model: sonnet, context, options: {}, run }));
  const terminal = events.at(-1);
  assert(terminal?.type === "error", "test setup: expected the turn to fail");
  return terminal.error.errorMessage;
}

async function* currentClaude() {
  yield { type: "system", subtype: "init", claude_code_version: "2.1.317" };
  yield resultMessage();
}

describe("startup failures reach the user", () => {
  test("a Claude Code older than the minimum asks for `claude update`", async () => {
    const message = await shownToUser(async function* oldClaude() {
      yield { type: "system", subtype: "init", claude_code_version: "2.1.316" };
      yield resultMessage();
    }, {});

    expect(message).toBe(
      "Claude Agent SDK: the query stopped before finishing (Claude Code 2.1.316 is too old (2.1.317 or newer is required); run `claude update`)",
    );
  });

  test("a Claude Code at the minimum version runs the turn", async () => {
    const run = createClaudeAgentSdkRunner({
      ...installed,
      runSdkQuery: currentClaude,
    });
    const request = buildAgentRequest(
      contextFixture({ messages: [{ role: "user", content: "hi" }], tools: [readTool] }),
    );

    const events = await drain(run(request, sonnet));

    expect(events.at(-1)?.type).toBe("done");
  });

  test("a tool catalogue Pi cannot advertise faithfully (unnamed tool) fails before the query starts", async () => {
    let started = false;
    const unnamed = { ...readTool, name: "" };

    const message = await shownToUser(
      async function* neverStarted() {
        started = true;
        yield resultMessage();
      },
      installed,
      [unnamed],
    );

    expect(message).toBe(
      "Claude Agent SDK: Pi tool catalog cannot be advertised faithfully (naming)",
    );
    expect(started).toBe(false);
  });

  test("a missing Claude Code tells the user how to install or point to one", async () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "claude-sdk-no-claude-"));
    let started = false;
    try {
      const message = await shownToUser(
        async function* neverStarted() {
          started = true;
          yield resultMessage();
        },
        {
          sdkEnvironment: { PATH: emptyPath, PI_CLAUDE_SDK_CLAUDE_PATH: "" },
        },
      );

      expect(message).toBe(
        "Claude Agent SDK: could not start the query (Claude Code executable not found; install Claude Code, run `claude auth login`, or set PI_CLAUDE_SDK_CLAUDE_PATH)",
      );
      expect(started).toBe(false);
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});
