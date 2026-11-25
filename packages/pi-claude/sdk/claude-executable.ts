import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";
import { Option, Schema } from "effect";
import { claudeVariable } from "../environment-variables";

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

export function isBelowMinimumClaudeCode(version: string): boolean {
  const actual = parseVersion(version);
  const minimum = parseVersion(MIN_CLAUDE_CODE_VERSION);
  if (actual === undefined || minimum === undefined) {
    return false;
  }
  const difference = actual.map((part, index) => part - (minimum[index] ?? 0));
  return (difference.find((part) => part !== 0) ?? 0) < 0;
}

const decodeInit = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("system"),
    subtype: Schema.Literal("init"),
    claude_code_version: Schema.String,
  }),
);

export function tooOldClaudeCode(
  message:
    | {
        readonly type: string;
        readonly subtype?: unknown;
        readonly claude_code_version?: unknown;
      }
    | null
    | undefined,
): string | undefined {
  const init = Option.getOrUndefined(decodeInit(message));
  const version = init?.claude_code_version;
  return version !== undefined && isBelowMinimumClaudeCode(version) ? version : undefined;
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

export function resolveClaudeExecutable(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const override = claudeVariable(env, "PI_CLAUDE_PATH")?.trim() ?? "";
  if (override !== "") {
    return isExecutableFile(override, platform) ? override : undefined;
  }
  const names = executableNames(env, platform);
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)))
    .find((candidate) => isExecutableFile(candidate, platform));
}

function executableNames(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== "win32") {
    return ["claude"];
  }
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => `claude${extension.toLowerCase()}`);
}
