import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { testKeybindings, testTheme, testTui } from "../../../test-support/pi-tui";
import { actionForm } from "../onboarding/menu/forms.js";
import { MenuModel } from "../onboarding/menu/model.js";
import type { Row, Screen } from "../onboarding/menu/model.js";
import { outcomeLines, runWithProgress, storedOutcome } from "../onboarding/menu/progress.js";
import type { Outcome } from "../onboarding/menu/progress.js";
import { remoteDraft, remoteGate, remoteRows } from "../onboarding/menu/remote-form.js";
import type { RemoteDraft } from "../onboarding/menu/remote-form.js";
import { peersMenu } from "../onboarding/menu/root.js";
import type { ActionKind, RootState } from "../onboarding/menu/root.js";
import { driveRpc } from "../onboarding/menu/rpc.js";
import { applyState, setupForm } from "../onboarding/menu/setup-form.js";
import type { SetupChoice, SetupDraft } from "../onboarding/menu/setup-form.js";
import { PeersMenu } from "../onboarding/menu/tui.js";
import { attempt, failedWith, INCOMPLETE_NEXT, safeReason } from "../onboarding/outcome.js";
import { defaultChoices } from "../onboarding/plan.js";
import { sharedFolder } from "../onboarding/refusal.js";
import type { RemoteIntent } from "../onboarding/remote.js";
import { NO_CHANGES } from "../onboarding/route.js";
import { setupCommand } from "../onboarding/setup.js";
import { dialog, noPins } from "./onboarding-fixtures.js";

const ready = (overrides: Partial<RemoteDraft> = {}): RemoteDraft => ({
  ...remoteDraft(),
  mode: "connect",
  host: "dev-01",
  ...overrides,
});

function linkForm(state: RemoteDraft) {
  const run = vi.fn<(intent: RemoteIntent) => void>();
  const consented = vi.fn<(action: string) => void>();

  const screen = actionForm({
    title: "Link",
    rows: () => remoteRows(state),
    details: () => ["details"],
    consent: () => ({
      label: "Link",
      action: "Link",
      gate: remoteGate(state),
      description: "Link",
      run,
    }),
  });

  const model = new MenuModel(
    {
      kind: "list",
      title: "Peers",
      rows: () => [
        {
          id: "link",
          label: "Link",
          value: "",
          activation: { kind: "open", screen: () => screen },
        },
      ],
    },
    { consented },
  );

  model.activate("link");

  return { model, run, consented };
}

const applyRow = (model: MenuModel): Row | undefined =>
  model.top.kind === "list" ? model.top.rows().find((row) => row.id === "apply") : undefined;

const openers = (model: MenuModel): Array<string> =>
  model.top.kind === "list"
    ? model.top
        .rows()
        .filter((row) => row.activation.kind === "open")
        .map((row) => row.id)
    : [];

const rowLabels = (state: RemoteDraft): Array<string> => remoteRows(state).map((row) => row.label);

