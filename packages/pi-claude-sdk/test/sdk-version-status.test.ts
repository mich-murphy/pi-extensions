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
  expectedClaudeCode: string,
  installedOutput: string,
): ClaudeSdkVersionReads {
  return {
    readSdkPackageMetadata: async () =>
      JSON.stringify({ version: sdkVersion, claudeCodeVersion: expectedClaudeCode }),
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
        expectedClaudeCode: "2.1.227",
        claudePath: undefined,
        minimumClaudeCode: "2.1.317",
        belowMinimum: true,
        installedClaudeCode: "2.1.251",
        updateSuggested: true,
      });
    }),
  );

  it.effect("renders every status line, in order, for an old and newer Claude Code", () =>
    Effect.gen(function* () {
      const status = yield* inspectWith({
        ...versionSources("0.3.227", "2.1.227", "2.1.251 (Claude Code)"),
        readClaudePath: () => "/opt/claude",
      });

      expect(formatClaudeSdkVersionStatus(status)).toBe(
        [
          "Agent SDK: 0.3.227",
          "Claude Code path: /opt/claude",
          "Installed Claude Code: 2.1.251 (minimum 2.1.317)",
          "Claude Code expected by the Agent SDK: 2.1.227",
          "Claude Code is too old: run `claude update`.",
          "The installed Claude Code is newer. Update the pinned Agent SDK and npmDepsHash.",
        ].join("\n"),
      );
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

  it.effect("explains a missing claude binary", () =>
    Effect.gen(function* () {
      const error = yield* failureOf(
        installedVersionFailing(
          Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
        ),
      );

      expect(error).toMatchObject({ _tag: "ClaudeInstalledVersionError", reason: "not-installed" });
      expect(error.message).toBe(
        "Claude Code is not installed or not on PATH (claude --version failed); install it, run `claude auth login`, or set PI_CLAUDE_SDK_CLAUDE_PATH",
      );
    }),
  );

  it.effect("explains a claude --version that timed out or failed otherwise", () =>
    Effect.gen(function* () {
      const timedOut = yield* failureOf(
        installedVersionFailing(Object.assign(new Error("killed"), { killed: true })),
      );
      const failed = yield* failureOf(installedVersionFailing(new Error("exit 1: secret")));

      expect(timedOut.message).toBe(
        "claude --version did not respond within 3s; check that Claude Code starts locally",
      );
      expect(failed.message).toBe("claude --version failed; check that Claude Code starts locally");
    }),
  );

  it.effect("does not echo secrets or controls from unexpected version output", () =>
    Effect.gen(function* () {
      const longLine = `secret-token\u001b[31m ${"x".repeat(200)}`;
      const error = yield* failureOf(
        versionSources("0.3.227", "2.1.227", `${longLine}\nsecond line`),
      );

      expect(error._tag).toBe("ClaudeVersionParseError");
      expect(error.message).toBe(
        "claude --version returned an unexpected format; run `claude update` and /claude-sdk-status",
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
        "Could not read the installed Claude Agent SDK package metadata; check the extension installation",
      );
    }),
  );
});
