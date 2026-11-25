import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import { Context, Effect, Layer, Predicate, Schema } from "effect";
import {
  isBelowMinimumClaudeCode,
  MIN_CLAUDE_CODE_VERSION,
  resolveClaudeExecutable,
} from "./sdk/claude-executable";

const execFileAsync = promisify(execFile);

const SEMANTIC_VERSION = /(?:^|\D)(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:\D|$)/u;

const decodeSdkPackageMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.String, claudeCodeVersion: Schema.String }),
  ),
);

type SemanticVersion = readonly [major: number, minor: number, patch: number];

export type ClaudeSdkVersionStatus = {
  readonly agentSdk: string;
  readonly expectedClaudeCode: string;
  readonly claudePath: string | undefined;
  readonly minimumClaudeCode: string;
  readonly belowMinimum: boolean;
  readonly installedClaudeCode: string;
  readonly updateSuggested: boolean;
};

const InstalledVersionFailure = Schema.Literals(["not-installed", "timed-out", "failed"]);

type InstalledVersionFailure = typeof InstalledVersionFailure.Type;

const INSTALLED_VERSION_TIMEOUT_MS = 3000;

const INSTALLED_VERSION_MESSAGES: Readonly<Record<InstalledVersionFailure, string>> = {
  "not-installed": "Claude Code (`claude`) was not found. Install it or set `PI_CLAUDE_PATH`.",
  "timed-out": `\`claude --version\` did not answer within ${INSTALLED_VERSION_TIMEOUT_MS / 1000}s. Check that \`claude\` starts.`,
  failed: "`claude --version` failed. Check that `claude` starts.",
};

class ClaudeSdkMetadataError extends Schema.TaggedError<ClaudeSdkMetadataError>()(
  "ClaudeSdkMetadataError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Could not read the Claude Agent SDK package version. Reinstall pi-claude.";
  }
}

class ClaudeInstalledVersionError extends Schema.TaggedError<ClaudeInstalledVersionError>()(
  "ClaudeInstalledVersionError",
  {
    reason: InstalledVersionFailure,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return INSTALLED_VERSION_MESSAGES[this.reason];
  }
}

class ClaudeVersionParseError extends Schema.TaggedError<ClaudeVersionParseError>()(
  "ClaudeVersionParseError",
  {
    source: Schema.Literals(["expected", "installed"]),
    output: Schema.String,
  },
) {
  override get message(): string {
    return this.source === "installed"
      ? "`claude --version` printed an unexpected format. Run `claude update`."
      : "pi-claude's Agent SDK lists a Claude Code version it cannot read. Reinstall pi-claude.";
  }
}

export type ClaudeSdkVersionReads = {
  readonly readSdkPackageMetadata: () => Promise<string>;
  readonly readInstalledClaudeVersion: () => Promise<string>;
  readonly readClaudePath?: () => string | undefined;
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
  const path = resolveClaudeExecutable(process.env);

  if (path === undefined) {
    throw Object.assign(new Error("claude not found"), { code: "ENOENT" });
  }

  const { stdout } = await execFileAsync(path, ["--version"], {
    encoding: "utf8",
    timeout: INSTALLED_VERSION_TIMEOUT_MS,
  });

  return stdout.trim();
}

function classifyInstalledVersionFailure(cause: unknown): InstalledVersionFailure {
  if (cause instanceof Error && Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") {
    return "not-installed";
  }

  if (cause instanceof Error && Predicate.hasProperty(cause, "killed") && cause.killed === true) {
    return "timed-out";
  }

  return "failed";
}

export class ClaudeSdkVersionSources extends Context.Service<
  ClaudeSdkVersionSources,
  {
    readonly readSdkPackageMetadata: () => Effect.Effect<string, ClaudeSdkMetadataError>;
    readonly readInstalledClaudeVersion: () => Effect.Effect<string, ClaudeInstalledVersionError>;
    readonly claudePath: () => string | undefined;
  }
>()("pi-claude/sdk-version-status/ClaudeSdkVersionSources") {
  static fromReads(reads: ClaudeSdkVersionReads): Layer.Layer<ClaudeSdkVersionSources> {
    return Layer.succeed(
      ClaudeSdkVersionSources,
      ClaudeSdkVersionSources.of({
        claudePath: () => reads.readClaudePath?.(),
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

  static readonly layer: Layer.Layer<ClaudeSdkVersionSources> = ClaudeSdkVersionSources.fromReads({
    readSdkPackageMetadata: defaultReadSdkPackageMetadata,
    readInstalledClaudeVersion: defaultReadInstalledClaudeVersion,
    readClaudePath: () => resolveClaudeExecutable(process.env),
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

export const inspectClaudeSdkVersions = Effect.fn("inspectClaudeSdkVersions")(function* () {
  const sources = yield* ClaudeSdkVersionSources;
  const metadataText = yield* sources.readSdkPackageMetadata();

  const metadata = yield* decodeSdkPackageMetadata(metadataText).pipe(
    Effect.mapError((cause) => new ClaudeSdkMetadataError({ cause })),
  );

  const installedOutput = yield* sources.readInstalledClaudeVersion();
  const bundled = yield* parseVersion("expected", metadata.claudeCodeVersion);
  const installed = yield* parseVersion("installed", installedOutput);

  return {
    agentSdk: metadata.version,
    expectedClaudeCode: metadata.claudeCodeVersion,
    claudePath: sources.claudePath(),
    minimumClaudeCode: MIN_CLAUDE_CODE_VERSION,
    belowMinimum: isBelowMinimumClaudeCode(installed.join(".")),
    installedClaudeCode: installed.join("."),
    updateSuggested: isNewer(installed, bundled),
  } satisfies ClaudeSdkVersionStatus;
});

export function formatClaudeSdkVersionStatus(status: ClaudeSdkVersionStatus): string {
  return [
    `Agent SDK: ${status.agentSdk}`,
    `Claude Code path: ${status.claudePath ?? "not found"}`,
    `Installed Claude Code: ${status.installedClaudeCode} (minimum ${status.minimumClaudeCode})`,
    `Claude Code expected by the Agent SDK: ${status.expectedClaudeCode}`,
    ...(status.belowMinimum ? ["Claude Code is too old: run `claude update`."] : []),
    status.updateSuggested
      ? "The installed Claude Code is newer. Update the pinned Agent SDK and npmDepsHash."
      : "The Agent SDK bundle is not older than the installed Claude Code.",
  ].join("\n");
}
