import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, assert, describe, expect, test, vi } from "vitest";
import type { ClaudeContext, ClaudeHandlers, ClaudeRegistration } from "../index";
import registerClaudeProvider from "../index";
import { VALIDATION_ERROR_TOOL, validationRecoveryReason } from "../validation-recovery";
import { installFakeClaude } from "./fake-claude-cli";
import type { FakeClaude, FakeClaudeBehaviour } from "./fake-claude-cli";

type Notice = { readonly text: string; readonly level: string | undefined };

type CommandOptions = Parameters<ClaudeRegistration["registerCommand"]>[1];

const quietContext: ClaudeContext = { hasUI: false, ui: { notify: () => undefined } };

function toolCall(toolName: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "call-1", toolName, input: {} };
}

function loadExtension() {
  const commands = new Map<string, CommandOptions["handler"]>();
  const completions = new Map<string, NonNullable<CommandOptions["getArgumentCompletions"]>>();
  const handlers: Partial<ClaudeHandlers> = {};
  registerClaudeProvider({
    registerCommand: (name, options) => {
      commands.set(name, options.handler);

      if (options.getArgumentCompletions !== undefined) {
        completions.set(name, options.getArgumentCompletions);
      }
    },
    registerTool: () => undefined,
    on: <K extends keyof ClaudeHandlers>(name: K, handler: ClaudeHandlers[K]) => {
      handlers[name] = handler;
    },
    registerProvider: () => undefined,
    events: { emit: () => undefined },
  });

  return { commands, completions, handlers };
}

async function runCommand(args: string, hasUI = true): Promise<Array<Notice>> {
  const { commands } = loadExtension();
  const command = commands.get("claude");
  assert(command !== undefined, "test setup: /claude is not registered");
  const notices: Array<Notice> = [];
  await command(args, { hasUI, ui: { notify: (text, level) => notices.push({ text, level }) } });

  return notices;
}

describe("provider commands", () => {
  const scratch: Array<string> = [];

  afterEach(() => {
    vi.unstubAllEnvs();

    for (const directory of scratch.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function installClaude(behaviour: FakeClaudeBehaviour): FakeClaude {
    const claude = installFakeClaude(behaviour);
    scratch.push(claude.directory);
    vi.stubEnv("PI_CLAUDE_PATH", claude.path);

    return claude;
  }

  describe("/claude status", () => {
    test("is the default action", { timeout: 30_000 }, async () => {
      installClaude({ version: "2.1.317" });

      const [bare] = await runCommand("");
      const [padded] = await runCommand("  status ");

      expect(bare?.text).toContain("Installed Claude Code: 2.1.317");
      expect(padded?.text).toContain("Installed Claude Code: 2.1.317");
    });

    test(
      "warns that an old Claude Code needs updating and lists the model mappings",
      { timeout: 30_000 },
      async () => {
        const claude = installClaude({ version: "2.1.200" });

        const [notice, ...rest] = await runCommand("status");

        expect(rest).toStrictEqual([]);
        expect(notice?.level).toBe("warning");
        expect(notice?.text).toContain(`Claude Code path: ${claude.path}`);
        expect(notice?.text).toContain("Installed Claude Code: 2.1.200 (minimum 2.1.317)");
        expect(notice?.text).toContain("Claude Code is too old: run `claude update`.");
        expect(notice?.text).toContain("Models:\n  claude-5.5-sonnet → ");
        expect(notice?.text).toContain("not observed yet");
      },
    );

    test("warns, without the too-old line, when Claude Code is newer than the Agent SDK", async () => {
      installClaude({ version: "99.0.0" });

      const [notice, ...rest] = await runCommand("status");

      expect(rest).toStrictEqual([]);
      expect(notice?.level).toBe("warning");
      expect(notice?.text).toContain("The installed Claude Code is newer.");
      expect(notice?.text).not.toContain("too old");
    });

    test("shows an error notice, not a crash, when Claude Code is not installed", async () => {
      const emptyPath = mkdtempSync(join(tmpdir(), "claude-empty-path-"));
      scratch.push(emptyPath);
      vi.stubEnv("PI_CLAUDE_PATH", "");
      vi.stubEnv("PATH", emptyPath);

      const [notice] = await runCommand("status");

      expect(notice?.level).toBe("error");
      expect(notice?.text).toContain("Claude Code (`claude`) was not found");
    });

    test("says nothing without a UI", async () => {
      installClaude({ version: "2.1.317" });

      await expect(runCommand("status", false)).resolves.toStrictEqual([]);
    });
  });

  describe("/claude usage", () => {
    test("reports remaining plan usage read from Claude Code", async () => {
      installClaude({
        version: "2.1.317",
        usage: {
          subscription_type: "max",
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 12.5, resets_at: "2030-01-01T00:00:00.000Z" },
            extra_usage: { is_enabled: false },
          },
        },
      });

      const notices = await runCommand("usage");

      expect(notices).toHaveLength(1);
      expect(notices[0]?.level).toBe("info");
      expect(notices[0]?.text).toContain("Current session: 87.5% remaining, resets ");
      expect(notices[0]?.text).toContain("Extra usage: disabled");
    });

    test("shows an error notice when Claude Code cannot report usage", async () => {
      installClaude({ version: "2.1.317" });

      const [notice] = await runCommand("usage");

      expect(notice?.level).toBe("error");
    });

    test("does not start Claude Code without a UI", async () => {
      const claude = installClaude({ version: "2.1.317" });

      await expect(runCommand("usage", false)).resolves.toStrictEqual([]);
      expect(claude.spawnedWith()).toStrictEqual([]);
    });
  });
});

describe("/claude arguments", () => {
  test("registers /claude as the only command", () => {
    expect([...loadExtension().commands.keys()]).toStrictEqual(["claude"]);
  });

  test("completes the actions", () => {
    const complete = loadExtension().completions.get("claude");

    expect(complete?.("")).toStrictEqual([
      { value: "status", label: "status" },
      { value: "usage", label: "usage" },
    ]);
    expect(complete?.("u")).toStrictEqual([{ value: "usage", label: "usage" }]);
    expect(complete?.("x")).toStrictEqual([]);
  });

  test.each(["help", "STATUS", "status usage", "claude-sdk-status"])(
    "warns about the usage for %j",
    async (args) => {
      await expect(runCommand(args)).resolves.toStrictEqual([
        { text: "Usage: /claude [status|usage]", level: "warning" },
      ]);
    },
  );
});

describe("reserved validation-recovery tool", () => {
  test("the loaded extension blocks the reserved tool with its fixed correction", () => {
    const { handlers } = loadExtension();

    const result = handlers.tool_call?.(toolCall(VALIDATION_ERROR_TOOL), quietContext);

    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/\S/u);
  });

  test("the loaded extension passes the call's input to the correction", () => {
    const { handlers } = loadExtension();
    const input = { error: "printed_tool_call" } as const;

    const result = handlers.tool_call?.(
      { ...toolCall(VALIDATION_ERROR_TOOL), input },
      quietContext,
    );

    expect(result?.reason).toBe(validationRecoveryReason(input));
    expect(result?.reason).not.toBe(validationRecoveryReason(undefined));
  });

  test("the loaded extension leaves an ordinary tool alone", () => {
    const { handlers } = loadExtension();

    expect(handlers.tool_call?.(toolCall("read"), quietContext)).toBeUndefined();
  });
});
