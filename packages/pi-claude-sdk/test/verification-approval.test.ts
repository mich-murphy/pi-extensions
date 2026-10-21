import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const helper = resolve(".agents/skills/verify-pi-claude-sdk/scripts/verify.py");

describe("verification model-prompt approval gate (offline)", () => {
  test.each(["all", "live", "recovery"])(
    "%s without approval exits before any provider process",
    async (action) => {
      const evidence = await mkdtemp("/tmp/pi-sdk-approval-test-");
      const run = (operation: string) =>
        spawnSync("python3", [helper, operation, "--evidence", evidence], { encoding: "utf8" });
      try {
        expect(run("launch").status).toBe(0);
        const result = run(action);
        expect(result.status).toBe(2);
        expect(result.stdout).toContain("BLOCKED recovery-approval");
        const files = await readdir(evidence);
        // run()/RPC must not have started anything, even the later all/cache branch.
        expect(files.filter((file) => /\.(?:command\.json|pid)$/u.test(file))).toStrictEqual([]);
        expect(files).toContain(`${action}-results.json`);
      } finally {
        expect(run("cleanup").status).toBe(0);
        await rm(evidence, { recursive: true, force: true });
      }
    },
  );
});
