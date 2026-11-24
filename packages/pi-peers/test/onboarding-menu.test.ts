import { describe, expect, test, vi } from "vitest";
import { MenuModel, hint } from "../onboarding/menu/model.js";
import type { Screen } from "../onboarding/menu/model.js";
import { remoteDraft } from "../onboarding/menu/remote-form.js";
import { driveRpc } from "../onboarding/menu/rpc.js";
import { applyState, editState, manageForm, setupForm } from "../onboarding/menu/setup-form.js";
import type { SetupDraft } from "../onboarding/menu/setup-form.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import { dialog } from "./onboarding-fixtures.js";

const keys = { confirm: "Enter", cancel: "Esc" };
const draft = (overrides: Partial<SetupDraft> = {}): SetupDraft => ({
  mode: "local",
  choices: defaultChoices("Menu Host"),
  socket: "/private/owned/s",
  socketRequired: false,
  shared: false,
  remote: remoteDraft(),
  ...overrides,
});

function harness(blocked?: string, state = draft()) {
  const apply = vi.fn<(plan: unknown) => void>();
  const consented = vi.fn<(action: string) => void>();
  const form = setupForm({
    draft: state,
    ...(blocked === undefined ? {} : { blocked }),
    details: () => "Account-wide scope\nPeer messages may wake the model",
    apply,
  });
  const root: Screen = {
    kind: "list",
    title: "Peers",
    rows: () => [
      {
        id: "setup",
        label: "Setup",
        value: "Set up",
        activation: { kind: "open", screen: () => form },
      },
    ],
  };
  const model = new MenuModel(root, { consented });
  return { model, apply, consented, form };
}
const rows = (screen: Screen) => (screen.kind === "list" ? screen.rows() : []);

describe("peers menu model", () => {
  test("back pops exactly one level and the root closes", () => {
    const { model } = harness();
    model.activate("setup");
    model.activate("machineId");
    expect(model.title()).toBe("Peers › Setup › Machine");
    model.back();
    expect(model.title()).toBe("Peers › Setup");
    model.back();
    expect([model.title(), model.closed]).toStrictEqual(["Peers", false]);
    model.back();
    expect(model.closed).toBe(true);
  });
  test("hint rows follow the screen contract", () => {
    const { model, form } = harness();
    expect(hint(model.top, 0, keys)).toBe("Enter select · Esc close");
    expect(hint(form, 1, keys)).toBe("Enter select · Esc back");
    model.activate("setup");
    model.activate("permissions");
    expect(hint(model.top, 2, keys)).toBe("Enter toggle · Esc back");
  });
  test("editing never runs an effect; only the Ready Apply row consents, before the effect", async () => {
    const { model, apply, consented } = harness();
    model.activate("setup");
    model.activate("mode");
    model.activate("mode");
    model.activate("scopeId");
    await model.submit("team");
    model.activate("permissions");
    model.toggle("push");
    model.back();
    model.activate("review");
    model.back();
    expect(apply).not.toHaveBeenCalled();
    expect(consented).not.toHaveBeenCalled();
    consented.mockImplementation(() => {
      expect(apply).not.toHaveBeenCalled();
    });
    model.activate("apply");
    expect(consented).toHaveBeenCalledWith("Apply");
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      plan: {
        choices: {
          scopeId: "team",
          permissions: ["discover"],
        },
      },
    });
  });
  test("inline validation keeps the editor open and never ends the flow", async () => {
    const { model } = harness();
    model.activate("setup");
    model.activate("machineId");
    await model.submit("NOT VALID");
    expect(model.title()).toBe("Peers › Setup › Machine");
    expect(model.error).toContain("lowercase");
    await model.submit("fixed-host");
    expect(model.title()).toBe("Peers › Setup");
    expect(rows(model.top).find((row) => row.id === "machineId")?.value).toBe("fixed-host");
  });
  test("blocked acquisition shows the reason and offers no consent row", () => {
    const { model, apply, consented } = harness("no verified gateway source");
    model.activate("setup");
    const applyRow = rows(model.top).find((row) => row.id === "apply");
    expect(applyRow?.value).toBe("Blocked: no verified gateway source");
    expect(rows(model.top).some((row) => row.activation.kind === "consent")).toBe(false);
    model.activate("apply");
    expect([apply.mock.calls.length, consented.mock.calls.length]).toStrictEqual([0, 0]);
  });
  test("a required socket shows Missing until it is chosen", () => {
    expect(applyState(draft({ socketRequired: true, socket: "" }))).toStrictEqual({
      kind: "missing",
      reason: "Socket",
    });
    expect(applyState(draft({ socketRequired: true, socket: "/tmp/s" }))).toMatchObject({
      kind: "invalid",
    });
  });
  test("RPC: a forged answer means back, root Esc closes, nothing applies", async () => {
    const { model, apply, consented } = harness();
    const ctx = dialog(["Setup: Set up", "forged answer", undefined]);
    await driveRpc(model, ctx);
    expect(model.closed).toBe(true);
    expect(ctx.ui.select).toHaveBeenCalledTimes(3);
    expect(ctx.ui.select).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Peers › Setup"),
      expect.arrayContaining(["Back", "Apply: Ready"]),
      expect.anything(),
    );
    expect([apply.mock.calls.length, consented.mock.calls.length]).toStrictEqual([0, 0]);
  });
  test("RPC: invalid input stays on the editor, then Apply consents once", async () => {
    const { model, apply, consented } = harness();
    model.activate("setup");
    const ctx = dialog(["Scope: local", "bad scope!", "ok-scope", "Apply: Ready"]);
    apply.mockImplementation(() => {
      model.close();
    });
    await driveRpc(model, ctx);
    expect(ctx.ui.input).toHaveBeenCalledTimes(2);
    expect(ctx.ui.input).toHaveBeenLastCalledWith(
      expect.stringContaining("Use 1–64"),
      "local",
      expect.anything(),
    );
    expect(consented).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
  });
});

