import { describe, expect, test } from "vitest";
import { onOffCommand } from "../on-off-command";
import type { OnOffContext, OnOffOptions } from "../on-off-command";

type Notice = readonly [string, "info" | "warning"];

function harness(note?: (enabled: boolean) => string) {
  const notices: Array<Notice> = [];
  const applied: Array<boolean> = [];
  let state = true;

  const options: Omit<OnOffOptions<OnOffContext>, "note"> & {
    note?: (enabled: boolean) => string;
  } = {
    name: "demo",
    label: "Demo",
    description: "Turn demo on or off",
    enabled: () => state,
    apply: (enabled) => {
      state = enabled;
      applied.push(enabled);
    },
  };

  if (note !== undefined) {
    options.note = note;
  }

  const command = onOffCommand(options);

  const ctx = {
    ui: { notify: (message: string, type: "info" | "warning") => notices.push([message, type]) },
  };

  return { command, notices, applied, run: async (args: string) => command.handler(args, ctx) };
}

describe("onOffCommand", () => {
  test("completes on and off by prefix", () => {
    const { command } = harness();
    expect(command.getArgumentCompletions("")).toStrictEqual([
      { value: "on", label: "on" },
      { value: "off", label: "off" },
    ]);
    expect(command.getArgumentCompletions("of")).toStrictEqual([{ value: "off", label: "off" }]);
    expect(command.getArgumentCompletions("x")).toStrictEqual([]);
  });

  test("no argument toggles", async () => {
    const { run, applied, notices } = harness();
    await run("  ");
    await run("");
    expect(applied).toStrictEqual([false, true]);
    expect(notices).toStrictEqual([
      ["Demo is off for this session.", "info"],
      ["Demo is on for this session.", "info"],
    ]);
  });

  test("explicit on and off set the state without toggling", async () => {
    const { run, applied } = harness();
    await run("off");
    await run("off");
    await run(" on ");
    expect(applied).toStrictEqual([false, false, true]);
  });

  test("an invalid argument warns and changes nothing", async () => {
    const { run, applied, notices } = harness();
    await run("maybe");
    expect(applied).toStrictEqual([]);
    expect(notices).toStrictEqual([["Usage: /demo [on|off]", "warning"]]);
  });

  test("applies the new state before showing its confirmation", async () => {
    const order: Array<string> = [];

    const command = onOffCommand({
      name: "demo",
      label: "Demo",
      description: "Turn demo on or off",
      enabled: () => true,
      apply: () => order.push("apply"),
      note: () => {
        order.push("note");

        return "";
      },
    });

    await command.handler("off", { ui: { notify: () => order.push("notify") } });
    expect(order).toStrictEqual(["apply", "note", "notify"]);
  });

  test("appends the note to the confirmation", async () => {
    const { run, notices } = harness((enabled) => ` Requested: ${String(enabled)}.`);
    await run("off");
    expect(notices).toStrictEqual([["Demo is off for this session. Requested: false.", "info"]]);
  });
});
