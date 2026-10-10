import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AGENT_SDK_PACKAGE,
  formatReleaseContract,
  RELEASE_CONTRACT_URL,
  readInstalledSdk,
  readJson,
  releaseContractSchema,
} from "./release-contract";

const packageSchema = z.object({
  dependencies: z.object({ [AGENT_SDK_PACKAGE]: z.string() }),
});
const lockedPackageSchema = z.looseObject({ version: z.string().optional() });
const lockSchema = z.object({ packages: z.record(z.string(), lockedPackageSchema) });

describe("claude SDK release contract", () => {
  test("pins, locks, and live-attests the installed SDK version", async () => {
    const installed = await readInstalledSdk();
    const packageMetadata = packageSchema.parse(
      await readJson(new URL("../package.json", import.meta.url)),
    );
    const lock = lockSchema.parse(
      await readJson(new URL("../../../package-lock.json", import.meta.url)),
    );
    const attestation = releaseContractSchema.parse(await readJson(RELEASE_CONTRACT_URL));

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
    const attestation = releaseContractSchema.parse(await readJson(RELEASE_CONTRACT_URL));

    await expect(readFile(RELEASE_CONTRACT_URL, "utf8")).resolves.toBe(
      formatReleaseContract(attestation),
    );
  });
});
