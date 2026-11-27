import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyLocal, setupPaths } from "../onboarding/backend.js";
import { doctorReport, remoteStatus } from "../onboarding/doctor.js";
import { digest } from "../onboarding/files.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import type { LocalPlan } from "../onboarding/plan.js";
import { grantInto, linkedPlan, unlinkedPlan } from "../onboarding/remote.js";
import { decodeGateway, parseJson } from "../onboarding/schema.js";
import { setupCommand } from "../onboarding/setup.js";
import { findTailscale, resolveHost, tailscaleSelf } from "../onboarding/tailscale.js";
import type { ActivatePlan } from "../onboarding/upgrade.js";
import { dialog, TAILNET, tailscaleFixture } from "./onboarding-fixtures.js";

const LINK = "Link a remote computer";

type DiagnosedRemote = {
  readonly state: string;
  readonly reason?: string;
  readonly trust?: string;
  readonly endpoint?: { readonly mode: string; readonly address: string };
  readonly self?: {
    readonly name: string;
    readonly stableId: string;
    readonly addresses: ReadonlyArray<string>;
  };
  readonly peer?: {
    readonly name: string;
    readonly stableId: string;
    readonly tags: ReadonlyArray<string>;
    readonly allow: ReadonlyArray<{
      readonly scope: string;
      readonly actions: ReadonlyArray<string>;
    }>;
  };
};
const CAP = "github.com/mich-murphy/cap/pi-peers";

function basePlan(): LocalPlan {
  return localPlan(defaultChoices("laptop"), "/private/owned/s");
}

function titles(ctx: ReturnType<typeof dialog>): string {
  return vi
    .mocked(ctx.ui.select)
    .mock.calls.map(([title]) => title)
    .join("\n");
}

function notices(ctx: ReturnType<typeof dialog>): string {
  return vi
    .mocked(ctx.ui.notify)
    .mock.calls.map(([message]) => message)
    .join("\n");
}

function remoteRow(report: Awaited<ReturnType<typeof doctorReport>>) {
  return report.rows.find((row) => row.label === "Remote link");
}

describe("Tailscale link plans", () => {
  test("a local plan writes own-machine policies without a direction", () => {
    expect(basePlan().gateway.policies).toStrictEqual([
      { machineId: "laptop", scopeId: "local", permissions: ["discover", "push"] },
    ]);
  });
  test("a linked plan writes only the endpoint and an optional tailscale path", () => {
    const endpoint = { mode: "connect" as const, address: "100.64.0.2:7443" };
    expect(linkedPlan(basePlan(), endpoint).gateway.remote).toStrictEqual({ endpoint });
    const pinned = linkedPlan(basePlan(), endpoint, "/opt/tailscale");
    expect(pinned.gateway.remote).toStrictEqual({ endpoint, tailscale: "/opt/tailscale" });
    expect(decodeGateway(parseJson(JSON.stringify(pinned.gateway)))).toStrictEqual(pinned.gateway);
  });
  test("an old file with remote policies and directions decodes; linking drops them", () => {
    const old = {
      ...basePlan().gateway,
      policies: [
        { machineId: "laptop", scopeId: "local", permissions: ["push"], direction: "outgoing" },
        { machineId: "dev-01", scopeId: "local", permissions: ["push"], direction: "incoming" },
      ],
    };
    const decoded = decodeGateway(parseJson(JSON.stringify(old)));
    const plan = { ...basePlan(), gateway: decoded };
    const linked = linkedPlan(plan, { mode: "listen", address: "100.64.0.1:7443" });
    expect(linked.gateway.policies).toStrictEqual([
      { machineId: "laptop", scopeId: "local", permissions: ["push"] },
    ]);
    expect(unlinkedPlan(linked).gateway.remote).toBeUndefined();
  });
  test("a CA or key field next to the Tailscale endpoint is refused", () => {
    const linked = linkedPlan(basePlan(), { mode: "listen", address: "100.64.0.1:7443" });
    const mixed = {
      ...linked.gateway,
      remote: { endpoint: { mode: "listen", address: "100.64.0.1:7443" }, crls: ["/c.crl"] },
    };
    expect(() => decodeGateway(parseJson(JSON.stringify(mixed)))).toThrow("crls");
  });
  test("the grant names both computers, the scope and, for a listener, its port", () => {
    expect(grantInto("laptop", "dev-01", "work", 7443)).toStrictEqual({
      src: ["dev-01"],
      dst: ["laptop"],
      ip: ["tcp:7443"],
      app: { [CAP]: [{ scopes: ["work"], allow: ["discover", "push"] }] },
    });
    expect(grantInto("laptop", "dev-01", "work", undefined)).toStrictEqual({
      src: ["dev-01"],
      dst: ["laptop"],
      app: { [CAP]: [{ scopes: ["work"], allow: ["discover", "push"] }] },
    });
  });
});

