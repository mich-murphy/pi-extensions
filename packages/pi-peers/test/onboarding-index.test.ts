import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAdapterRuntime } from "../adapter/runtime.js";
import { freshId } from "../adapter/transport.js";
import communication from "../index.js";
import type { PeersContext } from "../index.js";
import { setupPaths } from "../onboarding/backend.js";
import { extensionFixture } from "./extension-fixture.js";
import { nativeFixture, nativeUntil } from "./onboarding-fixtures.js";

type Runtime = Awaited<ReturnType<typeof createAdapterRuntime>>;

type RuntimeObservations = { during: (() => Promise<void>) | undefined; disposed: Array<boolean> };

const runtimes: RuntimeObservations = {
  during: undefined,
  disposed: [],
};

async function observedRuntime(...args: Parameters<typeof createAdapterRuntime>): Promise<Runtime> {
  const runtime = await createAdapterRuntime(...args);
  const index = runtimes.disposed.push(false) - 1;
  const during = runtimes.during;
  runtimes.during = undefined;
  await during?.();

  return {
    session: runtime.session,
    dispose: async () => {
      runtimes.disposed[index] = true;
      await runtime.dispose();
    },
  };
}

type Answer = (
  title: string,
  options: ReadonlyArray<string>,
) => string | undefined | Promise<string | undefined>;

type Shown = { readonly title: string; readonly options: ReadonlyArray<string> };

function rpcHost(acquire: () => Promise<string>, consented: Array<string>) {
  const notifications: Array<string> = [];
  const sessionId = freshId();
  const fixture = extensionFixture();
  communication(fixture.api, {
    backend: { acquire },
    description: "Explicit immutable native TEST fixture",
    observe: { consented: (action) => consented.push(action) },
    runtime: observedRuntime,
  });

  const context = (
    answer: Answer,
    shown: Array<Shown>,
    mode: PeersContext["mode"] = "rpc",
  ): PeersContext => ({
    mode,
    hasUI: true,
    signal: undefined,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => "/work/repo",
      getSessionName: () => undefined,
      getHeader: () => null,
    },
    ui: {
      select: async (title: string, options: Array<string>) => {
        shown.push({ title, options });

        return answer(title, options);
      },
      input: async () => undefined,
      notify: (message: string) => {
        notifications.push(message);
      },
      setStatus: () => undefined,
    },
  });

  return {
    notifications,
    event: async (type: "session_start" | "session_shutdown") =>
      fixture.event(
        type,
        { type },
        context(() => undefined, []),
      ),
    command: async (
      args: string,
      answer: Answer = () => undefined,
      shown: Array<Shown> = [],
      mode: PeersContext["mode"] = "rpc",
    ) => {
      const start = notifications.length;
      await fixture.command("peers", args, context(answer, shown, mode));

      return notifications.slice(start);
    },
  };
}

function staleApply(
  titles: Array<string>,
  start: () => Promise<Array<string>>,
  ready: Promise<unknown>,
) {
  let other: Promise<Array<string>> | undefined;

  const answer: Answer = async (title, options) => {
    titles.push(title);

    if (other !== undefined || !options.includes("Apply: Ready")) {
      return undefined;
    }

    other = start();
    await ready;

    return "Apply: Ready";
  };

  return { answer, other: async () => other };
}

const applyOnce: Answer = (_title, options) => {
  if (options.includes("Apply: Ready")) {
    return "Apply: Ready";
  }

  return options.includes("Close") ? "Close" : undefined;
};

