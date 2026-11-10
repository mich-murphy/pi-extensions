import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, assert, describe, expect, test } from "vitest";
import { createClaudeAgentSdkRunner } from "../sdk/runner";
import type { RunnerOptions, RunSdkQuery } from "../sdk/runner";
import {
  drain,
  requestFixture,
  resultMessage,
  sdkContentRecords,
  sdkPromptFixture,
  sonnet,
  textBlock,
} from "./fixtures";

type SdkQueryParameters = Parameters<RunSdkQuery>[0];

const scratch: string[] = [];

async function startedWith(
  collaborators: RunnerOptions,
  streamOptions: SimpleStreamOptions = {},
  request = requestFixture(),
): Promise<SdkQueryParameters> {
  const captured: SdkQueryParameters[] = [];
  const runner = createClaudeAgentSdkRunner({
    ...collaborators,
    runSdkQuery: async function* capture(params) {
      captured.push(params);
      yield resultMessage();
    },
  });
  await drain(runner(request, sonnet, streamOptions));
  const [params] = captured;
  assert(params !== undefined, "test setup: SDK query was not started");
  return params;
}

function installedClaude(): string {
  const directory = mkdtempSync(join(tmpdir(), "claude-sdk-isolation-"));
  scratch.push(directory);
  const path = join(directory, "claude");
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("options handed to the Agent SDK", () => {
  afterEach(() => {
    for (const directory of scratch.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("denies every tool outside the Pi MCP server instead of prompting", async () => {
    const { options } = await startedWith({ claudeExecutable: "/usr/bin/claude" });

    expect(options?.permissionMode).toBe("dontAsk");
    expect(options?.allowedTools).toStrictEqual(["mcp__pi__*"]);
  });

  test("makes both deferral hooks fail closed", async () => {
    const { options } = await startedWith({ claudeExecutable: "/usr/bin/claude" });

    expect(options?.hooks?.PreToolUse?.map((matcher) => matcher.onFailure)).toStrictEqual([
      "block",
    ]);
    expect(options?.hooks?.PostToolBatch?.map((matcher) => matcher.onFailure)).toStrictEqual([
      "block",
    ]);
  });

  test("sends replayed text verbatim, without slash-command or @file expansion", async () => {
    const { options } = await startedWith({ claudeExecutable: "/usr/bin/claude" });

    expect(options?.verbatimPrompts).toBe(true);
  });

  test("runs the configured Claude Code, never the SDK's bundled binary", async () => {
    const { options } = await startedWith({
      claudeExecutable: "/opt/claude/bin/claude",
      sdkEnvironment: { PATH: "/bin" },
    });

    expect(options?.pathToClaudeCodeExecutable).toBe("/opt/claude/bin/claude");
  });

  test("resolves Claude Code from PI_CLAUDE_SDK_CLAUDE_PATH when none is injected", async () => {
    const executable = installedClaude();
    const { options } = await startedWith({
      sdkEnvironment: { PATH: "/bin", PI_CLAUDE_SDK_CLAUDE_PATH: executable },
    });

    expect(options?.pathToClaudeCodeExecutable).toBe(executable);
  });
});

describe("PI_CACHE_RETENTION", () => {
  const request = requestFixture({
    promptBlocks: [textBlock("a"), textBlock("b")],
    cacheBreakpoints: [0, 1],
  });

  async function cacheControls(
    sdkEnvironment: Record<string, string>,
    streamOptions: SimpleStreamOptions = {},
  ) {
    const { prompt } = await startedWith(
      { claudeExecutable: "/usr/bin/claude", sdkEnvironment },
      streamOptions,
      request,
    );
    const [message] = await drain(sdkPromptFixture(prompt));
    return sdkContentRecords(message).map((block) => block.cache_control);
  }

  test("the provider environment selects the one-hour cache lifetime", async () => {
    await expect(cacheControls({ PI_CACHE_RETENTION: "long" })).resolves.toStrictEqual([
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral", ttl: "1h" },
    ]);
  });

  test("the stream environment overrides the provider environment", async () => {
    const controls = await cacheControls(
      { PI_CACHE_RETENTION: "none" },
      { env: { PI_CACHE_RETENTION: "long" } },
    );

    expect(controls).toStrictEqual([
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral", ttl: "1h" },
    ]);
  });

  test("an explicit cacheRetention beats the environment", async () => {
    const controls = await cacheControls(
      { PI_CACHE_RETENTION: "long" },
      { cacheRetention: "short" },
    );

    expect(controls).toStrictEqual([{ type: "ephemeral" }, { type: "ephemeral" }]);
  });
});
