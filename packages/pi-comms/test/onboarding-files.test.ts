import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { syncDirectory } from "../onboarding/files.js";

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../..");
const filesSource = path.resolve(import.meta.dirname, "../onboarding/files.ts");
/** Owned child: imports the real files.ts through jiti and reports one syncDirectory outcome. */
const childScript = `
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { syncDirectory } = await jiti.import(process.argv[1]);
try {
  await syncDirectory(process.argv[2]);
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
}
`;
const roots: string[] = [];
async function fixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "pi-files-test-"));
  roots.push(root);
  return root;
}

describe("syncDirectory", () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("syncs a real directory", async () => {
    const root = await fixtureRoot();
    await expect(syncDirectory(root)).resolves.toBeUndefined();
  });

  test("refuses a regular file and a symlink without following it", async () => {
    const root = await fixtureRoot();
    const file = path.join(root, "file");
    await fs.writeFile(file, "x", { mode: 0o600 });
    await expect(syncDirectory(file)).rejects.toThrow("Expected directory");
    const link = path.join(root, "link");
    await fs.symlink(root, link);
    await expect(syncDirectory(link)).rejects.toMatchObject({ code: "ELOOP" });
  });

  // A blocking open of a FIFO never returns, so the real call runs in an owned, time-bounded Node
  // child rather than this worker. Without O_NONBLOCK the child is killed and the test fails.
  test("rejects a named FIFO without blocking", { timeout: 30_000 }, async () => {
    const root = await fixtureRoot();
    const fifo = path.join(root, "fifo");
    await run("/usr/bin/mkfifo", ["-m", "600", fifo], { timeout: 5000 });
    const { stdout } = await run(
      process.execPath,
      ["--input-type=module", "-e", childScript, filesSource, fifo],
      { cwd: repository, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 65_536 },
    );
    expect(JSON.parse(stdout)).toStrictEqual({ error: "Expected directory" });
    const stat = await fs.lstat(fifo);
    expect(stat.isFIFO()).toBe(true);
  });
});
