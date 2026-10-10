import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import { formatClaudeSdkVersionStatus, inspectClaudeSdkVersions } from "../sdk-version-status";
import type { ClaudeSdkVersionSources } from "../sdk-version-status";

function versionSources(
  sdkVersion: string,
  bundledClaudeCode: string,
  installedOutput: string,
): ClaudeSdkVersionSources {
  return {
    readSdkPackageMetadata: async () =>
      JSON.stringify({ version: sdkVersion, claudeCodeVersion: bundledClaudeCode }),
    readInstalledClaudeVersion: async () => installedOutput,
  };
}

const inspect = async (sources: ClaudeSdkVersionSources) =>
  Effect.runPromise(inspectClaudeSdkVersions(sources));
const failureOf = async (sources: ClaudeSdkVersionSources) =>
  Effect.runPromise(Effect.flip(inspectClaudeSdkVersions(sources)));

function installedVersionFailing(cause: unknown): ClaudeSdkVersionSources {
  return {
    ...versionSources("0.3.227", "2.1.227", ""),
    readInstalledClaudeVersion: async () => {
      throw cause;
    },
  };
}

describe("claude SDK version status", () => {
  test("suggests an update when installed Claude Code is newer than the SDK bundle", async () => {
    await expect(
      inspect(versionSources("0.3.227", "2.1.227", "2.1.251 (Claude Code)")),
    ).resolves.toStrictEqual({
      agentSdk: "0.3.227",
      bundledClaudeCode: "2.1.227",
      installedClaudeCode: "2.1.251",
      updateSuggested: true,
    });
  });

  test("does not suggest an update for matching versions", async () => {
    const status = await inspect(versionSources("0.3.251", "2.1.251", "2.1.251 (Claude Code)"));

    expect(status.updateSuggested).toBe(false);
    expect(formatClaudeSdkVersionStatus(status)).toContain(
      "The Agent SDK bundle is not older than the installed Claude Code.",
    );
  });

  test("compares major and minor versions before patch versions", async () => {
    const newerMinor = await inspect(versionSources("0.3.999", "2.1.999", "2.2.0 (Claude Code)"));
    const olderMajor = await inspect(versionSources("0.3.1", "3.0.0", "2.99.999 (Claude Code)"));

    expect(newerMinor.updateSuggested).toBe(true);
    expect(olderMajor.updateSuggested).toBe(false);
  });

  test("explains a missing claude binary", async () => {
    const error = await failureOf(
      installedVersionFailing(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })),
    );

    expect(error).toMatchObject({ _tag: "ClaudeInstalledVersionError", reason: "not-installed" });
    expect(error.message).toBe(
      "Claude Code is not installed or not on PATH (claude --version failed)",
    );
  });

  test("explains a claude --version that timed out or failed otherwise", async () => {
    const timedOut = await failureOf(
      installedVersionFailing(Object.assign(new Error("killed"), { killed: true })),
    );
    const failed = await failureOf(installedVersionFailing(new Error("exit 1: secret")));

    expect(timedOut.message).toBe("claude --version did not respond within 3s");
    expect(failed.message).toBe("claude --version failed");
  });

  test("quotes the bounded first line of unexpected version output", async () => {
    const longLine = `not a version ${"x".repeat(200)}`;
    const error = await failureOf(versionSources("0.3.227", "2.1.227", `${longLine}\nsecond line`));

    expect(error._tag).toBe("ClaudeVersionParseError");
    expect(error.message).toBe(
      `claude --version printed an unexpected version: "${longLine.slice(0, 80)}"`,
    );
  });

  test("reports unreadable or malformed SDK metadata", async () => {
    const unreadable = await failureOf({
      ...versionSources("", "", ""),
      readSdkPackageMetadata: async () => {
        throw new Error("EACCES");
      },
    });
    const malformed = await failureOf({
      ...versionSources("", "", ""),
      readSdkPackageMetadata: async () => "{not json",
    });

    expect(unreadable._tag).toBe("ClaudeSdkMetadataError");
    expect(malformed.message).toBe(
      "Could not read the installed Claude Agent SDK package metadata",
    );
  });
});