describe("the Tailscale link form", () => {
  test("a new link listens on port 7443; the other computer is optional when listening", () => {
    expect(remoteDraft()).toStrictEqual({ mode: "listen", host: "", port: "7443" });
    expect(rowLabels(remoteDraft())).toStrictEqual(["Connection", "Other computer", "Port"]);
    expect(remoteRows(remoteDraft())[1]?.value).toBe("Optional");
    expect(remoteRows(remoteDraft())[1]?.description).toContain("names it in the grant");
    expect(remoteGate(remoteDraft())).toStrictEqual({
      kind: "ready",
      value: { mode: "listen", host: "", port: 7443 },
    });
  });
  test("a listener may name the other computer; a bad name is not ready", () => {
    expect(remoteGate({ mode: "listen", host: "dev-01", port: "7443" })).toStrictEqual({
      kind: "ready",
      value: { mode: "listen", host: "dev-01", port: 7443 },
    });
    expect(remoteGate({ mode: "listen", host: "dev 01", port: "7443" })).toMatchObject({
      kind: "invalid",
    });
  });
  test("connecting asks for the other computer, which is required", () => {
    const state = ready({ host: "" });
    expect(rowLabels(state)).toStrictEqual(["Connection", "Other computer", "Port"]);
    expect(remoteRows(state)[1]?.value).toBe("Required");
    expect(remoteGate(state)).toStrictEqual({ kind: "missing", reason: "Other computer" });
    const { model, run, consented } = linkForm(state);
    model.activate("apply");
    expect([run.mock.calls.length, consented.mock.calls.length]).toStrictEqual([0, 0]);
  });
  test("a saved connect endpoint is shown again, a saved listen endpoint keeps its port", () => {
    expect(remoteDraft({ mode: "connect", address: "100.64.0.2:7500" })).toStrictEqual({
      mode: "connect",
      host: "100.64.0.2",
      port: "7500",
    });
    expect(remoteDraft({ mode: "connect", address: "[fd7a:115c:a1e0::2]:7443" }).host).toBe(
      "fd7a:115c:a1e0::2",
    );
    expect(remoteDraft({ mode: "listen", address: "100.64.0.1:7600" })).toStrictEqual({
      mode: "listen",
      host: "",
      port: "7600",
    });
  });
  test.each([
    ["host", "dev 01", "Use the other computer's MagicDNS name"],
    ["host", "-dev", "Use the other computer's MagicDNS name"],
    ["port", "0", "Use a port number from 1 to 65535"],
    ["port", "65536", "Use a port number from 1 to 65535"],
    ["port", "74a3", "Use a port number from 1 to 65535"],
  ])("a bad %s %j stays in the editor with a plain error", async (id, value, error) => {
    const state = ready();
    const before = { ...state };
    const { model } = linkForm(state);
    model.activate(id);
    await model.submit(value);
    expect(model.error).toContain(error);
    expect(state).toStrictEqual(before);
  });
  test.each([
    ["dev-01.tail1234.ts.net", "dev-01.tail1234.ts.net"],
    ["  100.64.0.2 ", "100.64.0.2"],
    ["fd7a:115c:a1e0::2", "fd7a:115c:a1e0::2"],
  ])("the other computer %j is accepted as %j", async (value, saved) => {
    const state = ready({ host: "" });
    const { model } = linkForm(state);
    model.activate("host");
    await model.submit(value);
    expect([model.title(), state.host]).toStrictEqual(["Peers › Link", saved]);
  });
  test("the help says one computer listens on its tailnet IP and the other connects", () => {
    const [connection, host, port] = remoteRows(ready());
    expect(connection?.description).toContain("its own tailnet IP");
    expect(host?.description).toContain("MagicDNS name");
    expect(port?.description).toContain("7443");
  });
  test("a ready form consents once, with the intent as entered", () => {
    const { model, run, consented } = linkForm(ready({ port: "7500" }));
    expect(applyRow(model)?.value).toBe("Ready");
    model.activate("apply");
    expect(consented).toHaveBeenCalledExactlyOnceWith("Link");
    expect(run).toHaveBeenCalledExactlyOnceWith({ mode: "connect", host: "dev-01", port: 7500 });
  });
  test("back pops exactly one level from every row of the link form", () => {
    const { model } = linkForm(ready());

    for (const id of openers(model)) {
      model.activate(id);
      expect(model.depth).toBe(2);
      model.back();
      expect(model.title()).toBe("Peers › Link");
    }
  });
  test("RPC: Esc on the first input goes back and never opens a second one", async () => {
    const { model } = linkForm(ready({ host: "" }));
    const ctx = dialog(["Other computer: Required", undefined, undefined, undefined]);
    await driveRpc(model, ctx);
    expect(ctx.ui.input).toHaveBeenCalledOnce();
    expect(model.closed).toBe(true);
  });
});

function rowIds(screen: Screen): Array<string> {
  return screen.kind === "list" ? screen.rows().map((row) => row.id) : [];
}

describe("the fresh setup form", () => {
  test("has no remote rows", () => {
    const screen = setupForm({
      draft: fixDraft({ socketRequired: false, socket: "/private/owned/s" }),
      details: () => "",
      apply: vi.fn<(choice: SetupChoice) => void>(),
    });

    expect(rowIds(screen)).toStrictEqual([
      "machineId",
      "scopeId",
      "label",
      "permissions",
      "review",
      "apply",
    ]);
  });
});

