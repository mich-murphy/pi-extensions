import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConfiguration } from "../adapter/config.js";
import { applyLocal, setupPaths } from "../onboarding/backend.js";
import type { DialogContext } from "../onboarding/dialog.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import { linkedPlan } from "../onboarding/remote.js";
import { decodeGateway, parseJson } from "../onboarding/schema.js";
import { setupCommand } from "../onboarding/setup.js";
import type { ActivatePlan } from "../onboarding/upgrade.js";
import { dialog, nativeFixture, nativeUntil, tailscaleFixture } from "./onboarding-fixtures.js";

describe("fresh Review details and the Manage form's edit Apply", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let agent: string;
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "agent");
  });
  afterEach(async () => {
    await nativeUntil(async () => !existsSync(setupPaths(agent).socket));
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("Review details discloses every effect before Apply; an edited Label is saved and activated", async () => {
    const supplied = {
      backend: { acquire: async () => fixture.executable },
      description: "TEST immutable native helper",
    };

    const activate = vi.fn<ActivatePlan>();
    const fresh = dialog(["Review details", "Back", "APPLY"]);
    await setupCommand(agent, fresh, activate, supplied);
    const paths = setupPaths(agent);

    const review = vi
      .mocked(fresh.ui.select)
      .mock.calls.map(([title]) => title)
      .find((title) => title.includes("Private files:"));

    expect(review).toBeDefined();
    const lines = String(review).split("\n");
    expect(lines).toContain("TEST immutable native helper");
    expect(lines).toContainEqual(expect.stringMatching(/^Platform: \S+; account UID /u));
    expect(lines).toContainEqual(expect.stringContaining(`Private files: ${paths.gateway}; `));
    expect(lines).toContainEqual(expect.stringContaining(`Owned directory ${paths.directory}: `));
    expect(lines).toContainEqual(expect.stringContaining(`Socket: ${paths.socket}. `));
    expect(lines).toContainEqual(
      expect.stringContaining("No pre-existing shared socket observed."),
    );
    expect(fresh.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Peers set up — connected as"),
      "info",
    );
    expect(activate).toHaveBeenCalledOnce();

    const before = await readFile(paths.adapter, "utf8");
    const edit = dialog(["Label=Renamed peer", "APPLY"]);
    await setupCommand(agent, edit, activate, supplied);
    expect(edit.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("✓ Settings changed — connected as"),
      "info",
    );
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls[1]?.[0].choices.label).toBe("Renamed peer");
    expect(activate.mock.calls[1]?.[2]).toBe(true);
    await expect(readFile(paths.adapter, "utf8")).resolves.not.toBe(before);
    await expect(loadConfiguration(agent)).resolves.toMatchObject({ label: "Renamed peer" });
  });
});

describe("Manage on a Tailscale-linked setup", () => {
  let fixture: Awaited<ReturnType<typeof tailscaleFixture>>;
  let agent: string;

  const supplied = () => ({
    backend: { acquire: async () => fixture.executable },
    description: "Explicit immutable native TEST backend",
  });

  const gateway = async () => decodeGateway(parseJson(await readFile(setupPaths(agent).gateway)));
  beforeEach(async () => {
    fixture = await tailscaleFixture("laptop");
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "creator");
    const plan = localPlan(defaultChoices("laptop"), setupPaths(agent).socket);
    const linked = linkedPlan(plan, { mode: "listen", address: "100.64.0.1:7443" });
    await applyLocal(agent, linked, supplied().backend, () => undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("Scope and Machine are read-only; a Permissions edit changes only own-machine grants and keeps the link", async () => {
    const before = await gateway();
    expect(before.remote).toStrictEqual({
      endpoint: { mode: "listen", address: "100.64.0.1:7443" },
    });

    const picks = [
      "Scope: local",
      "Review details",
      "Back",
      "Permissions: 2 of 2 on",
      "push: On",
      "Back",
      "Apply: Ready",
    ];

    const shown: Array<{ title: string; options: ReadonlyArray<string> }> = [];

    const ctx: DialogContext = {
      mode: "rpc",
      hasUI: true,
      signal: undefined,
      ui: {
        select: vi.fn<DialogContext["ui"]["select"]>(async (title, options) => {
          shown.push({ title, options });

          return picks.shift();
        }),
        input: vi.fn<DialogContext["ui"]["input"]>(async () => undefined),
        notify: vi.fn<DialogContext["ui"]["notify"]>(),
      },
    };

    const activate = vi.fn<ActivatePlan>();
    await setupCommand(agent, ctx, activate, supplied());
    expect(picks).toStrictEqual([]);
    expect(shown[0]?.title).toContain("linked over Tailscale (listening on 100.64.0.1:7443)");
    expect(shown[1]?.title).toContain(
      "Can't change here: your tailnet policy grants name this scope. Remove the remote link to change it.",
    );
    const details = String(shown[2]?.title);
    expect(details).toContain("Peers › Setup › Details");
    expect(details).toContain("Your tailnet policy, not these permissions, decides");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("✓ Settings changed — connected as laptop"),
      "info",
    );
    expect(activate).toHaveBeenCalledOnce();

    const after = await gateway();
    expect(after.policies).toStrictEqual([
      { machineId: "laptop", scopeId: "local", permissions: ["discover"] },
    ]);
    expect(after.remote).toStrictEqual(before.remote);
    expect(after.scopeIds).toStrictEqual(before.scopeIds);
  });
});
