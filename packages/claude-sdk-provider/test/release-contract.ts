import { readFile } from "node:fs/promises";
import { Schema } from "effect";

/** The Agent SDK package whose installed version the release contract tracks. */
export const AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** Contracts the live gate verifies, in attestation order. */
export const LIVE_CONTRACTS = ["text-response", "deferred-tool-call", "advertised-models"] as const;

/** One contract the live gate verifies. */
export type LiveContract = (typeof LIVE_CONTRACTS)[number];

/** Result fields through which the SDK has reported a deferred tool call. */
const DEFERRED_RESULTS = ["stop_reason:tool_deferred", "terminal_reason:tool_deferred"] as const;

/** How a live SDK result reported the deferred tool call. */
export type DeferredResult = (typeof DEFERRED_RESULTS)[number];

/** Location of the attestation the live gate writes and ordinary CI checks. */
export const RELEASE_CONTRACT_URL = new URL("../sdk-release-contract.json", import.meta.url);

// zod's z.iso.datetime() shape: UTC with required seconds. Unlike zod, this does not check
// calendar validity, which the attestation writer (Date#toISOString) guarantees anyway.
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

/** Shape of `sdk-release-contract.json`. */
const releaseContractSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  agentSdkVersion: Schema.String,
  bundledClaudeCodeVersion: Schema.String,
  verifiedAt: Schema.String.check(Schema.isPattern(UTC_DATE_TIME)),
  model: Schema.Literal("fable"),
  contracts: Schema.Tuple([
    Schema.Literal("text-response"),
    Schema.Literal("deferred-tool-call"),
    Schema.Literal("advertised-models"),
  ]),
  observedDeferredResult: Schema.Literals(DEFERRED_RESULTS),
});

/** A validated release attestation. */
export type ReleaseContract = typeof releaseContractSchema.Type;

/** Decode an untrusted attestation, throwing when it does not match the release contract shape. */
export const decodeReleaseContract = Schema.decodeUnknownSync(releaseContractSchema);

const sdkMetadataSchema = Schema.Struct({
  version: Schema.String,
  claudeCodeVersion: Schema.String,
});
const decodeSdkMetadata = Schema.decodeUnknownSync(sdkMetadataSchema);

/**
 * Parse a JSON file.
 *
 * @param url - File to read.
 * @returns The untrusted parsed value.
 */
export async function readJson(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}

/**
 * Read the version metadata of the Agent SDK that Node resolves for this package.
 *
 * @returns The installed SDK version and the Claude Code version it bundles.
 */
export async function readInstalledSdk(): Promise<typeof sdkMetadataSchema.Type> {
  const sdkEntry = import.meta.resolve(AGENT_SDK_PACKAGE);
  return decodeSdkMetadata(await readJson(new URL("package.json", sdkEntry)));
}

/**
 * Serialize an attestation the way Oxfmt formats it: one key per line, short arrays inline.
 *
 * @param contract - Validated attestation.
 * @returns File content ending in a newline.
 */
export function formatReleaseContract(contract: ReleaseContract): string {
  const lines = Object.entries(contract).map(([key, value]) => {
    const json = Array.isArray(value)
      ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
      : JSON.stringify(value);
    return `  ${JSON.stringify(key)}: ${json}`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}
