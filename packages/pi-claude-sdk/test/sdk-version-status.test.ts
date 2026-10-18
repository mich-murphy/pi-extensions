import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  ClaudeSdkVersionSources,
  formatClaudeSdkVersionStatus,
  inspectClaudeSdkVersions,
} from "../sdk-version-status";
import type { ClaudeSdkVersionReads } from "../sdk-version-status";

function versionSources(
  sdkVersion: string,
  bundledClaudeCode: string,
  installedOutput: string,
): ClaudeSdkVersionReads {
  return {
    readSdkPackageMetadata: async () =>
      JSON.stringify({ version: sdkVersion, claudeCodeVersion: bundledClaudeCode }),
    readInstalledClaudeVersion: async () => installedOutput,
  };
}

const inspectWith = (reads: ClaudeSdkVersionReads) =>
  inspectClaudeSdkVersions().pipe(Effect.provide(ClaudeSdkVersionSources.fromReads(reads)));
const failureOf = (reads: ClaudeSdkVersionReads) => Effect.flip(inspectWith(reads));

function installedVersionFailing(cause: unknown): ClaudeSdkVersionReads {
  return {
    ...versionSources("0.3.227", "2.1.227", ""),
    readInstalledClaudeVersion: async () => {
      throw cause;
    },
  };
}

describe("claude SDK version status", () => {
  it.effect("suggests an update when installed Claude Code is newer than the SDK bundle", () =>
    Effect.gen(function* () {
      expect(
        yield* inspectWith(versionSources("0.3.227", "2.1.227", "2.1.251 (Claude Code)")),
      ).toStrictEqual({
        agentSdk: "0.3.227",
        bundledClaudeCode: "2.1.227",
        installedClaudeCode: "2.1.251",
        updateSuggested: true,
      });
    }),
  );

  it.effect("does not suggest an update for matching versions", () =>
    Effect.gen(function* () {
      const status = yield* inspectWith(
        versionSources("0.3.251", "2.1.251", "2.1.251 (Claude Code)"),
      );

      expect(status.updateSuggested).toBe(false);
      expect(formatClaudeSdkVersionStatus(status)).toContain(
        "The Agent SDK bundle is not older than the installed Claude Code.",
      );
    }),
  );

  it.effect("compares major and minor versions before patch versions", () =>
    Effect.gen(function* () {
      const newerMinor = yield* inspectWith(
        versionSources("0.3.999", "2.1.999", "2.2.0 (Claude Code)"),
      );
      const olderMajor = yield* inspectWith(
        versionSources("0.3.1", "3.0.0", "2.99.999 (Claude Code)"),
      );

      expect(newerMinor.updateSuggested).toBe(true);
      expect(olderMajor.updateSuggested).toBe(false);
    }),
  );

  it.effect("explains a missing claude binary", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        installedVersionFailing(
          Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
        ),
      );

      expect(error).toMatchObject({ _tag: "ClaudeInstalledVersionError", reason: "not-installed" });
      expect(error.message).toBe(
        "Claude Code is not installed or not on PATH (claude --version failed)",
      );
    }),
  );

  it.effect("explains a claude --version that timed out or failed otherwise", () =>
    Effect.gen(function* () {
      const timedOut = yield* failureOf(
        installedVersionFailing(Object.assign(new Error("killed"), { killed: true })),
      );
      const failed = yield* failureOf(installedVersionFailing(new Error("exit 1: secret")));

      expect(timedOut.message).toBe("claude --version did not respond within 3s");
      expect(failed.message).toBe("claude --version failed");
    }),
  );

  it.effect("quotes the bounded first line of unexpected version output", () =>
    Effect.gen(function* () {
      const longLine = `not a version ${"x".repeat(200)}`;
      const error = yield* failureOf(
        versionSources("0.3.227", "2.1.227", `${longLine}\nsecond line`),
      );

      expect(error._tag).toBe("ClaudeVersionParseError");
      expect(error.message).toBe(
        `claude --version printed an unexpected version: "${longLine.slice(0, 80)}"`,
      );
    }),
  );

  it.effect("reports unreadable or malformed SDK metadata", () =>
    Effect.gen(function* () {
      const unreadable = yield* failureOf({
        ...versionSources("", "", ""),
        readSdkPackageMetadata: async () => {
          throw new Error("EACCES");
        },
      });
      const malformed = yield* failureOf({
        ...versionSources("", "", ""),
        readSdkPackageMetadata: async () => "{not json",
      });

      expect(unreadable._tag).toBe("ClaudeSdkMetadataError");
      expect(malformed.message).toBe(
        "Could not read the installed Claude Agent SDK package metadata",
      );
    }),
  );
});
