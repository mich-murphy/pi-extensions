import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const packageSchema = z.object({
  dependencies: z.object({ "@anthropic-ai/claude-agent-sdk": z.string() }),
});
const sdkMetadataSchema = z.object({ version: z.string(), claudeCodeVersion: z.string() });
const lockSchema = z.object({
  packages: z.record(z.string(), z.object({ version: z.string().optional() }).passthrough()),
});
const releaseContractSchema = z.object({
  schemaVersion: z.literal(1),
  agentSdkVersion: z.string(),
  bundledClaudeCodeVersion: z.string(),
  verifiedAt: z.iso.datetime(),
  model: z.literal("fable"),
  contracts: z.tuple([z.literal("text-response"), z.literal("deferred-tool-call")]),
  observedDeferredResult: z.literal("stop_reason:tool_deferred"),
});

async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

describe("Claude SDK release contract", () => {
  test("keeps the dependency, lockfile, SDK bundle, and live attestation on one exact version", async () => {
    const packageMetadata = packageSchema.parse(
      await readJson(new URL("../package.json", import.meta.url)),
    );
    const releaseContract = releaseContractSchema.parse(
      await readJson(new URL("../sdk-release-contract.json", import.meta.url)),
    );
    const lock = lockSchema.parse(
      await readJson(new URL("../../../package-lock.json", import.meta.url)),
    );
    const sdkEntry = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkMetadata = sdkMetadataSchema.parse(
      await readJson(new URL("./package.json", sdkEntry)),
    );
    const pinnedVersion = packageMetadata.dependencies["@anthropic-ai/claude-agent-sdk"];
    const lockedVersion = lock.packages["node_modules/@anthropic-ai/claude-agent-sdk"]?.version;

    expect(pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockedVersion).toBe(pinnedVersion);
    expect(sdkMetadata.version).toBe(pinnedVersion);
    expect(releaseContract.agentSdkVersion).toBe(pinnedVersion);
    expect(releaseContract.bundledClaudeCodeVersion).toBe(sdkMetadata.claudeCodeVersion);
  });
});
