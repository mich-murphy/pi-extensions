import { afterEach, describe, expect, test } from "vitest";
import webToolsExtension from "../index";

interface RegisteredTool {
  name: string;
  execute: (...args: never[]) => Promise<unknown>;
}

function fakePi() {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const notifications: string[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, handler);
    },
  };
  return { pi, tools, handlers, notifications };
}

const ENV_KEYS = [
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "BRAVE_API_KEY",
  "PI_WEB_TOOLS_PROVIDERS",
  "PI_WEB_TOOLS_EXA_ENDPOINT",
  "PI_WEB_TOOLS_PARALLEL_ENDPOINT",
  "PI_WEB_TOOLS_FETCH_RESCUE",
  "PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS",
  "PI_WEB_TOOLS_FETCH_DENY_DOMAINS",
];

describe("webToolsExtension", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  test("registers websearch and webfetch with zero configuration", () => {
    const { pi, tools } = fakePi();
    webToolsExtension(pi as never);
    expect(tools.map((tool) => tool.name)).toEqual(["websearch", "webfetch"]);
  });

  test("registers failing tools that surface invalid configuration", async () => {
    process.env.PI_WEB_TOOLS_PROVIDERS = "exa,google";
    const { pi, tools, handlers, notifications } = fakePi();
    webToolsExtension(pi as never);

    expect(tools.map((tool) => tool.name)).toEqual(["websearch", "webfetch"]);
    await expect(tools[0]?.execute()).rejects.toThrow("configuration error");

    handlers.get("session_start")?.({}, ctx_for(notifications));
    expect(notifications[0]).toContain("unknown provider");
  });
});

function ctx_for(notifications: string[]) {
  return { ui: { notify: (message: string) => notifications.push(message) } };
}
