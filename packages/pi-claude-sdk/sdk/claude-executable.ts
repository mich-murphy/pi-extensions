import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";

/** Environment variable that points at the Claude Code executable to run. */
const CLAUDE_PATH_VARIABLE = "PI_CLAUDE_SDK_CLAUDE_PATH";

/**
 * Oldest Claude Code this provider supports. 2.1.317 is the first release that answers the
 * initialize request with `hook_on_failure_supported` (absent in 2.1.316), which the Agent SDK
 * 0.3.317 requires for `onFailure: "block"` hooks; `verbatimPrompts` needs only 2.1.248.
 */
export const MIN_CLAUDE_CODE_VERSION = "2.1.317";

type Version = readonly [number, number, number];

function parseVersion(input: string): Version | undefined {
  const parts = /(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(input);
  if (parts === null) {
    return undefined;
  }
  const { major, minor, patch } = parts.groups ?? {};
  const version = [Number(major), Number(minor), Number(patch)] as const;
  return version.every((part) => Number.isSafeInteger(part)) ? version : undefined;
}

/**
 * Whether a Claude Code version is older than the supported minimum.
 *
 * @param version - Version text such as `2.1.316 (Claude Code)`.
 * @returns True only for a parseable version below the minimum.
 */
export function isBelowMinimumClaudeCode(version: string): boolean {
  const actual = parseVersion(version);
  const minimum = parseVersion(MIN_CLAUDE_CODE_VERSION);
  if (actual === undefined || minimum === undefined) {
    return false;
  }
  const difference = actual.map((part, index) => part - (minimum[index] ?? 0));
  return (difference.find((part) => part !== 0) ?? 0) < 0;
}

/**
 * Read the CLI version from a raw SDK system/init message and report it when too old.
 *
 * @param message - Raw SDK message.
 * @returns The reported version when it is below the minimum, otherwise undefined.
 */
export function tooOldClaudeCode(message: unknown): string | undefined {
  if (
    typeof message !== "object" ||
    message === null ||
    Reflect.get(message, "type") !== "system" ||
    Reflect.get(message, "subtype") !== "init"
  ) {
    return undefined;
  }
  const version: unknown = Reflect.get(message, "claude_code_version");
  return typeof version === "string" && isBelowMinimumClaudeCode(version) ? version : undefined;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (platform !== "win32") {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the user's installed Claude Code. Never falls back to the SDK's bundled binary.
 * Supported on darwin and linux; Windows is best effort (PATHEXT names only, no .cmd shims).
 *
 * @param env - Environment holding `PI_CLAUDE_SDK_CLAUDE_PATH` and `PATH`.
 * @param platform - Platform whose path rules apply.
 * @returns The executable path, or undefined when none is found. An override that is not an
 * executable file yields undefined rather than a PATH search.
 */
export function resolveClaudeExecutable(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const override = env[CLAUDE_PATH_VARIABLE]?.trim();
  if (override !== undefined && override !== "") {
    return isExecutableFile(override, platform) ? override : undefined;
  }
  const names =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((extension) => `claude${extension.toLowerCase()}`)
      : ["claude"];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    for (const name of directory ? names : []) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate, platform)) {
        return candidate;
      }
    }
  }
  return undefined;
}
