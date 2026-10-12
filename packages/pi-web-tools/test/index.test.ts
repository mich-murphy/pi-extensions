import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import webToolsExtension from "../index";

type RegisteredTool = {
  readonly name: string;
  readonly execute: (...args: readonly never[]) => Promise<unknown>;
};

function fakePi() {
  const tools: RegisteredTool[] = [];
  type Handler = (
    event: unknown,
    ctx: { readonly ui: { readonly notify: (message: string) => void } },
  ) => void | Promise<void>;
  const handlers = new Map<string, Handler>();
  const notifications: string[] = [];
  const api = {
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  };
  const ctx = {
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  };
  return {
    pi: api,
    tools,
    handlers,
    ctx,
    notifications,
  };
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
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("registers websearch and webfetch with zero configuration", () => {
    const { pi, tools } = fakePi();
    webToolsExtension(pi);
    expect(tools.map((tool) => tool.name)).toStrictEqual(["websearch", "webfetch"]);
  });

  test("registers failing tools that surface invalid configuration", async () => {
    vi.stubEnv("PI_WEB_TOOLS_PROVIDERS", "exa,google");
    const { pi, tools, handlers, ctx, notifications } = fakePi();
    webToolsExtension(pi);

    expect(tools.map((tool) => tool.name)).toStrictEqual(["websearch", "webfetch"]);
    await expect(tools[0]?.execute()).rejects.toThrow("configuration error");

    await handlers.get("session_start")?.({}, ctx);
    expect(notifications[0]).toContain("unknown provider");
  });
});
