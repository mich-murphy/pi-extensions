import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Context, Effect, Layer, Predicate, Schema } from "effect";

const execFileAsync = promisify(execFile);

const SEMANTIC_VERSION = /(?:^|\D)(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\D|$)/u;
const decodeSdkPackageMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.String, claudeCodeVersion: Schema.String }),
  ),
);

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

const InstalledVersionFailure = Schema.Literals(["not-installed", "timed-out", "failed"]);

/** Why `claude --version` could not be read. */
type InstalledVersionFailure = typeof InstalledVersionFailure.Type;

/** How long `claude --version` may run before it counts as unresponsive. */
const INSTALLED_VERSION_TIMEOUT_MS = 3000;

const INSTALLED_VERSION_MESSAGES: Readonly<Record<InstalledVersionFailure, string>> = {
  "not-installed": "Claude Code is not installed or not on PATH (claude --version failed)",
  "timed-out": `claude --version did not respond within ${INSTALLED_VERSION_TIMEOUT_MS / 1000}s`,
  failed: "claude --version failed",
};

/** Expected failure while reading the Agent SDK's package metadata. */
class ClaudeSdkMetadataError extends Schema.TaggedError<ClaudeSdkMetadataError>()(
  "ClaudeSdkMetadataError",
  {
    /** Unclassified underlying failure, retained for local debugging only. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Plain-English summary. */
  override get message(): string {
    return "Could not read the installed Claude Agent SDK package metadata";
  }
}

/** Expected failure while running `claude --version`. */
class ClaudeInstalledVersionError extends Schema.TaggedError<ClaudeInstalledVersionError>()(
  "ClaudeInstalledVersionError",
  {
    /** Classified failure. */
    reason: InstalledVersionFailure,
    /** Unclassified underlying failure, retained for local debugging only. */
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Plain-English summary of the classified failure. */
  override get message(): string {
    return INSTALLED_VERSION_MESSAGES[this.reason];
  }
}

/** Expected failure when a version string is not a semantic version. */
class ClaudeVersionParseError extends Schema.TaggedError<ClaudeVersionParseError>()(
  "ClaudeVersionParseError",
  {
    /** Which version could not be parsed. */
    source: Schema.Literals(["bundled", "installed"]),
    /** The unexpected text; only its bounded first line is rendered. */
    output: Schema.String,
  },
) {
  /** Plain-English summary quoting the bounded first line of the unexpected text. */
  override get message(): string {
    const firstLine = (this.output.split("\n", 1)[0] ?? "").trim().slice(0, 80);
    return this.source === "installed"
      ? `claude --version printed an unexpected version: "${firstLine}"`
      : `The Agent SDK reports an unexpected bundled Claude Code version: "${firstLine}"`;
  }
}

/** Raw process and filesystem reads behind {@link ClaudeSdkVersionSources}. */
export type ClaudeSdkVersionReads = {
  /** Read the Agent SDK package metadata as JSON text. */
  readonly readSdkPackageMetadata: () => Promise<string>;
  /** Read `claude --version` output; rejections are classified by their Node error shape. */
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

async function defaultReadInstalledClaudeVersion(): Promise<string> {
  const { stdout } = await execFileAsync("claude", ["--version"], {
    encoding: "utf8",
    timeout: INSTALLED_VERSION_TIMEOUT_MS,
  });
  return stdout.trim();
}

// execFile reports a missing binary as code ENOENT and its own timeout as a SIGTERM kill.
function classifyInstalledVersionFailure(cause: unknown): InstalledVersionFailure {
  if (cause instanceof Error && Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") {
    return "not-installed";
  }
  if (cause instanceof Error && Predicate.hasProperty(cause, "killed") && cause.killed === true) {
    return "timed-out";
  }
  return "failed";
}

/** Reads the Agent SDK metadata and installed Claude Code version as classified, typed failures. */
export class ClaudeSdkVersionSources extends Context.Service<
  ClaudeSdkVersionSources,
  {
    /** Read the Agent SDK package metadata as JSON text. */
    readonly readSdkPackageMetadata: () => Effect.Effect<string, ClaudeSdkMetadataError>;
    /** Read `claude --version` output. */
    readonly readInstalledClaudeVersion: () => Effect.Effect<string, ClaudeInstalledVersionError>;
  }
>()("pi-claude-sdk-provider/sdk-version-status/ClaudeSdkVersionSources") {
  /**
   * Build the service from raw reads, translating their rejections into typed errors.
   *
   * @param reads - Raw filesystem and process reads.
   * @returns A layer providing the sources.
   */
  static fromReads(reads: ClaudeSdkVersionReads): Layer.Layer<ClaudeSdkVersionSources> {
    return Layer.succeed(
      ClaudeSdkVersionSources,
      ClaudeSdkVersionSources.of({
        readSdkPackageMetadata: Effect.fn("ClaudeSdkVersionSources.readSdkPackageMetadata")(
          function* () {
            return yield* Effect.tryPromise({
              try: async () => reads.readSdkPackageMetadata(),
              catch: (cause) => new ClaudeSdkMetadataError({ cause }),
            });
          },
        ),
        readInstalledClaudeVersion: Effect.fn("ClaudeSdkVersionSources.readInstalledClaudeVersion")(
          function* () {
            return yield* Effect.tryPromise({
              try: async () => reads.readInstalledClaudeVersion(),
              catch: (cause) =>
                new ClaudeInstalledVersionError({
                  reason: classifyInstalledVersionFailure(cause),
                  cause,
                }),
            });
          },
        ),
      }),
    );
  }

  /** Live sources: the installed SDK's package.json and `claude --version` from PATH. */
  static readonly layer: Layer.Layer<ClaudeSdkVersionSources> = ClaudeSdkVersionSources.fromReads({
    readSdkPackageMetadata: defaultReadSdkPackageMetadata,
    readInstalledClaudeVersion: defaultReadInstalledClaudeVersion,
  });
}

function parseVersion(
  source: ClaudeVersionParseError["source"],
  output: string,
): Effect.Effect<SemanticVersion, ClaudeVersionParseError> {
  const version = parseSemanticVersion(output);
  return version === undefined
    ? Effect.fail(new ClaudeVersionParseError({ source, output }))
    : Effect.succeed(version);
}

/**
 * Inspect Agent SDK, bundled Claude Code, and installed Claude Code versions.
 *
 * @returns Parsed status, failing with a typed metadata, CLI, or parse error.
 */
export const inspectClaudeSdkVersions = Effect.fn("inspectClaudeSdkVersions")(function* () {
  const sources = yield* ClaudeSdkVersionSources;
  const metadataText = yield* sources.readSdkPackageMetadata();
  const metadata = yield* decodeSdkPackageMetadata(metadataText).pipe(
    Effect.mapError((cause) => new ClaudeSdkMetadataError({ cause })),
  );
  const installedOutput = yield* sources.readInstalledClaudeVersion();
  const bundled = yield* parseVersion("bundled", metadata.claudeCodeVersion);
  const installed = yield* parseVersion("installed", installedOutput);
  return {
    agentSdk: metadata.version,
    bundledClaudeCode: metadata.claudeCodeVersion,
    installedClaudeCode: installed.join("."),
    updateSuggested: isNewer(installed, bundled),
  } satisfies ClaudeSdkVersionStatus;
});

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
