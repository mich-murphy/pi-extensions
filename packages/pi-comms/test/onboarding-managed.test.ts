import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyLocal, setupPaths } from "../onboarding/backend.js";
import { diagnoseManaged, managedLauncher } from "../onboarding/managed.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import { nativeFixture, nativeUntil } from "./onboarding-fixtures.js";

function demand(mode: "abort" | "deadline") {
  const controller = new AbortController();
  const timer =
    mode === "abort"
      ? setTimeout(() => {
          controller.abort();
        }, 50)
      : undefined;
  return { controller, timer, deadline: performance.now() + (mode === "deadline" ? 50 : 2000) };
}
describe("managed startup remains demand-owned across readonly version/filesystem awaits", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
  });
  afterEach(async () => {
    await nativeUntil(async () => !existsSync(setupPaths(join(fixture.root, "agent")).socket));
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });
  test("actual native diagnose reports disabled without starting a gateway or rewriting config", async () => {
    const agent = join(fixture.root, "agent");
    const selected = localPlan(defaultChoices("Diagnose"), setupPaths(agent).socket);
    const setup = await applyLocal(
      agent,
      selected,
      { acquire: async () => fixture.executable },
      () => undefined,
    );
    const before = await readFile(setup.gatewayPath);
    const entries = await readdir(setupPaths(agent).directory);
    await expect(diagnoseManaged(setup)).resolves.toContain("Remote config snapshot: disabled");
    expect(existsSync(setup.socketPath)).toBe(false);
    await expect(readFile(setup.gatewayPath)).resolves.toStrictEqual(before);
    await expect(readdir(setupPaths(agent).directory)).resolves.toStrictEqual(entries);
  });
  test.each([
    { version: 2, remote: { state: "disabled" } },
    { version: 1, remote: { state: "unknown" } },
    { version: 1, remote: { state: "degraded", reason: "bad reason" } },
  ])("rejects incompatible readonly diagnostic output %j", async (response) => {
    const agent = join(fixture.root, "agent");
    const selected = localPlan(defaultChoices("Diagnose"), setupPaths(agent).socket);
    const setup = await applyLocal(
      agent,
      selected,
      { acquire: async () => fixture.executable },
      () => undefined,
    );
    const executable = join(fixture.root, "diagnostic-output-fixture");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(JSON.stringify(response))}\n`,
      { mode: 0o500 },
    );
    await expect(diagnoseManaged({ ...setup, executable })).rejects.toThrow(
      "Native diagnostic contract mismatch",
    );
    expect(existsSync(setup.socketPath)).toBe(false);
  });
  test.each(["abort", "deadline"] as const)(
    "%s during delayed real --version leaves no log or gateway/socket spawn",
    async (mode) => {
      const agent = join(fixture.root, "agent");
      const marker = join(fixture.root, "UNEXPECTED-GATEWAY-SPAWN");
      const wrapper = join(fixture.root, "delayed-version");
      await writeFile(
        wrapper,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then /bin/sleep 0.15; fi\nif [ "$1" = "--managed" ]; then printf unexpected > ${JSON.stringify(marker)}; fi\nexec ${JSON.stringify(fixture.executable)} "$@"\n`,
        { mode: 0o500 },
      );
      const plan = localPlan(defaultChoices("Managed"), setupPaths(agent).socket);
      const setup = await applyLocal(
        agent,
        plan,
        { acquire: async () => wrapper },
        () => undefined,
      );
      const before = await readdir(setupPaths(agent).directory);
      const gateway = await readFile(setup.gatewayPath);
      const active = demand(mode);
      const started = performance.now();
      try {
        await expect(
          managedLauncher(setup)(active.deadline, active.controller.signal),
        ).rejects.toThrow("Gateway startup cancelled");
      } finally {
        clearTimeout(active.timer);
      }
      expect(performance.now() - started).toBeGreaterThanOrEqual(125);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(setup.socketPath)).toBe(false);
      await expect(readdir(setupPaths(agent).directory)).resolves.toStrictEqual(before);
      await expect(readFile(setup.gatewayPath)).resolves.toStrictEqual(gateway);
    },
  );
});
