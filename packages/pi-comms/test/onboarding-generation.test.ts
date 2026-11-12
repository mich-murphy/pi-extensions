import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayClient } from "../adapter/client.js";
import type { EnsureGateway } from "../adapter/client.js";
import { AdapterSession } from "../adapter/session.js";
import { freshId } from "../adapter/transport.js";
import {
  applyLocal,
  inspectSetup,
  reloadManagedLauncher,
  resetLocal,
  setupPaths,
} from "../onboarding/backend.js";
import { requestManagedRestart } from "../onboarding/managed.js";
import type { ManagedSetup } from "../onboarding/managed.js";
import { localPlan } from "../onboarding/plan.js";
import type { LocalPlan } from "../onboarding/plan.js";
import { setupCommand } from "../onboarding/setup.js";
import {
  dialog,
  nativeFixture,
  nativeUntil,
  nativeParticipants,
  nativeIncarnation,
} from "./onboarding-fixtures.js";

const local = "Local only — no remote connections (recommended)";
const narrow = [local, "Edit choices", "Permissions", "Deny", "Allow", "Deny", "Deny", "APPLY"];

function requiredSetup(setup: ManagedSetup | undefined): ManagedSetup {
  if (setup === undefined) {
    throw new Error("Expected committed native setup");
  }
  return setup;
}

async function peersOf(client: GatewayClient) {
  const reply = await client.discover(["local"], false);
  if (reply.forOp !== "discover" || reply.outcome.tag !== "ok") {
    throw new Error("Expected actual native roster");
  }
  return reply.outcome.value.peers;
}