function screenModel(top: Screen): MenuModel {
  const model = new MenuModel({ kind: "list", title: "Peers", rows: () => [] });
  model.push(top);

  return model;
}

describe("RPC back on non-list screens (Esc, timeout or abort)", () => {
  test.each<Screen>([
    {
      kind: "toggle",
      title: "Permissions",
      items: () => [{ id: "push", label: "push", on: true }],
      toggle: () => undefined,
    },
    { kind: "report", title: "Status", lines: () => ["Connected"] },
    { kind: "outcome", title: "Result", lines: () => ["✓ Done"] },
  ])("$kind: undefined goes back, then the root closes", async (top) => {
    const model = screenModel(top);
    const ctx = dialog([undefined, undefined]);
    await driveRpc(model, ctx);
    expect([model.closed, vi.mocked(ctx.ui.select).mock.calls.length]).toStrictEqual([true, 2]);
  });
});

describe("progress and stored outcomes", () => {
  test("a hidden progress view still reports its outcome as hidden", async () => {
    const model = screenModel({ kind: "report", title: "x", lines: () => [] });
    const finished = vi.fn<(outcome: Outcome, hidden: boolean) => void>();
    const { promise, resolve } = Promise.withResolvers<Outcome>();
    const done = runWithProgress(model, "Applying", ["Step"], async () => promise, finished);
    model.back();
    expect(model.closed).toBe(true);
    resolve({ ok: true, headline: "✓ Done", facts: [] });
    await done;
    expect(finished).toHaveBeenCalledExactlyOnceWith(
      { ok: true, headline: "✓ Done", facts: [] },
      true,
    );
  });
  test("a throwing effect becomes a withheld failure, never a crash", async () => {
    const model = screenModel({ kind: "report", title: "x", lines: () => [] });
    const finished = vi.fn<(outcome: Outcome, hidden: boolean) => void>();
    await runWithProgress(
      model,
      "Applying",
      [],
      async () => {
        throw new SyntaxError('Unexpected token "secret"');
      },
      finished,
    );
    expect(finished.mock.calls[0]?.[0].headline).toBe("✗ Failed: unexpected error");
    expect(JSON.stringify(finished.mock.calls)).not.toContain("secret");
  });
  test("a report that fails after the UI is gone never becomes an unhandled rejection", async () => {
    const model = screenModel({ kind: "report", title: "x", lines: () => [] });

    const finished = vi.fn<(outcome: Outcome, hidden: boolean) => void>(() => {
      throw new Error("UI gone at shutdown");
    });

    await expect(
      runWithProgress(
        model,
        "Applying",
        [],
        async () => ({ ok: true, headline: "✓ Done", facts: [] }),
        finished,
      ),
    ).resolves.toBeUndefined();
    expect(finished).toHaveBeenCalledOnce();
  });
  test("safeReason keeps only our own plain refusals", () => {
    expect(safeReason(new Error("Saved settings changed; review again."))).toBe(
      "Saved settings changed; review again",
    );
    expect(safeReason(new SyntaxError("Unexpected token"), "withheld")).toBe("withheld");
    expect(safeReason(Object.assign(new Error("EACCES /home/x"), { code: "EACCES" }), "w")).toBe(
      "w",
    );
    expect(safeReason(new Error('quote {"secret": 1}'), "w")).toBe("w");
  });
  test("a refusal shows its own short reason and fix; anything else stays generic", async () => {
    const refusal = sharedFolder("/home/dev/scratch");
    const outcome = failedWith("Setup failed", refusal, INCOMPLETE_NEXT);
    expect(outcome.headline).toBe("✗ Setup failed: /home/dev/scratch is writable by other users");
    expect(outcome.next).toBe("Run chmod go-w /home/dev/scratch, then try again.");
    expect(outcome.technical).toStrictEqual([]);

    const repaired = await attempt("Repair failed", INCOMPLETE_NEXT, async () => {
      throw refusal;
    });

    expect(repaired.headline).toBe("✗ Repair failed: /home/dev/scratch is writable by other users");
    expect(
      failedWith("Setup failed", new Error("Key file missing"), INCOMPLETE_NEXT),
    ).toStrictEqual({
      ok: false,
      headline: "✗ Setup failed: unexpected error",
      facts: [],
      next: INCOMPLETE_NEXT,
      technical: ["Key file missing"],
    });
    expect(
      failedWith("Setup failed", new SyntaxError("secret"), INCOMPLETE_NEXT).technical,
    ).toStrictEqual([]);
  });
  test("storedOutcome rejects other shapes and bounds tampered data", () => {
    expect(storedOutcome({ ok: "yes", headline: "x", facts: [] })).toBeUndefined();
    expect(storedOutcome(null)).toBeUndefined();
    const facts = Array.from({ length: 40 }, (_, index) => [`Fact${index}`, "v".repeat(500)]);

    const stored = storedOutcome({
      ok: false,
      headline: "✗ Bad\u001b[31m\nsecond line",
      facts: [...facts, [1, 2]],
      technical: ["a", 5],
    });

    expect(stored?.facts).toHaveLength(12);
    expect(stored?.facts[0]?.[1].length).toBeLessThanOrEqual(160);
    expect(stored?.headline).toBe(String.raw`✗ Bad\u001b[31m second line`);
    expect(stored?.technical).toStrictEqual(["a"]);
    expect(
      outcomeLines({ ok: true, headline: "✓ x", facts: [["A", "b"]], next: "Go" }),
    ).toStrictEqual(["✓ x", "Next: Go", "A: b"]);
  });
});

