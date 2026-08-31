import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const SEMANTIC_VERSION = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/;
const sdkPackageMetadataSchema = z.object({
  version: z.string(),
  claudeCodeVersion: z.string(),
});

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Safe version information for the Agent SDK and Claude Code installations. */
export interface ClaudeSdkVersionStatus {
  /** Installed Agent SDK package version. */
  readonly agentSdk: string;
  /** Claude Code version bundled with the Agent SDK. */
  readonly bundledClaudeCode: string;
  /** Claude Code version resolved from the current PATH. */
  readonly installedClaudeCode: string;
  /** Whether the installed Claude Code is newer than the SDK bundle. */
  readonly updateSuggested: boolean;
}

/** Safe public shape of an expected version-inspection failure. */
export interface ClaudeSdkVersionInspectionFailure extends Error {
  readonly _tag: "ClaudeSdkVersionInspectionError";
  readonly operation: "read-sdk-metadata" | "read-installed-version" | "parse-version";
  readonly cause?: unknown;
}

/** Expected failure while inspecting local Claude versions. */
class ClaudeSdkVersionInspectionError extends Error implements ClaudeSdkVersionInspectionFailure {
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

/** Result of inspecting local Claude versions. */
export type ClaudeSdkVersionStatusResult =
  | { readonly _tag: "ok"; readonly value: ClaudeSdkVersionStatus }
  | { readonly _tag: "err"; readonly error: ClaudeSdkVersionInspectionFailure };

/** Dependencies used to inspect SDK and installed CLI versions. */
export interface ClaudeSdkVersionSources {
  /** Read the Agent SDK package metadata as JSON text. */
  readonly readSdkPackageMetadata: () => Promise<string>;
  /** Read `claude --version` output. */
  readonly readInstalledClaudeVersion: () => Promise<string>;
}

function parseSemanticVersion(input: string): SemanticVersion | undefined {
  const match = SEMANTIC_VERSION.exec(input);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch };
}

function isNewer(candidate: SemanticVersion, baseline: SemanticVersion): boolean {
  if (candidate.major !== baseline.major) return candidate.major > baseline.major;
  if (candidate.minor !== baseline.minor) return candidate.minor > baseline.minor;
  return candidate.patch > baseline.patch;
}

function defaultReadSdkPackageMetadata(): Promise<string> {
  const sdkEntryUrl = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
  return readFile(new URL("./package.json", sdkEntryUrl), "utf8");
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

async function defaultReadInstalledClaudeVersion(): Promise<string> {
  const result = await execFileAsync("claude", ["--version"], {
    encoding: "utf8",
    timeout: 3_000,
  });
  return String(result.stdout).trim();
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
  } catch (cause) {
    return { _tag: "err", error: new ClaudeSdkVersionInspectionError("read-sdk-metadata", cause) };
  }

  const metadata = sdkPackageMetadataSchema.safeParse(parseJson(metadataText));
  if (!metadata.success) {
    return { _tag: "err", error: new ClaudeSdkVersionInspectionError("read-sdk-metadata") };
  }

  let installedOutput: string;
  try {
    installedOutput = await sources.readInstalledClaudeVersion();
  } catch (cause) {
    return {
      _tag: "err",
      error: new ClaudeSdkVersionInspectionError("read-installed-version", cause),
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
      installedClaudeCode: `${installed.major}.${installed.minor}.${installed.patch}`,
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
