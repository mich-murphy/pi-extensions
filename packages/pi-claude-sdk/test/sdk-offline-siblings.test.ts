import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { offlineContractPath } from "./offline-sdk-contract";

describe("production Pi loop through actual offline SDK", () => {
  test
    .skipIf(process.platform !== "darwin")
    .each(["siblings", "schema", "malformed", "cancelled", "invalid-terminal"])(
    "%s preserves execution ownership, durable recovery and one terminal per turn",
    async (scenario) => {
      const home = await mkdtemp(join(tmpdir(), "pi-sdk-contract-"));
      try {
        const profile = join(home, "network.sb");
        await writeFile(
          profile,
          '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))',
        );
        const result = spawnSync(
          "/usr/bin/sandbox-exec",
          [
            "-f",
            profile,
            process.execPath,
            resolve("node_modules/jiti/lib/jiti-cli.mjs"),
            offlineContractPath,
          ],
          {
            timeout: 40_000,
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              HOME: home,
              PI_OFFLINE: "1",
              PI_SKIP_VERSION_CHECK: "1",
              PI_TELEMETRY: "0",
              PI_SDK_OFFLINE_CHILD: "1",
              PI_SDK_OFFLINE_CASE: scenario,
            },
          },
        );
        expect(result.stderr).not.toContain("AssertionError");
        expect(result.stderr).not.toContain("Error:");
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ scenario, fallbackCalls: 0 });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
