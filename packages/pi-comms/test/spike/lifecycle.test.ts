import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execute = promisify(execFile);

describe("bounded public-Pi offline lifecycle spike", () => {
  test("executes isolated pinned CLI RPC and native terminal journeys", async () => {
    const result = await execute(
      "python3",
      [fileURLToPath(new URL("./offline.py", import.meta.url))],
      {
        env: {
          ...process.env,
          PI_SPIKE_EXTENSION: fileURLToPath(import.meta.resolve("./extension.ts")),
          RAYON_NUM_THREADS: "2",
          UV_THREADPOOL_SIZE: "2",
          GOMAXPROCS: "2",
        },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Ran 7 tests");
    expect(result.stderr.trim()).toMatch(/OK$/u);
  }, 65_000);
  test("executes the production adapter against isolated transport through real pinned Pi", async () => {
    const result = await execute(
      "python3",
      [fileURLToPath(new URL("./production.py", import.meta.url))],
      {
        env: { ...process.env, RAYON_NUM_THREADS: "2", UV_THREADPOOL_SIZE: "2", GOMAXPROCS: "2" },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Ran 2 tests");
    expect(result.stderr.trim()).toMatch(/OK$/u);
  }, 65_000);
});
