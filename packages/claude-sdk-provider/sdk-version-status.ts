import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const SEMANTIC_VERSION = /(?:^|\D)(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\D|$)/u;
const sdkPackageMetadataSchema = z.object({
  version: z.string(),
  claudeCodeVersion: z.string(),
});

type SemanticVersion = readonly [major: number, minor: number, patch: number];

/** Safe version information for the Agent SDK and Claude Code installations. */
export type ClaudeSdkVersionStatus = {
  /** Installed Agent SDK package version. */
  readonly agentSdk: string;
  /** Claude Code version bundled with the Agent SDK. */
  readonly bundledClaudeCode: string;
  /** Claude Code version resolved from the current PATH. */
  readonly installedClaudeCode: string;
  /** Whether the installed Claude Code is newer than the SDK bundle. */
  readonly updateSuggested: boolean;
};

/** Expected failure while inspecting local Claude versions. */
class ClaudeSdkVersionInspectionError extends Error {
  readonly _tag = "ClaudeSdkVersionInspectionError" as const;

  /**
   * Create a safe version-inspection failure.
   *
   * @param operation - Inspection step that failed.
   * @param cause - Unclassified underlying failure, retained for local debugging only.
   */
  constructor(
    readonly operation: "read-sdk-metadata" | "read-installed-version" | "parse-version",
    override readonly cause?: unknown,
  ) {
    super(`Could not ${operation.replaceAll("-", " ")}`);
    this.name = "ClaudeSdkVersionInspectionError";
  }
}

export type { ClaudeSdkVersionInspectionError };

/** Result of inspecting local Claude versions. */
export type ClaudeSdkVersionStatusResult =
  | { readonly _tag: "ok"; readonly value: ClaudeSdkVersionStatus }
  | { readonly _tag: "err"; readonly error: ClaudeSdkVersionInspectionError };

/** Dependencies used to inspect SDK and installed CLI versions. */
export type ClaudeSdkVersionSources = {
  /** Read the Agent SDK package metadata as JSON text. */
  readonly readSdkPackageMetadata: () => Promise<string>;
  /** Read `claude --version` output. */
  readonly readInstalledClaudeVersion: () => Promise<string>;
};

function parseSemanticVersion(input: string): SemanticVersion | undefined {
  const parts = SEMANTIC_VERSION.exec(input)?.groups;
  if (parts === undefined) {
    return undefined;
  }
  const version = [Number(parts.major), Number(parts.minor), Number(parts.patch)] as const;
  return version.every((part) => Number.isSafeInteger(part)) ? version : undefined;
}

function isNewer(candidate: SemanticVersion, baseline: SemanticVersion): boolean {
  const difference = candidate.map((part, index) => part - (baseline[index] ?? 0));
  return (difference.find((part) => part !== 0) ?? 0) > 0;
}

async function defaultReadSdkPackageMetadata(): Promise<string> {
  const sdkEntryUrl = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
  return readFile(new URL("package.json", sdkEntryUrl), "utf8");
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

async function defaultReadInstalledClaudeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["--version"], { encoding: "utf8", timeout: 3000 }, (error, stdout) => {
      if (error instanceof Error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const defaultSources: ClaudeSdkVersionSources = {
  readSdkPackageMetadata: defaultReadSdkPackageMetadata,
  readInstalledClaudeVersion: defaultReadInstalledClaudeVersion,
};

/**
 * Inspect Agent SDK, bundled Claude Code, and installed Claude Code versions.
 *
 * @param sources - Injectable process and filesystem boundary.
 * @returns Parsed status or a typed inspection failure.
 */
export async function inspectClaudeSdkVersions(
  sources: ClaudeSdkVersionSources = defaultSources,
): Promise<ClaudeSdkVersionStatusResult> {
  let metadataText: string;
  try {
    metadataText = await sources.readSdkPackageMetadata();
  } catch (error) {
    return { _tag: "err", error: new ClaudeSdkVersionInspectionError("read-sdk-metadata", error) };
  }

  const metadata = sdkPackageMetadataSchema.safeParse(parseJson(metadataText));
  if (!metadata.success) {
    return { _tag: "err", error: new ClaudeSdkVersionInspectionError("read-sdk-metadata") };
  }

  let installedOutput: string;
  try {
    installedOutput = await sources.readInstalledClaudeVersion();
  } catch (error) {
    return {
      _tag: "err",
      error: new ClaudeSdkVersionInspectionError("read-installed-version", error),
    };
  }

  const bundled = parseSemanticVersion(metadata.data.claudeCodeVersion);
  const installed = parseSemanticVersion(installedOutput);
  if (!(bundled && installed)) {
    return { _tag: "err", error: new ClaudeSdkVersionInspectionError("parse-version") };
  }

  return {
    _tag: "ok",
    value: {
      agentSdk: metadata.data.version,
      bundledClaudeCode: metadata.data.claudeCodeVersion,
      installedClaudeCode: installed.join("."),
      updateSuggested: isNewer(installed, bundled),
    },
  };
}

/**
 * Format detailed version status for `/claude-sdk-status`.
 *
 * @param status - Parsed local version status.
 * @returns Human-readable multi-line status.
 */
export function formatClaudeSdkVersionStatus(status: ClaudeSdkVersionStatus): string {
  return [
    `Agent SDK: ${status.agentSdk}`,
    `Bundled Claude Code: ${status.bundledClaudeCode}`,
    `Installed Claude Code: ${status.installedClaudeCode}`,
    status.updateSuggested
      ? "The installed Claude Code is newer. Update the pinned Agent SDK and npmDepsHash."
      : "The Agent SDK bundle is not older than the installed Claude Code.",
  ].join("\n");
}
