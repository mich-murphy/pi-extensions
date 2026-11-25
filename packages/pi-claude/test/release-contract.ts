import { readFile } from "node:fs/promises";
import { Schema } from "effect";

export const AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

export const LIVE_CONTRACTS = ["text-response", "deferred-tool-call", "advertised-models"] as const;

export type LiveContract = (typeof LIVE_CONTRACTS)[number];

const DEFERRED_RESULTS = ["stop_reason:tool_deferred", "terminal_reason:tool_deferred"] as const;

export type DeferredResult = (typeof DEFERRED_RESULTS)[number];

export const RELEASE_CONTRACT_URL = new URL("../sdk-release-contract.json", import.meta.url);

const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

const releaseContractSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  agentSdkVersion: Schema.String,
  claudeCodeVersion: Schema.String,
  verifiedAt: Schema.String.check(Schema.isPattern(UTC_DATE_TIME)),
  model: Schema.Literal("fable"),
  contracts: Schema.Tuple([
    Schema.Literal("text-response"),
    Schema.Literal("deferred-tool-call"),
    Schema.Literal("advertised-models"),
  ]),
  observedDeferredResult: Schema.Literals(DEFERRED_RESULTS),
});

export type ReleaseContract = typeof releaseContractSchema.Type;

export const decodeReleaseContract = Schema.decodeUnknownSync(releaseContractSchema);

const sdkMetadataSchema = Schema.Struct({
  version: Schema.String,
  claudeCodeVersion: Schema.String,
});

const decodeSdkMetadata = Schema.decodeUnknownSync(sdkMetadataSchema);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export async function readJson(url: URL): Promise<Schema.Json> {
  return decodeJson(await readFile(url, "utf8"));
}

export async function readInstalledSdk(): Promise<typeof sdkMetadataSchema.Type> {
  const sdkEntry = import.meta.resolve(AGENT_SDK_PACKAGE);

  return decodeSdkMetadata(await readJson(new URL("package.json", sdkEntry)));
}

export function formatReleaseContract(contract: ReleaseContract): string {
  const lines = Object.entries(contract).map(([key, value]) => {
    const json = Array.isArray(value)
      ? `[${value.map((item) => JSON.stringify(item)).join(", ")}]`
      : JSON.stringify(value);

    return `  ${JSON.stringify(key)}: ${json}`;
  });

  return `{\n${lines.join(",\n")}\n}\n`;
}