describe("managed generation admission with actual native helper", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let agent: string;
  let participants: ReturnType<typeof nativeParticipants>;
  let cleanupFailure: { cause: unknown } | undefined;
  beforeEach(async () => {
    // Keep the old paths and stopping owner if a body outlives its cleanup drain.
    if (cleanupFailure !== undefined) {
      throw new Error("Prior native cleanup failed; refusing a new fixture", cleanupFailure);
    }
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "agent");
    participants = nativeParticipants();
  });
  afterEach(async () => {
    // Vitest still runs afterEach when the fail-stop beforeEach above throws.
    if (cleanupFailure !== undefined) {
      return;
    }
    try {
      await participants.close();
      await nativeUntil(async () => !existsSync(setupPaths(agent).socket), 12_000);
      vi.unstubAllEnvs();
      await rm(fixture.root, { recursive: true, force: true });
    } catch (error) {
      cleanupFailure = { cause: error };
      throw error;
    }
  }, 80_000);
  async function owned(body: () => Promise<void>) {
    // Capture this lifetime, not the next test's mutable fixture.
    const owner = participants;
    return owner.run(body);
  }
  function client(plan: LocalPlan, setup: ManagedSetup, ensure?: EnsureGateway) {
    const instance = new GatewayClient({
      config: plan.adapter,
      peer: { machineId: plan.adapter.machineId, sessionId: freshId(), runtimeNonce: freshId() },
      incoming: () => {
        throw new Error("Unexpected authored request");
      },
      statusChanged: () => undefined,
      ensureGateway: ensure ?? reloadManagedLauncher(agent, plan.adapter, setup),
    });
    participants.own(instance);
    return instance;
  }
  async function installed() {
    const state = await inspectSetup(agent);
    const plan = localPlan(state.choices, state.paths.socket);
    const setup = await applyLocal(
      agent,
      plan,
      { acquire: async () => fixture.executable },
      () => undefined,
    );
    const survivor = client(plan, setup);
    await survivor.reconnect();
    return { plan, setup, survivor };
  }
  test("owned cleanup drains a timed-out body and refuses its late participant", async () => {
    const owner = nativeParticipants();
    const close = vi.fn<() => void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<undefined>();
    const body = owner.run(async () => {
      await gate;
      owner.own({ close });
    });
    const result = body.catch((error: unknown) => error);
    let drained = false;
    const cleanup = (async () => {
      await owner.close();
      drained = true;
    })();
    // Let an incorrectly eager cleanup finish its microtasks before checking the gate.
    await immediate();
    expect(drained).toBe(false);
    expect(close).not.toHaveBeenCalled();
    release(undefined);
    await expect(result).resolves.toHaveProperty(
      "message",
      "Native fixture is stopping; late participant refused",
    );
    await cleanup;
    expect(close).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
  });
  // One production rejection episode is bounded at six attempts/60s, not Vitest's 5s.
  test(
    "survivor reset then fresh narrower Apply never admits new Pi to old daemon; exactly one restart",
    async ({ annotate }) =>
      owned(async () => {
        const started = performance.now();
        const { survivor, setup: old } = await installed();
        await annotate(
          `old registered at ${Math.round(performance.now() - started)}ms`,
          "native-phase",
        );
        await resetLocal(agent);
        let next: GatewayClient | undefined;
        const activate = vi.fn<(plan: LocalPlan, setup: ManagedSetup) => Promise<void>>(
          async (plan, setup) => {
            next = client(plan, setup);
            await next.reconnect();
          },
        );
        const restart = vi.fn<typeof requestManagedRestart>(async (setup) => {
          expect(setup.gatewaySha256).not.toBe(old.gatewaySha256);
          const state = await inspectSetup(agent);
          const selected = localPlan({ ...state.choices, permissions: ["read"] }, setup.socketPath);
          const blocked = client(selected, setup);
          const blockedAt = performance.now();
          await expect(blocked.reconnect()).rejects.toThrow("unavailable");
          await annotate(
            `guarded rejection episode ${Math.round(performance.now() - blockedAt)}ms; elapsed ${Math.round(performance.now() - started)}ms`,
            "native-phase",
          );
          expect(blocked.status()).toMatchObject({
            connected: false,
            status: "activation_pending",
            scopes: [],
          });
          blocked.close();
          const roster = await survivor.discover(["local"], false);
          expect(roster.outcome.tag).toBe("ok");
          const peers = await peersOf(survivor);
          expect(peers).toHaveLength(1);
          return requestManagedRestart(setup);
        });
        const ctx = dialog([...narrow]);
        await setupCommand(agent, ctx, activate, {
          backend: { acquire: async () => fixture.executable },
          description: "TEST immutable native helper",
          restart,
        });
        await annotate(
          `fresh activation at ${Math.round(performance.now() - started)}ms`,
          "native-phase",
        );
        expect(restart).toHaveBeenCalledOnce();
        expect(activate).toHaveBeenCalledOnce();
        expect(next).toBeDefined();
        await expect(next?.discover(["local"], false)).resolves.toMatchObject({
          outcome: { tag: "error", code: "forbidden" },
        });
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Configured and connected locally"),
          "info",
        );
        await nativeUntil(async () => !survivor.status().connected);
        expect(survivor.status().scopes).toStrictEqual([]);
      }),
    75_000,
  );
  test(
    "forced uncertain narrower Apply cannot activate against a live old generation or replay control",
    async () =>
      owned(async () => {
        const { survivor } = await installed();
        await resetLocal(agent);
        const restart = vi.fn<typeof requestManagedRestart>(async () => "uncertain");
        const activate = vi.fn<(plan: LocalPlan, setup: ManagedSetup) => Promise<void>>();
        const ctx = dialog([...narrow]);
        await setupCommand(agent, ctx, activate, {
          backend: { acquire: async () => fixture.executable },
          description: "TEST immutable helper",
          restart,
        });
        const state = await inspectSetup(agent);
        const selected = localPlan({ ...state.choices, permissions: ["read"] }, state.paths.socket);
        const { readManaged } = await import("../onboarding/backend.js");
        const setup = await readManaged(agent, selected.adapter);
        expect(setup).toBeDefined();
        const blocked = client(selected, requiredSetup(setup));
        await expect(blocked.reconnect()).rejects.toThrow("unavailable");
        expect(blocked.status()).toMatchObject({
          connected: false,
          status: "activation_pending",
          scopes: [],
        });
        await expect(peersOf(survivor)).resolves.toHaveLength(1);
        expect(restart).toHaveBeenCalledOnce();
        expect(activate).not.toHaveBeenCalled();
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Configuration saved; activation pending"),
          "warning",
        );
        expect(ctx.ui.notify).not.toHaveBeenCalledWith(
          expect.stringContaining("Configured and connected"),
          "info",
        );
      }),
    75_000,
  );
  test("reviewed activation of narrowed saved grants leaves the surviving old policy disconnected and pending", async () =>
    owned(async () => {
      const { plan, setup } = await installed();
      const session = new AdapterSession(
        plan.adapter,
        { machineId: plan.adapter.machineId, sessionId: freshId(), runtimeNonce: freshId() },
        { sendMessage: () => undefined },
        () => undefined,
        () => undefined,
        reloadManagedLauncher(agent, plan.adapter, setup),
      );
      participants.own(session.client);
      await session.reconnect();
      const peer = session.peer;
      const state = session.state;
      const publication = state.publish({
        scopeId: "local",
        key: "retained",
        record: {
          category: "context",
          title: "Retained",
          summary: "narrowed activation",
          content: "same bytes",
          format: "text",
          preparation: "authored",
        },
      });
      expect(publication.tag).toBe("ok");
      const before = session.status();
      await resetLocal(agent);
      const restart = vi.fn<typeof requestManagedRestart>(async () => "uncertain");
      const activate = vi.fn<(plan: LocalPlan, setup: ManagedSetup) => Promise<void>>();
      await setupCommand(agent, dialog([...narrow]), activate, {
        backend: { acquire: async () => fixture.executable },
        description: "TEST immutable helper",
        restart,
      });
      // This old runtime is genuinely still connected until the explicit control action.
      expect(session.status().connected).toBe(true);
      const reconnect = vi.fn<(fresh?: boolean) => Promise<void>>(async (fresh) =>
        session.reconnect(fresh),
      );
      const ctx = dialog(["Activate saved configuration", "APPLY"]);
      await setupCommand(agent, ctx, activate, undefined, reconnect);
      expect(reconnect).toHaveBeenCalledExactlyOnceWith(true);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("activation pending or unconfirmed"),
        "warning",
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("Saved configuration activated"),
        "info",
      );
      expect(session.status()).toMatchObject({
        connected: false,
        scopes: [],
        publications: before.publications,
        revision: before.revision,
      });
      expect(session.peer).toBe(peer);
      expect(session.state).toBe(state);
      // Volatile publication remains, but disconnected scopes correctly deny access.
      expect(state.read({ caller: peer, scopeId: "local", key: "retained" }).tag).toBe("error");
      expect(restart).toHaveBeenCalledOnce();
      expect(activate).not.toHaveBeenCalled();
      session.close();
    }));
  test("uncertain fresh restart is saved/pending, never replayed; explicit activation keeps runtime identity/state", async () =>
    owned(async () => {
      const { plan, setup, survivor } = await installed();
      await resetLocal(agent);
      const restart = vi.fn<typeof requestManagedRestart>(async () => "uncertain");
      const activate = vi.fn<(plan: LocalPlan, setup: ManagedSetup) => Promise<void>>();
      const ctx = dialog([local, "APPLY"]);
      await setupCommand(agent, ctx, activate, {
        backend: { acquire: async () => fixture.executable },
        description: "TEST immutable helper",
        restart,
      });
      expect(restart).toHaveBeenCalledOnce();
      expect(activate).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Configuration saved; activation pending"),
        "warning",
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining("Configured and connected"),
        "info",
      );
      expect(survivor.status().connected).toBe(true);
      const session = new AdapterSession(
        plan.adapter,
        { machineId: plan.adapter.machineId, sessionId: freshId(), runtimeNonce: freshId() },
        { sendMessage: () => undefined },
        () => undefined,
        () => undefined,
        reloadManagedLauncher(agent, plan.adapter, setup),
      );
      participants.own(session.client);
      const peer = session.peer;
      const state = session.state;
      await session.reconnect();
      const publication = session.state.publish({
        scopeId: "local",
        key: "retained",
        record: {
          category: "context",
          title: "Retained generation state",
          summary: "explicit restart",
          content: "same bytes",
          format: "text",
          preparation: "authored",
        },
      });
      expect(publication.tag).toBe("ok");
      const before = session.status();
      const cancel = dialog(["Activate saved configuration", "Cancel — no changes"]);
      const entries = await readdir(setupPaths(agent).directory);
      const metadata = await readFile(setupPaths(agent).metadata);
      await setupCommand(agent, cancel, activate, undefined, async (fresh) =>
        session.reconnect(fresh),
      );
      await expect(readdir(setupPaths(agent).directory)).resolves.toStrictEqual(entries);
      await expect(readFile(setupPaths(agent).metadata)).resolves.toStrictEqual(metadata);
      const oldSocket = await nativeIncarnation(setupPaths(agent).socket);
      expect(oldSocket).toBeDefined();
      const explicit = dialog(["Activate saved configuration", "APPLY"]);
      await setupCommand(agent, explicit, activate, undefined, async (fresh) =>
        session.reconnect(fresh),
      );
      const newSocket = await nativeIncarnation(setupPaths(agent).socket);
      expect(newSocket).toBeDefined();
      expect(newSocket).not.toBe(oldSocket);
      expect(explicit.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Saved configuration activated"),
        "info",
      );
      expect(session.state.read({ caller: peer, scopeId: "local", key: "retained" }).tag).toBe(
        "ok",
      );
      expect(session.peer).toBe(peer);
      expect(session.state).toBe(state);
      expect(session.status()).toMatchObject({
        peer: before.peer,
        connected: true,
        scopes: before.scopes,
        publications: before.publications,
        revision: before.revision,
      });
      expect(restart).toHaveBeenCalledOnce();
      expect(activate).not.toHaveBeenCalled();
      session.close();
    }));
  test("reachable launcher returns hash from the same reload snapshot without starting a daemon", async () =>
    owned(async () => {
      const { setup } = await installed();
      const { managedLauncher } = await import("../onboarding/managed.js");
      let current = setup;
      const reload = vi.fn<() => Promise<ManagedSetup>>(async () => current);
      const ensure = managedLauncher(setup, reload);
      const entries = await readdir(setupPaths(agent).directory);
      await expect(
        ensure(performance.now() + 5000, new AbortController().signal),
      ).resolves.toStrictEqual({ gatewaySha256: setup.gatewaySha256 });
      current = { ...setup, gatewaySha256: "d".repeat(64) };
      await expect(
        ensure(performance.now() + 5000, new AbortController().signal),
      ).resolves.toStrictEqual({ gatewaySha256: current.gatewaySha256 });
      expect(reload).toHaveBeenCalledTimes(2);
      await expect(readdir(setupPaths(agent).directory)).resolves.toStrictEqual(entries);
    }));
});
