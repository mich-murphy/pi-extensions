import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import {
  AGENT_SDK_PACKAGE,
  decodeReleaseContract,
  formatReleaseContract,
  RELEASE_CONTRACT_URL,
  readInstalledSdk,
  readJson,
} from "./release-contract";

const decodePackage = Schema.decodeUnknownSync(
  Schema.Struct({ dependencies: Schema.Struct({ [AGENT_SDK_PACKAGE]: Schema.String }) }),
);
// Only each locked package's version is read, so its other keys may be stripped.
const decodeLock = Schema.decodeUnknownSync(
  Schema.Struct({
    packages: Schema.Record(
      Schema.String,
      Schema.Struct({ version: Schema.optional(Schema.String) }),
    ),
  }),
);

describe("claude SDK release contract", () => {
  test("pins, locks, and live-attests the installed SDK version", async () => {
    const installed = await readInstalledSdk();
    const packageMetadata = decodePackage(
      await readJson(new URL("../package.json", import.meta.url)),
    );
    const lock = decodeLock(await readJson(new URL("../../../package-lock.json", import.meta.url)));
    const attestation = decodeReleaseContract(await readJson(RELEASE_CONTRACT_URL));

    expect(packageMetadata.dependencies[AGENT_SDK_PACKAGE], "exact package.json pin").toBe(
      installed.version,
    );
    expect(lock.packages[`node_modules/${AGENT_SDK_PACKAGE}`]?.version, "lockfile").toBe(
      installed.version,
    );
    expect(
      {
        agentSdkVersion: attestation.agentSdkVersion,
        bundledClaudeCodeVersion: attestation.bundledClaudeCodeVersion,
      },
      "sdk-release-contract.json must attest the installed SDK. Run `npm run test:claude-sdk-upgrade`; the live gate rewrites it once every contract passes.",
    ).toStrictEqual({
      agentSdkVersion: installed.version,
      bundledClaudeCodeVersion: installed.claudeCodeVersion,
    });
  });

  test("keeps the attestation in the format the live gate writes", async () => {
    const attestation = decodeReleaseContract(await readJson(RELEASE_CONTRACT_URL));

    await expect(readFile(RELEASE_CONTRACT_URL, "utf8")).resolves.toBe(
      formatReleaseContract(attestation),
    );
  });
});
