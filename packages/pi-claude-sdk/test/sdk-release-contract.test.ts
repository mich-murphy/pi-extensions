import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";
import { isBelowMinimumClaudeCode } from "../sdk/claude-executable";
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
        claudeCodeAtLeastMinimum: !isBelowMinimumClaudeCode(attestation.claudeCodeVersion),
      },
      "sdk-release-contract.json must attest the installed SDK. Run `npm run test:claude-sdk-upgrade`; the live gate rewrites it once every contract passes.",
    ).toStrictEqual({
      agentSdkVersion: installed.version,
      claudeCodeAtLeastMinimum: true,
    });
  });

  test("overrides every SDK platform binary with the empty stub", async () => {
    const root = Schema.decodeUnknownSync(
      Schema.Struct({ overrides: Schema.Record(Schema.String, Schema.String) }),
    )(await readJson(new URL("../../../package.json", import.meta.url)));
    const lock = Schema.decodeUnknownSync(
      Schema.Struct({
        packages: Schema.Record(
          Schema.String,
          Schema.Struct({
            link: Schema.optional(Schema.Boolean),
            optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          }),
        ),
      }),
    )(await readJson(new URL("../../../package-lock.json", import.meta.url)));
    const sdkEntry = Schema.decodeUnknownSync(
      Schema.Struct({ optionalDependencies: Schema.Record(Schema.String, Schema.String) }),
    )(lock.packages[`node_modules/${AGENT_SDK_PACKAGE}`]);
    const platforms = Object.keys(sdkEntry.optionalDependencies);
    const stub = "file:./packages/pi-claude-sdk/vendor/no-bundled-claude";

    expect(platforms).toHaveLength(8);
    expect(
      platforms.map((name) => [
        name,
        root.overrides[name],
        lock.packages[`node_modules/${name}`]?.link,
      ]),
    ).toStrictEqual(platforms.map((name) => [name, stub, true]));
  });

  test("keeps the attestation in the format the live gate writes", async () => {
    const attestation = decodeReleaseContract(await readJson(RELEASE_CONTRACT_URL));

    await expect(readFile(RELEASE_CONTRACT_URL, "utf8")).resolves.toBe(
      formatReleaseContract(attestation),
    );
  });
});