function manageHarness(options: { fixedMachine?: string; rebuild?: boolean; shared?: boolean }) {
  const saved = { ...defaultChoices("Saved Host"), label: "Saved label" };
  const apply = vi.fn<(plan: unknown) => void>();
  const consented = vi.fn<(action: string) => void>();
  const keep = vi.fn<() => void>();
  const form = manageForm({
    saved,
    note: "Peers is set up on this computer as saved-host.",
    ...(options.fixedMachine === undefined ? {} : { fixedMachine: options.fixedMachine }),
    ...(options.rebuild === false
      ? {}
      : { rebuild: (choices) => localPlan(choices, "/private/owned/s") }),
    shared: () => options.shared === true,
    details: (plan) => [plan === undefined ? "saved" : `edited ${plan.choices.label}`],
    apply,
    actions: () => [
      {
        id: "keep",
        label: "Keep and reconnect",
        value: "",
        activation: { kind: "consent", action: "Reconnect", run: keep },
      },
    ],
  });
  const root: Screen = {
    kind: "list",
    title: "Peers",
    rows: () => [
      {
        id: "setup",
        label: "Setup",
        value: "Manage",
        activation: { kind: "open", screen: () => form },
      },
    ],
  };
  const model = new MenuModel(root, { consented });
  model.activate("setup");
  return { model, apply, consented, keep, saved };
}
const row = (screen: Screen, id: string) => rows(screen).find((item) => item.id === id);

describe("Manage form", () => {
  test("shows the saved settings; Apply reads No changes and does nothing until an edit", async () => {
    const { model, apply, consented } = manageHarness({});
    expect(model.title()).toBe("Peers › Setup");
    expect(rows(model.top).map((item) => [item.label, item.value])).toStrictEqual([
      ["Machine", "saved-host"],
      ["Scope", "local"],
      ["Label", "Saved label"],
      ["Permissions", "2 of 2 on"],
      ["Review details", ""],
      ["Apply", "No changes"],
      ["Keep and reconnect", ""],
    ]);
    expect(row(model.top, "label")?.description).toBe("The name other sessions see for this Pi.");
    model.activate("apply");
    expect([apply.mock.calls.length, consented.mock.calls.length]).toStrictEqual([0, 0]);
    model.activate("label");
    await model.submit("Renamed");
    expect(row(model.top, "apply")?.value).toBe("Ready");
    model.activate("label");
    await model.submit("Saved label");
    expect(row(model.top, "apply")?.value).toBe("No changes");
    model.activate("permissions");
    model.toggle("push");
    model.back();
    consented.mockImplementation(() => {
      expect(apply).not.toHaveBeenCalled();
    });
    model.activate("apply");
    expect(consented).toHaveBeenCalledExactlyOnceWith("Apply");
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      choices: { permissions: ["discover"] },
      adapter: { socketPath: "/private/owned/s" },
    });
  });
  test("the other actions stay reachable on the same screen", () => {
    const { model, keep, consented } = manageHarness({});
    model.activate("keep");
    expect(consented).toHaveBeenCalledWith("Reconnect");
    expect(keep).toHaveBeenCalledOnce();
  });
  test("a paired Machine row is read-only and says why", () => {
    const { model } = manageHarness({
      fixedMachine: "Can't change here: the pair names it.",
    });
    const machine = row(model.top, "machineId");
    expect(machine).toMatchObject({
      value: "saved-host",
      description: "Can't change here: the pair names it.",
      activation: { kind: "none" },
    });
    model.activate("machineId");
    expect(model.title()).toBe("Peers › Setup");
  });
  test("an edit without a safe rebuild is Blocked and never consents", async () => {
    const { model, apply, consented } = manageHarness({ rebuild: false });
    model.activate("scopeId");
    await model.submit("team");
    expect(row(model.top, "apply")?.value).toBe(
      "Blocked: settings were edited by hand — change pi-peers.json by hand or Reset",
    );
    model.activate("apply");
    expect([apply.mock.calls.length, consented.mock.calls.length]).toStrictEqual([0, 0]);
  });
  test("a live shared gateway is disclosed in the Apply description", async () => {
    const { model } = manageHarness({ shared: true });
    model.activate("label");
    await model.submit("Other");
    expect(row(model.top, "apply")?.description).toContain("restarts the shared gateway once");
  });
  test("editState: unchanged, invalid, ready", () => {
    const saved = defaultChoices("State Host");
    const rebuild = (choices: typeof saved) => localPlan(choices, "/private/owned/s");
    expect(editState(saved, { ...saved }, rebuild)).toStrictEqual({
      kind: "unchanged",
    });
    expect(editState(saved, { ...saved, label: "" }, rebuild)).toStrictEqual({
      kind: "invalid",
      reason: "check Label",
    });
    expect(editState(saved, { ...saved, label: "x" }, rebuild).kind).toBe("ready");
  });
  test("the fresh form's Label defaults to the machine name", () => {
    expect(defaultChoices("Menu Host").label).toBe("menu-host");
  });
});
