import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { doctor, doctorReport, doctorRowText } from "../onboarding/doctor.js";

const directories: string[] = [];
async function fixture(content?: string) {
  const directory = await mkdtemp(join(tmpdir(), "pi-peers-doctor-"));
  directories.push(directory);
  const path = join(directory, "pi-peers.json");
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
    expect(result).toContain("/peers reconnect");
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

const internal =
  /nonce|generation|receipt|operation|relation|guarded|registration|\bCAS\b|ledger|floor|projection|snapshot/iu;
function valid(directory: string): string {
  return JSON.stringify({
    machineId: "host",
    socketPath: join(directory, "absent.sock"),
    scopeIds: ["local"],
    label: "Pi",
    policies: [
      {
        machineId: "host",
        scopeId: "local",
        permissions: ["discover", "read", "push", "interest"],
      },
    ],
  });
}
describe("plain-language doctor report", () => {
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map(async (directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  const writers: Record<string, (directory: string, path: string) => Promise<void>> = {
    missing: async () => undefined,
    "invalid JSON": async (_directory, path) => writeFile(path, "{"),
    "invalid fields": async (_directory, path) =>
      writeFile(path, JSON.stringify({ machineId: "X" })),
    oversized: async (_directory, path) => writeFile(path, "x".repeat(32_769)),
    valid: async (directory, path) => writeFile(path, valid(directory)),
  };
  test.each(Object.keys(writers))(
    "%s: rows are plain, problems say what to do, details stay technical",
    async (name) => {
      const { directory, path } = await fixture();
      await writers[name]?.(directory, path);
      const report = await doctorReport(directory);
      expect(report.rows.length).toBeGreaterThan(0);
      for (const row of report.rows) {
        expect(`${row.label} ${row.value}`).not.toMatch(internal);
      }
      for (const row of report.rows.filter((entry) => entry.level !== "ok")) {
        expect(row.value).toMatch(/\/peers|Fix|Check|Move|Shrink/u);
        expect(row.value.split(/[.!?](?:\s|$)/u).filter(Boolean).length).toBeLessThanOrEqual(3);
      }
      expect(report.next).toBeDefined();
      expect(report.next).not.toMatch(internal);
      expect(report.technical.length).toBeGreaterThan(0);
      const text = await doctor(directory);
      expect(text.indexOf("Technical details:")).toBeGreaterThan(0);
    },
  );
  test("valid config with a stopped gateway warns but is not an error", async () => {
    const { directory, path } = await fixture();
    await writeFile(path, valid(directory));
    const report = await doctorReport(directory);
    expect(report.ok).toBe(true);
    expect(report.rows.find((row) => row.label === "Gateway")).toMatchObject({
      level: "warn",
    });
    expect(report.rows.find((row) => row.label === "Permissions")).toMatchObject({ level: "ok" });
    expect(report.next).toContain("first item marked");
  });
  test("broken config is not ok and leaves bytes unchanged", async () => {
    const { directory, path } = await fixture("{");
    const report = await doctorReport(directory);
    expect(report.ok).toBe(false);
    expect(report.rows[0]).toMatchObject({
      label: "Config file",
      level: "error",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("{");
  });
  test("in the menu, setup steps say Choose Setup; notify keeps /peers setup", async () => {
    const { directory } = await fixture();
    const menu = await doctorReport(directory, { inMenu: true });
    const notify = await doctorReport(directory);
    const config = (report: typeof menu) =>
      report.rows.filter((row) => row.label === "Config file").map((row) => row.value);
    expect(config(menu).join("\n")).toContain("Choose Setup to create it.");
    expect(config(notify).join("\n")).toContain("Run /peers setup to create it.");
    for (const row of menu.rows) {
      expect(row.value).not.toContain("/peers setup");
      expect(row.value).not.toContain("Open /peers");
    }
  });
  test("doctorRowText renders the level mark, label and value", async () => {
    expect(doctorRowText({ label: "Gateway", value: "Socket found", level: "ok" })).toBe(
      "✓ Gateway: Socket found",
    );
    expect(doctorRowText({ label: "Pairing", value: "Expires soon", level: "warn" })).toBe(
      "! Pairing: Expires soon",
    );
    expect(doctorRowText({ label: "Config file", value: "Bad", level: "error" })).toBe(
      "✗ Config file: Bad",
    );
    const { directory } = await fixture();
    const report = await doctorReport(directory);
    const text = await doctor(directory);
    for (const row of report.rows) {
      expect(text).toContain(doctorRowText(row));
    }
  });
});
