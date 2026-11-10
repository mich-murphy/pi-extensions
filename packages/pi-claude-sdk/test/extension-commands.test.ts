import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, assert, describe, expect, test, vi } from "vitest";
import type { ClaudeHandlers } from "../index";
import registerClaudeSdkProvider from "../index";
import { VALIDATION_ERROR_TOOL, validationRecoveryReason } from "../validation-recovery";
import { installFakeClaude } from "./fake-claude-cli";
import type { FakeClaude, FakeClaudeBehaviour } from "./fake-claude-cli";

type Notice = { readonly text: string; readonly level: string };
type Context = {
  readonly hasUI: boolean;
  readonly ui: { readonly notify: (text: string, level: "info" | "warning" | "error") => void };
};
type Command = (args: string, ctx: Context) => Promise<void>;

const quietContext: Context = { hasUI: false, ui: { notify: () => undefined } };

function toolCall(toolName: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "call-1", toolName, input: {} };
}

function loadExtension() {
  const commands = new Map<string, Command>();
  const handlers: Partial<ClaudeHandlers> = {};
  registerClaudeSdkProvider({
    registerCommand: (name: string, options: { readonly handler: Command }) => {
      commands.set(name, options.handler);
    },
    registerTool: () => undefined,
    on: <K extends keyof ClaudeHandlers>(name: K, handler: ClaudeHandlers[K]) => {
      handlers[name] = handler;
    },
    registerProvider: () => undefined,
    events: { emit: () => undefined },
  });
  return { commands, handlers };
}

async function runCommand(name: string, hasUI = true): Promise<Notice[]> {
  const { commands } = loadExtension();
  const command = commands.get(name);
  assert(command !== undefined, `test setup: ${name} is not registered`);
  const notices: Notice[] = [];
  await command("", { hasUI, ui: { notify: (text, level) => notices.push({ text, level }) } });
  return notices;
}

describe("provider commands", () => {
  const scratch: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of scratch.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function installClaude(behaviour: FakeClaudeBehaviour): FakeClaude {
    const claude = installFakeClaude(behaviour);
    scratch.push(claude.directory);
    vi.stubEnv("PI_CLAUDE_SDK_CLAUDE_PATH", claude.path);
    return claude;
  }

  describe("claude-sdk-status", () => {
    // Runs a real stand-in `claude` executable: 0.46 s with 8 busy processes plus other suites running.
    test(
      "warns that an old Claude Code needs updating and lists the model mappings",
      { timeout: 30_000 },
      async () => {
        const claude = installClaude({ version: "2.1.200" });

        const [notice, ...rest] = await runCommand("claude-sdk-status");

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

      const [notice, ...rest] = await runCommand("claude-sdk-status");

      expect(rest).toStrictEqual([]);
      expect(notice?.level).toBe("warning");
      expect(notice?.text).toContain("The installed Claude Code is newer.");
      expect(notice?.text).not.toContain("too old");
    });

    test("shows an error notice, not a crash, when Claude Code is not installed", async () => {
      const emptyPath = mkdtempSync(join(tmpdir(), "claude-sdk-empty-path-"));
      scratch.push(emptyPath);
      vi.stubEnv("PI_CLAUDE_SDK_CLAUDE_PATH", "");
      vi.stubEnv("PATH", emptyPath);

      const [notice] = await runCommand("claude-sdk-status");

      expect(notice?.level).toBe("error");
      expect(notice?.text).toContain("Claude Code is not installed or not on PATH");
    });

    test("says nothing without a UI", async () => {
      installClaude({ version: "2.1.317" });

      await expect(runCommand("claude-sdk-status", false)).resolves.toStrictEqual([]);
    });
  });

  describe("claude-sdk-usage", () => {
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

      const notices = await runCommand("claude-sdk-usage");

      expect(notices).toHaveLength(1);
      expect(notices[0]?.level).toBe("info");
      expect(notices[0]?.text).toContain("Current session: 87.5% remaining, resets ");
      expect(notices[0]?.text).toContain("Extra usage: disabled");
    });

    test("shows an error notice when Claude Code cannot report usage", async () => {
      installClaude({ version: "2.1.317" });

      const [notice] = await runCommand("claude-sdk-usage");

      expect(notice?.level).toBe("error");
    });

    test("does not start Claude Code without a UI", async () => {
      const claude = installClaude({ version: "2.1.317" });

      await expect(runCommand("claude-sdk-usage", false)).resolves.toStrictEqual([]);
      expect(claude.spawnedWith()).toStrictEqual([]);
    });
  });
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
    const input = { error: "printed_tool_call" };

    const result = handlers.tool_call?.(
      { ...toolCall(VALIDATION_ERROR_TOOL), input },
      quietContext,
    );

    expect(result?.reason).toBe(validationRecoveryReason(input));
    expect(result?.reason).not.toBe(validationRecoveryReason({}));
  });

  test("the loaded extension leaves an ordinary tool alone", () => {
    const { handlers } = loadExtension();

    expect(handlers.tool_call?.(toolCall("read"), quietContext)).toBeUndefined();
  });
});