describe("the tailscale command", () => {
  let fixture: Awaited<ReturnType<typeof tailscaleFixture>>;
  beforeEach(async () => {
    fixture = await tailscaleFixture("laptop");
  });
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("the first present candidate is used; none present means not installed", async () => {
    const missing = join(fixture.root, "absent", "tailscale");
    await expect(findTailscale([missing, fixture.tailscale])).resolves.toBe(fixture.tailscale);
    await expect(findTailscale([missing])).rejects.toThrow("Tailscale is not installed");
  });
  test("a group- or world-writable command is refused, not skipped", async () => {
    const unsafe = join(fixture.root, "unsafe-tailscale");
    await writeFile(unsafe, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(unsafe, 0o722);
    await expect(findTailscale([unsafe, fixture.tailscale])).rejects.toThrow(
      "Tailscale failed or gave an unexpected answer",
    );
  });
  test("status gives this computer's tailnet name and addresses", async () => {
    await expect(tailscaleSelf(fixture.tailscale)).resolves.toStrictEqual({
      name: "laptop",
      addresses: [...TAILNET.self],
    });
  });
  test("a logged-out Tailscale is reported as not running", async () => {
    const stopped = await tailscaleFixture("laptop", "NeedsLogin");
    await expect(tailscaleSelf(stopped.tailscale)).rejects.toThrow(
      "Tailscale is not running or not logged in",
    );
    await rm(stopped.root, { recursive: true, force: true });
  });
  test("an IP is kept, a MagicDNS name is resolved once, an unknown name is refused", async () => {
    await expect(resolveHost(fixture.tailscale, "100.64.0.9")).resolves.toBe("100.64.0.9");
    await expect(resolveHost(fixture.tailscale, TAILNET.other)).resolves.toBe(TAILNET.otherAddress);
    await expect(resolveHost(fixture.tailscale, "nowhere")).rejects.toThrow(
      "no tailnet computer is called nowhere",
    );
  });
});

describe("linking through setup with a fake gateway and tailscale", () => {
  let fixture: Awaited<ReturnType<typeof tailscaleFixture>>;
  let agent: string;
  let activate: ReturnType<typeof vi.fn<ActivatePlan>>;

  const supplied = () => ({
    backend: { acquire: async () => fixture.executable },
    description: "TEST",
    tailscale: fixture.tailscale,
  });

  const gateway = async () => decodeGateway(parseJson(await readFile(setupPaths(agent).gateway)));

  async function command(answers: Array<string | undefined>) {
    const ctx = dialog(answers);
    await setupCommand(agent, ctx, activate, supplied());

    return ctx;
  }

  beforeEach(async () => {
    fixture = await tailscaleFixture("laptop");
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "agent");
    activate = vi.fn<ActivatePlan>();
    await command(["Machine=laptop", "APPLY"]);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("listening uses this computer's tailnet IP and port 7443 and shows the grant once", async () => {
    const linked = await command([LINK, "APPLY"]);
    expect(notices(linked)).toContain("Linked over Tailscale — listening on 100.64.0.1:7443");
    expect(notices(linked)).toContain(
      `Add this grant to your tailnet policy so <other computer> may use sessions here: ${JSON.stringify(grantInto("laptop", "<other computer>", "local", 7443))}`,
    );
    const saved = await gateway();
    expect(saved.remote).toStrictEqual({
      endpoint: { mode: "listen", address: "100.64.0.1:7443" },
      tailscale: fixture.tailscale,
    });
    expect(saved.policies).toStrictEqual([
      { machineId: "laptop", scopeId: "local", permissions: ["discover", "push"] },
    ]);
    expect(activate).toHaveBeenCalledTimes(2);
  });
  test("connecting resolves the MagicDNS name to its tailnet IP and names it in the grant", async () => {
    const linked = await command([
      LINK,
      "Connection=Connect to another computer",
      `Other computer=${TAILNET.other}`,
      "Port=7500",
      "APPLY",
    ]);
    expect(notices(linked)).toContain(
      JSON.stringify(grantInto("laptop", TAILNET.other, "local", undefined)),
    );
    await expect(gateway()).resolves.toMatchObject({
      remote: { endpoint: { mode: "connect", address: `${TAILNET.otherAddress}:7500` } },
    });
  });
  test("connecting to this computer's own address is refused before anything is saved", async () => {
    const before = await readFile(setupPaths(agent).gateway);
    const linked = await command([
      LINK,
      "Connection=Connect to another computer",
      `Other computer=${TAILNET.self[0]}`,
      "APPLY",
    ]);
    expect(notices(linked)).toContain("Linking failed: that address is this computer");
    await expect(readFile(setupPaths(agent).gateway)).resolves.toStrictEqual(before);
  });
  test("a machine name that differs from the tailnet name is refused with the fix", async () => {
    await rm(agent, { recursive: true, force: true });
    await command(["Machine=desk", "APPLY"]);
    const linked = await command([LINK, "APPLY"]);
    expect(notices(linked)).toContain(
      "this computer's tailnet name is laptop but its machine name is desk",
    );
    expect(notices(linked)).toContain("Change Machine to laptop");
    await expect(gateway()).resolves.not.toHaveProperty("remote");
  });
  test("removing the link keeps local sessions and drops only the endpoint", async () => {
    await command([LINK, "APPLY"]);
    const removed = await command(["Remove the remote link", "APPLY"]);
    expect(notices(removed)).toContain("Remote link removed");
    await expect(gateway()).resolves.not.toHaveProperty("remote");
  });
});

describe("a stopped Tailscale", () => {
  test("linking says Tailscale is not running and saves nothing", async () => {
    const fixture = await tailscaleFixture("laptop", "Stopped");
    vi.stubEnv("HOME", fixture.root);
    const agent = join(fixture.root, "agent");
    const supplied = {
      backend: { acquire: async () => fixture.executable },
      description: "TEST",
      tailscale: fixture.tailscale,
    };
    const activate = vi.fn<ActivatePlan>();
    await setupCommand(agent, dialog(["Machine=laptop", "APPLY"]), activate, supplied);
    const linked = dialog([LINK, "APPLY"]);
    await setupCommand(agent, linked, activate, supplied);
    expect(notices(linked)).toContain(
      "Linking failed: Tailscale is not running or not logged in. Start Tailscale and log in",
    );
    const saved = decodeGateway(parseJson(await readFile(setupPaths(agent).gateway)));
    expect(saved).not.toHaveProperty("remote");
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });
});

describe("doctor and status from the gateway's diagnosis", () => {
  let fixture: Awaited<ReturnType<typeof tailscaleFixture>>;
  let agent: string;
  beforeEach(async () => {
    fixture = await tailscaleFixture("laptop");
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "agent");
    const plan = localPlan(defaultChoices("laptop"), setupPaths(agent).socket);
    const linked = linkedPlan(plan, { mode: "connect", address: "100.64.0.2:7443" });
    await applyLocal(agent, linked, { acquire: async () => fixture.executable }, () => undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  async function diagnosed(remote: DiagnosedRemote) {
    await writeFile(fixture.diagnose, JSON.stringify({ version: 1, machineId: "laptop", remote }));

    return remoteRow(await doctorReport(agent));
  }

  const configured = {
    state: "configured",
    trust: "tailscale",
    endpoint: { mode: "connect", address: "100.64.0.2:7443" },
    self: { name: "laptop", stableId: "n1", addresses: ["100.64.0.1"] },
  };

  test("a connector shows this computer, the endpoint and what the peer may do here", async () => {
    const row = await diagnosed({
      ...configured,
      peer: {
        name: "dev-01",
        stableId: "n2",
        tags: ["tag:dev"],
        allow: [{ scope: "local", actions: ["discover", "reply"] }],
      },
    });
    expect(row).toStrictEqual({
      label: "Remote link",
      value:
        "Tailscale: this computer is laptop. Connecting to 100.64.0.2:7443. dev-01 may discover, reply in local here. The live link is not checked here.",
      level: "ok",
    });
    await expect(remoteStatus(agent)).resolves.toBe(`✓ Remote link: ${String(row?.value)}`);
  });
  test("a peer with no grant is a warning that names the tailnet policy", async () => {
    const row = await diagnosed({
      ...configured,
      peer: { name: "dev-01", stableId: "n2", tags: [], allow: [] },
    });
    expect(row?.level).toBe("warn");
    expect(row?.value).toContain("dev-01 may do nothing here yet; add a grant for it");
  });
  test.each([
    ["tailscale-missing", "Tailscale is not installed on this computer. Install Tailscale"],
    ["tailscale-not-running", "Tailscale is not running or not logged in. Start Tailscale"],
    ["tailscale-error", "Tailscale failed or gave an unexpected answer. Run tailscale status"],
    ["not-tailnet-address", "The link address is not a usable tailnet computer. Link again"],
  ])("degraded %s is one plain sentence with one next step", async (reason, text) => {
    const row = await diagnosed({ state: "degraded", reason });
    expect(row?.level).toBe("error");
    expect(row?.value).toContain(text);
    expect(row?.value).toContain("This machine still works locally.");
  });
  test("an unknown degraded reason is shown, not hidden", async () => {
    const row = await diagnosed({ state: "degraded", reason: "future-reason" });
    expect(row?.value).toContain("Needs attention (future-reason)");
  });
});

describe("migrating a retired certificate or key link", () => {
  let fixture: Awaited<ReturnType<typeof tailscaleFixture>>;
  let agent: string;
  beforeEach(async () => {
    fixture = await tailscaleFixture("laptop");
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "agent");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  async function retiredSetup() {
    const paths = setupPaths(agent);
    const plan = localPlan(defaultChoices("laptop"), paths.socket);
    const backend = { acquire: async () => fixture.executable };
    const setup = await applyLocal(agent, plan, backend, () => undefined);
    const keys = join(paths.directory, "keys");
    await mkdir(keys, { mode: 0o700 });
    await writeFile(join(keys, "gateway-key.der"), "old key");
    const grant = { machineId: "dev-01", scopeId: "local", permissions: ["discover", "push"] };

    const gateway = `${JSON.stringify(
      {
        ...plan.gateway,
        policies: [
          ...plan.gateway.policies.map((policy) => ({ ...policy, direction: "outgoing" })),
          { ...grant, direction: "outgoing" },
          { ...grant, direction: "incoming" },
        ],
        remote: {
          machineId: "dev-01",
          endpoint: { mode: "connect", address: "100.64.0.2:7443" },
          privateKey: join(keys, "gateway-key.der"),
          peerPublicKey: "ab".repeat(32),
        },
      },
      null,
      2,
    )}\n`;

    const adapter = `${JSON.stringify({ ...plan.adapter, policies: [...plan.adapter.policies, grant] }, null, 2)}\n`;
    await writeFile(paths.gateway, gateway);
    await writeFile(paths.adapter, adapter);
    await writeFile(
      paths.metadata,
      `${JSON.stringify({ ...setup, adapterSha256: digest(adapter), gatewaySha256: digest(gateway) }, null, 2)}\n`,
    );

    return { paths, keys };
  }

  test("setup says the link is retired, links again over Tailscale and keeps the old files", async () => {
    const { paths, keys } = await retiredSetup();
    const supplied = {
      backend: { acquire: async () => fixture.executable },
      description: "TEST",
      tailscale: fixture.tailscale,
    };
    const activate = vi.fn<ActivatePlan>();
    const shown = dialog([undefined, undefined]);
    await setupCommand(agent, shown, activate, supplied);
    expect(titles(shown)).toContain(
      "This link uses retired certificates or keys. Link again over Tailscale.",
    );
    expect(titles(shown)).toContain("can be deleted");
    const retired = remoteRow(await doctorReport(agent));
    expect(retired?.level).toBe("error");
    expect(retired?.value).toContain("Link again over Tailscale");

    const linked = dialog([LINK, "APPLY"]);
    await setupCommand(agent, linked, activate, supplied);
    expect(notices(linked)).toContain("Linked over Tailscale");
    const saved = decodeGateway(parseJson(await readFile(paths.gateway)));
    expect(saved.remote).toStrictEqual({
      endpoint: { mode: "listen", address: "100.64.0.1:7443" },
      tailscale: fixture.tailscale,
    });
    expect(saved.policies).toStrictEqual([
      { machineId: "laptop", scopeId: "local", permissions: ["discover", "push"] },
    ]);
    await expect(readFile(join(keys, "gateway-key.der"), "utf8")).resolves.toBe("old key");
  });
});
