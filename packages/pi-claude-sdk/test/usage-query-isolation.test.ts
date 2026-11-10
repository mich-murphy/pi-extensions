import { rmSync } from "node:fs";
import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ClaudeUsageQueries, inspectClaudeUsage } from "../sdk-usage";
import { installFakeClaude } from "./fake-claude-cli";
import type { FakeClaude } from "./fake-claude-cli";

describe("usage query isolation", () => {
  let claude: FakeClaude | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (claude !== undefined) {
      rmSync(claude.directory, { recursive: true, force: true });
    }
  });

  // docs/architecture.md, "Isolation from host config": "Each query sets `settingSources: []`,
  // `tools: []`, `strictMcpConfig: true` and `skills: []`."
  test("starts Claude Code with the same host-config isolation as every provider query", async () => {
    claude = installFakeClaude({
      version: "2.1.317",
      usage: { subscription_type: "max", rate_limits_available: false, rate_limits: null },
    });
    vi.stubEnv("PI_CLAUDE_SDK_CLAUDE_PATH", claude.path);

    await Effect.runPromise(inspectClaudeUsage().pipe(Effect.provide(ClaudeUsageQueries.layer)));

    const [argv] = claude.spawnedWith();
    expect(argv).toStrictEqual(
      expect.arrayContaining(["--tools=", "--setting-sources=", "--strict-mcp-config"]),
    );
    expect(claude.controlRequests()).toContainEqual({
      subtype: "initialize",
      systemPrompt: [""],
      skills: [],
    });
  });
});