describe("registerCommunication: actions while an Apply runs", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let agent: string;
  let release: () => void;
  let acquiring: Promise<undefined>;
  let consented: Array<string>;
  let host: ReturnType<typeof rpcHost>;
  beforeEach(async () => {
    fixture = await nativeFixture();
    agent = join(fixture.root, "agent");
    vi.stubEnv("HOME", fixture.root);
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    const gate = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    release = () => {
      gate.resolve(undefined);
    };

    acquiring = started.promise;
    consented = [];
    host = rpcHost(async () => {
      started.resolve(undefined);
      await gate.promise;

      return fixture.executable;
    }, consented);
    await host.event("session_start");
  });
  afterEach(async () => {
    runtimes.during = undefined;
    runtimes.disposed = [];
    release();
    await host.event("session_shutdown");
    await nativeUntil(async () => !existsSync(setupPaths(agent).socket));
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("a second Apply and Reset are refused while the first Apply runs", async () => {
    const first = host.command("setup", applyOnce);
    await acquiring;
    await expect(host.command("setup", applyOnce)).resolves.toStrictEqual([
      expect.stringContaining("Peers is busy with another action"),
    ]);
    await expect(host.command("reset", applyOnce)).resolves.toStrictEqual([
      expect.stringContaining("Peers is busy with another action"),
    ]);
    const shown: Array<Shown> = [];
    await host.command("", () => undefined, shown);
    expect(shown[0]?.options).toStrictEqual(
      expect.arrayContaining(["Setup: Applying…", "Reset: Busy"]),
    );
    expect(consented).toStrictEqual(["Apply"]);
    release();
    await first;
    expect(consented).toStrictEqual(["Apply"]);
    expect(existsSync(setupPaths(agent).adapter)).toBe(true);
  });

  test("a stale consent row chosen while another Apply runs does nothing and records no consent", async () => {
    const titles: Array<string> = [];
    const race = staleApply(titles, async () => host.command("setup", applyOnce), acquiring);
    await host.command("setup", race.answer);
    expect(consented).toStrictEqual(["Apply"]);
    const after = titles.slice(titles.findIndex((title) => title.includes("Apply")) + 1);
    expect(after[0]).toContain("Peers › Setup");
    expect(after[0]).toContain("Peers is busy with another action");
    expect(after.at(-1)).toBe("Peers");
    release();
    await race.other();
    expect(consented).toStrictEqual(["Apply"]);
  });

  test("a session_shutdown during Apply saves settings but activates nothing", async () => {
    const shown: Array<Shown> = [];
    const first = host.command("setup", applyOnce, shown);
    await acquiring;
    await host.event("session_shutdown");
    release();
    await first;
    const outcome = shown.find((item) => item.options.includes("Close"));
    expect(outcome?.title).toContain("Peers › Setup › Result");
    expect(outcome?.title).toContain("! Settings saved but not active yet");
    expect(outcome?.title).toContain("This session ended");
    expect(existsSync(setupPaths(agent).adapter)).toBe(true);
    await delay(300);
    expect(existsSync(setupPaths(agent).socket)).toBe(false);
    const status = await host.command("status");
    expect(status.join("\n")).not.toContain("Connected as");
  });

  test("a session_shutdown while the runtime starts disposes it and activates nothing", async () => {
    release();
    runtimes.during = async () => host.event("session_shutdown");
    const shown: Array<Shown> = [];
    await host.command("setup", applyOnce, shown);
    const outcome = shown.find((item) => item.options.includes("Close"));
    expect(outcome?.title).toContain("! Settings saved but not active yet");
    expect(outcome?.title).toContain("This session ended");
    expect(runtimes.disposed).toStrictEqual([true]);
    const status = await host.command("status");
    expect(status.join("\n")).not.toContain("Connected as");
  });
});

describe("registerCommunication: commands outside an Apply", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let host: ReturnType<typeof rpcHost>;
  let consented: Array<string>;
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(fixture.root, "agent"));
    consented = [];
    host = rpcHost(async () => fixture.executable, consented);
    await host.event("session_start");
  });
  afterEach(async () => {
    await host.event("session_shutdown");
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });

  test.each(["print", "json"] as const)(
    "%s: setup and reset refuse in plain words",
    async (mode) => {
      for (const action of ["setup", "reset"]) {
        await expect(host.command(action, applyOnce, [], mode)).resolves.toStrictEqual([
          `/peers ${action} needs an interactive session.`,
        ]);
      }

      expect(consented).toStrictEqual([]);
      expect(existsSync(join(fixture.root, "agent"))).toBe(false);
    },
  );

  test("/peers reconnect notifies once, in at most two plain sentences", async () => {
    const [message, ...rest] = await host.command("reconnect");
    expect(rest).toStrictEqual([]);
    expect(message).toMatch(/^Reconnect failed: /u);
    expect(message?.split(/\.(?:\s|$)/u).filter((part) => part.trim() !== "")).toHaveLength(2);
    expect(message).not.toMatch(/generation|bounded|replayed|accounting/u);
  });
});