function root(busy: { value: boolean }) {
  const events: Array<string> = [];

  const state = (): RootState => ({
    status: { value: "Connected", lines: ["Connected"] },
    doctor: ["✓ ok"],
    setup: {
      value: "Manage",
      description: "View or change the saved setup.",
      configured: true,
      cancelled: () => NO_CHANGES,
      screen: () => ({ kind: "list", title: "Setup", rows: () => [] }),
    },
    resettable: true,
    busy: busy.value,
  });

  const outcome = (name: string) => async (): Promise<Outcome> => {
    events.push(`effect:${name}`);

    return { ok: true, headline: `✓ ${name}`, facts: [] };
  };

  const model = peersMenu(
    {
      state,
      reset: outcome("reset"),
      reconnect: outcome("reconnect"),
      started: () => {
        busy.value = true;
      },
      finished: () => {
        busy.value = false;
      },
    },
    { consented: (action) => events.push(`consent:${action}`) },
  );

  return { model, events };
}

async function settled(screen: Screen): Promise<void> {
  if (screen.kind === "progress") {
    await screen.done;
  }
}

function listRows(screen: Screen): ReadonlyArray<Row> {
  return screen.kind === "list" ? screen.rows() : [];
}

describe("root consent rows", () => {
  test("Reconnect and Turn off peers consent before their effect", async () => {
    const busy = { value: false };
    const { model, events } = root(busy);
    model.activate("reconnect");
    expect(events).toStrictEqual(["consent:Reconnect", "effect:reconnect"]);
    await settled(model.top);
    expect([model.title(), busy.value]).toStrictEqual(["Peers › Reconnect › Result", false]);
    model.back();
    expect(model.title()).toBe("Peers");
    model.activate("reset");
    model.activate("disable");
    expect(events.slice(2)).toStrictEqual(["consent:Disable", "effect:reset"]);
  });
  test("while an action runs, Setup, Reconnect and Reset offer nothing", () => {
    const busy = { value: false };
    const { model, events } = root(busy);
    busy.value = true;
    expect(
      listRows(model.top).map((row) => [row.id, row.value, row.activation.kind]),
    ).toStrictEqual([
      ["status", "Connected", "open"],
      ["setup", "Applying…", "none"],
      ["doctor", "", "open"],
      ["reconnect", "Busy", "none"],
      ["reset", "Busy", "none"],
    ]);
    model.activate("reconnect");
    model.activate("reset");
    model.activate("setup");
    expect([events, model.depth]).toStrictEqual([[], 0]);
  });
});

