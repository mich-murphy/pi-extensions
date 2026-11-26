import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import { decodeConfiguration, loadConfiguration } from "../adapter/config.js";
import { freshId } from "../adapter/transport.js";
import { reloadManagedLauncher, setupPaths } from "../onboarding/backend.js";
import type { DialogContext } from "../onboarding/dialog.js";
import { decodeGateway, parseJson } from "../onboarding/schema.js";
import { setupCommand } from "../onboarding/setup.js";
import type { ActivatePlan } from "../onboarding/upgrade.js";
import { dialog, nativeAddress, nativeFixture, nativeUntil } from "./onboarding-fixtures.js";

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

const PEER = "join-peer";
const DISCLOSED = `Also changes what ${PEER} may do with this Pi.`;

describe("Manage on a paired setup", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let agent: string;
  let client: GatewayClient | undefined;

  const activate: ActivatePlan = async (plan, setup) => {
    client?.close();
    client = new GatewayClient({
      config: plan.adapter,
      peer: { machineId: plan.adapter.machineId, sessionId: freshId(), runtimeNonce: freshId() },
      incoming: () => {
        throw new Error("Unexpected authored request");
      },
      statusChanged: () => undefined,
      ensureGateway: reloadManagedLauncher(agent, plan.adapter, setup),
    });
    await client.reconnect();
  };

  const supplied = () => ({
    backend: { acquire: async () => fixture.executable },
    description: "Explicit immutable native TEST backend",
  });

  const gateway = async () => decodeGateway(parseJson(await readFile(setupPaths(agent).gateway)));
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "creator");
    client = undefined;
    await setupCommand(
      agent,
      dialog([
        "Mode=One remote peer",
        "Trust=Create new pair",
        `Peer machine=${PEER}`,
        "Connection=Listen for peer",
        `Address=${await nativeAddress()}`,
        "APPLY",
      ]),
      activate,
      supplied(),
    );
  });
  afterEach(async () => {
    client?.close();
    await nativeUntil(async () => !existsSync(setupPaths(agent).socket));
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("Scope is read-only; a Permissions edit changes the peer's grants exactly as disclosed", async () => {
    const before = await gateway();
    expect(before.remote).toBeDefined();

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

    await setupCommand(agent, ctx, activate, supplied());
    expect(picks).toStrictEqual([]);
    expect(shown[1]?.title).toContain(
      "Can't change here: the paired computer uses this scope. Re-pair to change it.",
    );
    expect(shown[1]?.title).toContain("Peers › Setup");
    const details = String(shown[2]?.title);
    expect(details).toContain("Peers › Setup › Details");
    expect(details).toContain(DISCLOSED);
    expect(details).not.toContain("reviewed below");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("✓ Settings changed — connected as"),
      "info",
    );

    const after = await gateway();
    const kept = ["discover"];
    expect(after.policies.filter((policy) => policy.machineId === PEER)).toStrictEqual([
      { machineId: PEER, scopeId: "local", permissions: kept, direction: "outgoing" },
      { machineId: PEER, scopeId: "local", permissions: kept, direction: "incoming" },
    ]);
    expect(after.remote).toStrictEqual(before.remote);
    expect(after.scopeIds).toStrictEqual(before.scopeIds);
    const adapter = decodeConfiguration(parseJson(await readFile(setupPaths(agent).adapter)));
    expect(adapter.policies.filter((policy) => policy.machineId === PEER)).toStrictEqual([
      { machineId: PEER, scopeId: "local", permissions: kept },
    ]);
  });
});
