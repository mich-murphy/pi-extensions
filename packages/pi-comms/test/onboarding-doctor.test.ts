import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { doctor } from "../onboarding/doctor.js";

const directories: string[] = [];
async function fixture(content?: string) {
  const directory = await mkdtemp(join(tmpdir(), "pi-comms-doctor-"));
  directories.push(directory);
  const path = join(directory, "session-communication.json");
  if (content !== undefined) {
    await writeFile(path, content);
  }
  return { directory, path };
}
describe("read-only doctor", () => {
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map(async (directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  test("missing and malformed config give exact path/action without mutation", async () => {
    const { directory, path } = await fixture();
    await expect(doctor(directory)).resolves.toContain(path);
    await writeFile(path, "secret-invalid-json");
    const result = await doctor(directory);
    expect(result).toContain("invalid JSON");
    expect(result).not.toContain("secret-invalid-json");
    await expect(readFile(path, "utf8")).resolves.toBe("secret-invalid-json");
  });
  test("field diagnostics name invalid fields, not authored values", async () => {
    const content = JSON.stringify({
      machineId: "SECRET INVALID",
      socketPath: "relative",
      scopeIds: [],
      label: "",
      policies: [],
      secretUnknown: "private-value",
    });
    const { directory, path } = await fixture(content);
    const result = await doctor(directory);
    expect(result).toContain("machineId, socketPath, scopeIds, label, unknown keys");
    expect(result).not.toContain("SECRET INVALID");
    expect(result).not.toContain("private-value");
    await expect(readFile(path, "utf8")).resolves.toBe(content);
  });
  test("valid/down socket is not misreported as ready or connected", async () => {
    const { directory, path } = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        machineId: "host",
        socketPath: join(directory, "absent.sock"),
        scopeIds: ["local"],
        label: "Pi",
        policies: [],
      }),
    );
    const result = await doctor(directory);
    expect(result).toContain("Configuration: valid");
    expect(result).toContain("absent or inaccessible");
    expect(result).toContain("/comms reconnect");
    expect(result).toContain("may be intentional");
    expect(result).toContain("loses inbox/publications/interests/receipts");
  });
  test("the shared adapter/doctor socket limit is 100 UTF-8 bytes", async () => {
    const { directory, path } = await fixture();
    const config = {
      machineId: "host",
      socketPath: `/${"a".repeat(99)}`,
      scopeIds: ["local"],
      label: "Pi",
      policies: [],
    };
    await writeFile(path, JSON.stringify(config));
    await expect(doctor(directory)).resolves.toContain("Configuration: valid");
    await writeFile(path, JSON.stringify({ ...config, socketPath: `/${"é".repeat(50)}` }));
    await expect(doctor(directory)).resolves.toContain("invalid fields: socketPath");
  });
  test("oversized configurations fail closed and valid symlinks are inspected read-only", async () => {
    const { directory, path } = await fixture("x".repeat(32_769));
    const oversized = await doctor(directory);
    expect(oversized).toContain("exceeds 32 KiB");
    await rm(path);
    const target = join(directory, "store-config.json");
    await writeFile(
      target,
      JSON.stringify({
        machineId: "host",
        socketPath: join(directory, "missing.sock"),
        scopeIds: ["local"],
        label: "Pi",
        policies: [],
      }),
    );
    const before = await readFile(target);
    await symlink(target, path);
    const linked = await doctor(directory);
    expect(linked).toContain("Configuration: valid");
    await expect(readFile(target)).resolves.toStrictEqual(before);
    expect(linked).not.toContain("participation is off");
  });
});