describe("unreadable setup files", () => {
  test("a corrupt install record blocks Setup without quoting it", async () => {
    const agent = await mkdtemp(join(tmpdir(), "pc-corrupt-"));
    const secret = "SECRET-TOKEN-4f2a";

    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(agent, "pi-peers"), { mode: 0o700 });
      await writeFile(join(agent, "pi-peers", "installed.json"), `not json ${secret}`, {
        mode: 0o600,
      });
      const ctx = dialog([undefined, undefined, undefined]);
      await setupCommand(agent, ctx, vi.fn(), undefined, undefined, noPins);

      const shown = JSON.stringify([
        vi.mocked(ctx.ui.select).mock.calls,
        vi.mocked(ctx.ui.notify).mock.calls,
      ]);

      expect(shown).toContain("saved files are unreadable");
      expect(shown).not.toContain(secret);
    } finally {
      await rm(agent, { recursive: true, force: true });
    }
  });
});

function fixDraft(overrides: Partial<SetupDraft> = {}): SetupDraft {
  return {
    choices: defaultChoices("Fix Host"),
    socket: "",
    socketRequired: true,
    shared: false,
    ...overrides,
  };
}

function rowOf(model: MenuModel, id: string): Row {
  const row =
    model.top.kind === "list" ? model.top.rows().find((item) => item.id === id) : undefined;

  if (row === undefined) {
    throw new Error(`No row ${id}`);
  }

  return row;
}

describe("F5: Esc during an asynchronous save commits nothing", () => {
  test("the socket probe settles after Esc and the draft is unchanged", async () => {
    const probed = Promise.withResolvers<boolean>();
    const state = fixDraft();

    const model = screenModel(
      setupForm({
        draft: state,
        details: () => "",
        apply: vi.fn<(choice: SetupChoice) => void>(),
        probe: async () => probed.promise,
      }),
    );

    model.activate("socket");
    const saving = model.submit("/private/owned/s");
    expect(model.busy).toBe(true);
    model.back();
    probed.resolve(true);
    await saving;
    expect([state.socket, state.shared, model.title()]).toStrictEqual(["", false, "Peers › Setup"]);
  });
  test("a save that settles while its editor is open commits", async () => {
    const state = fixDraft();

    const model = screenModel(
      setupForm({
        draft: state,
        details: () => "",
        apply: vi.fn<(choice: SetupChoice) => void>(),
        probe: async () => true,
      }),
    );

    model.activate("socket");
    await model.submit("/private/owned/s");
    expect([state.socket, state.shared, model.title()]).toStrictEqual([
      "/private/owned/s",
      true,
      "Peers › Setup",
    ]);
  });
});

describe("F6: Blocked is shown before Missing", () => {
  test("blocked acquisition wins over an empty Socket", () => {
    const state = fixDraft();
    expect(applyState(state, "no verified gateway download")).toStrictEqual({
      kind: "blocked",
      reason: "no verified gateway download",
    });
    expect(applyState(state).kind).toBe("missing");
  });
});

describe("F8: report lines are made visible in both drivers", () => {
  const top: Screen = { kind: "report", title: "Doctor", lines: () => ["path /x\u0007y"] };
  test("RPC heading", async () => {
    const ctx = dialog([undefined, undefined]);
    await driveRpc(screenModel(top), ctx);
    const title = String(vi.mocked(ctx.ui.select).mock.calls[0]?.[0]);
    expect(title).toContain(String.raw`path /x\u0007y`);
    expect(title).not.toContain("\u0007");
  });
  test("TUI scroll", () => {
    initTheme();
    setKeybindings(testKeybindings());

    const text = new PeersMenu(screenModel(top), {
      tui: testTui(20),
      theme: testTheme(),
      keybindings: testKeybindings(),
      done: () => undefined,
    })
      .render(80)
      .join("\n");

    expect(text).toContain(String.raw`path /x\u0007y`);
    expect(text).not.toContain("\u0007");
  });
});

