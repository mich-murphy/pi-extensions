import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAdapterRuntime } from "../adapter/runtime.js";
import { freshId } from "../adapter/transport.js";
import communication from "../index.js";
import { setupPaths } from "../onboarding/backend.js";
import { nativeFixture, nativeUntil } from "./onboarding-fixtures.js";

type Runtime = Awaited<ReturnType<typeof createAdapterRuntime>>;
/** Test hooks around the real createAdapterRuntime: `during` runs before it returns. */
const runtimes: { during: (() => Promise<void>) | undefined; disposed: boolean[] } = {
  during: undefined,
  disposed: [],
};
/** The real runtime, recording disposal and running `runtimes.during` before it is returned. */
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
  options: readonly string[],
) => string | undefined | Promise<string | undefined>;
type Shown = { readonly title: string; readonly options: readonly string[] };

async function invoke(handler: unknown, args: unknown[]): Promise<void> {
  if (typeof handler !== "function") {
    throw new TypeError("Unregistered fixture callback");
  }
  await Reflect.apply(handler, undefined, args);
}

/** An RPC host around the default factory; each command gets its own scripted select. */
function rpcHost(acquire: () => Promise<string>, consented: string[]) {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const notifications: string[] = [];
  const sessionId = freshId();
  const api = {
    on: (name: string, handler: unknown) => {
      handlers.set(name, handler);
    },
    registerTool: () => undefined,
    registerCommand: (name: string, definition: { handler: unknown }) => {
      commands.set(name, definition.handler);
    },
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    registerEntryRenderer: () => undefined,
  };
  Reflect.apply(communication, undefined, [
    api,
    {
      backend: { acquire },
      description: "Explicit immutable native TEST fixture",
      observe: { consented: (action: string) => consented.push(action) },
      runtime: observedRuntime,
    },
  ]);
  const context = (answer: Answer, shown: Shown[], mode = "rpc") => ({
    mode,
    hasUI: true,
    signal: undefined,
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      select: async (title: string, options: string[]) => {
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
    event: async (name: string) => invoke(handlers.get(name), [{}, context(() => undefined, [])]),
    command: async (
      args: string,
      answer: Answer = () => undefined,
      shown: Shown[] = [],
      mode = "rpc",
    ) => {
      const start = notifications.length;
      await invoke(commands.get("peers"), [args, context(answer, shown, mode)]);
      return notifications.slice(start);
    },
  };
}

/**
 * Records every title; at the first `Apply: Ready`, starts another Apply (`start`) and only then
 * answers with the now stale Apply row. Every later prompt is Esc.
 */
function staleApply(titles: string[], start: () => Promise<string[]>, ready: Promise<unknown>) {
  let other: Promise<string[]> | undefined;
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

/** Opens Setup from `/peers setup`, chooses the Ready Apply row, then closes the outcome. */
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
  let consented: string[];
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
    const shown: Shown[] = [];
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
    const titles: string[] = [];
    const race = staleApply(titles, async () => host.command("setup", applyOnce), acquiring);
    await host.command("setup", race.answer);
    expect(consented).toStrictEqual(["Apply"]);
    // The list after the stale answer says why nothing ran; Esc then goes back and closes.
    const after = titles.slice(titles.findIndex((title) => title.includes("Apply")) + 1);
    expect(after[0]).toContain("Peers › Setup");
    expect(after[0]).toContain("Peers is busy with another action");
    expect(after.at(-1)).toBe("Peers");
    release();
    await race.other();
    expect(consented).toStrictEqual(["Apply"]);
  });

  test("a session_shutdown during Apply saves settings but activates nothing", async () => {
    const shown: Shown[] = [];
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
    // No runtime was created, so nothing starts the gateway or is left undisposed.
    await delay(300);
    expect(existsSync(setupPaths(agent).socket)).toBe(false);
    const status = await host.command("status");
    expect(status.join("\n")).not.toContain("Connected as");
  });

  test("a session_shutdown while the runtime starts disposes it and activates nothing", async () => {
    release();
    runtimes.during = async () => host.event("session_shutdown");
    const shown: Shown[] = [];
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
  let consented: string[];
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

  test.each(["print", "json"])("%s: setup and reset refuse in plain words", async (mode) => {
    for (const action of ["setup", "reset"]) {
      await expect(host.command(action, applyOnce, [], mode)).resolves.toStrictEqual([
        `/peers ${action} needs an interactive session.`,
      ]);
    }
    expect(consented).toStrictEqual([]);
    expect(existsSync(join(fixture.root, "agent"))).toBe(false);
  });

  test("/peers reconnect notifies once, in at most two plain sentences", async () => {
    const [message, ...rest] = await host.command("reconnect");
    expect(rest).toStrictEqual([]);
    expect(message).toMatch(/^Reconnect failed: /u);
    expect(message?.split(/\.(?:\s|$)/u).filter((part) => part.trim() !== "")).toHaveLength(2);
    expect(message).not.toMatch(/generation|bounded|replayed|accounting/u);
  });
});
