import { describe, expect, test } from "vitest";
import {
  type ClaudeSdkVersionSources,
  formatClaudeSdkVersionStatus,
  inspectClaudeSdkVersions,
} from "../sdk-version-status";

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

describe("Claude SDK version status", () => {
  test("suggests an update when installed Claude Code is newer than the SDK bundle", async () => {
    const result = await inspectClaudeSdkVersions(
      versionSources("0.3.227", "2.1.227", "2.1.251 (Claude Code)"),
    );

    expect(result).toEqual({
      _tag: "ok",
      value: {
        agentSdk: "0.3.227",
        bundledClaudeCode: "2.1.227",
        installedClaudeCode: "2.1.251",
        updateSuggested: true,
      },
    });
  });

  test("does not suggest an update for matching versions", async () => {
    const result = await inspectClaudeSdkVersions(
      versionSources("0.3.251", "2.1.251", "2.1.251 (Claude Code)"),
    );

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") throw new Error("test setup: expected parsed versions");
    expect(result.value.updateSuggested).toBe(false);
    expect(formatClaudeSdkVersionStatus(result.value)).toContain(
      "The Agent SDK bundle is not older than the installed Claude Code.",
    );
  });

  test("compares major and minor versions before patch versions", async () => {
    const newerMinor = await inspectClaudeSdkVersions(
      versionSources("0.3.999", "2.1.999", "2.2.0 (Claude Code)"),
    );
    const olderMajor = await inspectClaudeSdkVersions(
      versionSources("0.3.1", "3.0.0", "2.99.999 (Claude Code)"),
    );

    expect(newerMinor._tag === "ok" && newerMinor.value.updateSuggested).toBe(true);
    expect(olderMajor._tag === "ok" && olderMajor.value.updateSuggested).toBe(false);
  });

  test("returns typed failures for unavailable or malformed version sources", async () => {
    const unavailable = await inspectClaudeSdkVersions({
      readSdkPackageMetadata: async () =>
        JSON.stringify({ version: "0.3.227", claudeCodeVersion: "2.1.227" }),
      readInstalledClaudeVersion: async () => {
        throw new Error("not found");
      },
    });
    const malformed = await inspectClaudeSdkVersions(
      versionSources("0.3.227", "unknown", "not a Claude version"),
    );

    expect(unavailable._tag).toBe("err");
    if (unavailable._tag === "err")
      expect(unavailable.error.operation).toBe("read-installed-version");
    expect(malformed._tag).toBe("err");
    if (malformed._tag === "err") expect(malformed.error.operation).toBe("parse-version");
  });
});