describe("F9: RPC context and no-op feedback", () => {
  test("the text editor prompt includes the field description", async () => {
    const model = screenModel(
      setupForm({
        draft: fixDraft(),
        details: () => "",
        apply: vi.fn<(choice: SetupChoice) => void>(),
      }),
    );

    model.activate("label");
    const ctx = dialog([undefined, undefined, undefined]);
    await driveRpc(model, ctx);
    expect(vi.mocked(ctx.ui.input).mock.calls[0]?.[0]).toContain(
      "The name other sessions see for this Pi.",
    );
  });
  test("choosing a row that does nothing shows its description", () => {
    const model = screenModel(
      setupForm({
        draft: fixDraft(),
        details: () => "",
        apply: vi.fn<(choice: SetupChoice) => void>(),
      }),
    );

    model.activate("apply");
    expect(model.error).toBe("Fill in Socket above first.");
    model.activate("label");
    expect(model.error).toBeUndefined();
  });
});

function fixRoot(resettable: boolean | undefined, setup: Screen) {
  const started: Array<ActionKind> = [];
  const consented: Array<string> = [];

  const state = (): RootState => ({
    status: { value: "Connected", lines: [] },
    doctor: [],
    setup: {
      value: "Manage",
      description: "View or change the saved setup.",
      configured: true,
      cancelled: () => NO_CHANGES,
      screen: (progress) => {
        progress(
          "Reconnecting",
          [],
          async () => ({ ok: false, headline: "✗ x", facts: [] }),
          undefined,
          "reconnect",
        );

        return setup;
      },
    },
    resettable,
    busy: false,
  });

  const model = peersMenu(
    {
      state,
      reset: vi.fn<() => Promise<Outcome>>(),
      reconnect: vi.fn<() => Promise<Outcome>>(),
      started: (kind) => started.push(kind),
      finished: vi.fn<() => void>(),
    },
    { consented: (action) => consented.push(action) },
  );

  return { model, started, consented };
}

describe("F10 and F11: root rows", () => {
  const empty: Screen = { kind: "list", title: "Setup", rows: () => [] };
  test("F10: an action started as a reconnect is reported as one, not as setup", () => {
    const { model, started } = fixRoot(true, empty);
    model.activate("setup");
    expect(started).toStrictEqual(["reconnect"]);
  });
  test("F11: Reset reads Checking… and does nothing until the state loads", () => {
    const { model, consented } = fixRoot(undefined, empty);
    const reset = rowOf(model, "reset");
    expect([reset.value, reset.activation.kind]).toStrictEqual(["Checking…", "none"]);
    model.activate("reset");
    expect([model.depth, consented]).toStrictEqual([0, []]);
  });
});

describe("F3: a consent row captured before another action started runs nothing", () => {
  test("stale Reconnect and Turn off peers rows show the busy text and record no consent", () => {
    let busy = false;
    const consented: Array<string> = [];
    const effects: Array<string> = [];

    const model = peersMenu(
      {
        state: () => ({
          status: { value: "Connected", lines: [] },
          doctor: [],
          setup: {
            value: "Manage",
            description: "",
            configured: true,
            cancelled: () => NO_CHANGES,
          },
          resettable: true,
          busy: false,
        }),
        reset: async () => {
          effects.push("reset");

          return { ok: true, headline: "✓", facts: [] };
        },
        reconnect: async () => {
          effects.push("reconnect");

          return { ok: true, headline: "✓", facts: [] };
        },
        started: vi.fn<() => void>(),
        finished: vi.fn<() => void>(),
        guard: { canAct: () => !busy, busy: "BUSY" },
      },
      { consented: (action) => consented.push(action) },
    );

    const reconnect = rowOf(model, "reconnect");
    model.activate("reset");
    const disable = rowOf(model, "disable");
    expect([reconnect.activation.kind, disable.activation.kind]).toStrictEqual([
      "consent",
      "consent",
    ]);
    busy = true;
    model.activateRow(disable);
    expect([model.error, model.title()]).toStrictEqual(["BUSY", "Peers › Reset"]);
    model.back();
    model.activateRow(reconnect);
    expect([model.error, model.title()]).toStrictEqual(["BUSY", "Peers"]);
    expect([consented, effects]).toStrictEqual([[], []]);
  });
});
