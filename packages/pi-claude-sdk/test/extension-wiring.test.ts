import { rmSync } from "node:fs";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, assert, describe, expect, test, vi } from "vitest";
import type { ClaudeHandlers } from "../index";
import registerClaudeSdkProvider from "../index";
import { installFakeClaude } from "./fake-claude-cli";
import type { FakeClaudeBehaviour } from "./fake-claude-cli";
import { contextFixture, drain, resultMessage, sonnet, streamEvent } from "./fixtures";

type Command = (
  args: string,
  ctx: {
    readonly hasUI: boolean;
    readonly ui: { readonly notify: (text: string, level: "info" | "warning" | "error") => void };
  },
) => Promise<void>;

function loadExtension() {
  const commands = new Map<string, Command>();
  const handlers: Partial<ClaudeHandlers> = {};
  const providers = new Map<string, ProviderConfig>();
  registerClaudeSdkProvider({
    registerCommand: (name: string, options: { readonly handler: Command }) => {
      commands.set(name, options.handler);
    },
    registerTool: () => undefined,
    on: <K extends keyof ClaudeHandlers>(name: K, handler: ClaudeHandlers[K]) => {
      handlers[name] = handler;
    },
    registerProvider: (name, config) => {
      providers.set(name, config);
    },
    events: { emit: () => undefined },
  });
  return { commands, handlers, providers };
}

async function notices(command: Command | undefined): Promise<string[]> {
  assert(command !== undefined, "test setup: command not registered");
  const texts: string[] = [];
  await command("", { hasUI: true, ui: { notify: (text) => texts.push(text) } });
  return texts;
}

describe("extension wiring", () => {
  const scratch: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of scratch.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function installClaude(behaviour: FakeClaudeBehaviour): void {
    const claude = installFakeClaude(behaviour);
    scratch.push(claude.directory);
    vi.stubEnv("PI_CLAUDE_SDK_CLAUDE_PATH", claude.path);
  }

  // Each test runs the real SDK against a stand-in `claude` process, so allow for a loaded host.
  test(
    "a model the provider's turn observed appears in the status command's model list",
    { timeout: 30_000 },
    async () => {
      installClaude({
        version: "2.1.317",
        turn: [
          { type: "system", subtype: "init", claude_code_version: "2.1.317" },
          streamEvent({
            type: "message_start",
            message: { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 } },
          }),
          resultMessage({
            modelUsage: {
              "claude-opus-5-5": {
                canonicalModel: "claude-opus-5-5",
                contextWindow: 1_000_000,
                maxOutputTokens: 128_000,
              },
            },
          }),
        ],
      });
      const { commands, providers } = loadExtension();
      const config = providers.get("claude-sdk");
      assert(config?.streamSimple !== undefined, "test setup: provider not registered");
      const opus = { ...sonnet, id: "claude-5.5-opus" };
      const context = contextFixture({ messages: [{ role: "user", content: "hi" }], tools: [] });

      const events = await drain(config.streamSimple(opus, context, {}));
      const [status] = await notices(commands.get("claude-sdk-status"));

      expect(events.at(-1)?.type).toBe("done");
      expect(status).toContain("  claude-5.5-opus → opus → claude-opus-5-5\n");
    },
  );

  test(
    "session shutdown interrupts a command that is still running",
    { timeout: 30_000 },
    async () => {
      installClaude({ version: "2.1.317" });
      const { commands, handlers } = loadExtension();

      const running = notices(commands.get("claude-sdk-usage"));
      await handlers.session_shutdown?.(undefined, {
        hasUI: false,
        ui: { notify: () => undefined },
      });

      await expect(running).resolves.toStrictEqual([]);
    },
  );
});
