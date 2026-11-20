import { describe, expect, test } from "vitest";
import { inputChoice, requireAttendedUI, selectChoice } from "../onboarding/dialog.js";
import { dialog } from "./onboarding-fixtures.js";

describe("attended RPC dialog validation", () => {
  test.each(["forged response", undefined])(
    "a select answer outside the offered set (%s) is back",
    async (answer) => {
      await expect(selectChoice(dialog([answer]), "Title", ["A", "B"])).resolves.toBeUndefined();
    },
  );
  test("an offered answer is returned with the 120 s timeout", async () => {
    const ctx = dialog(["B"]);
    await expect(selectChoice(ctx, "Title", ["A", "B"])).resolves.toBe("B");
    expect(ctx.ui.select).toHaveBeenCalledWith("Title", ["A", "B"], { timeout: 120_000 });
  });
  test("an aborted signal answers nothing and shows nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...dialog(["A"]), signal: controller.signal };
    await expect(selectChoice(ctx, "Title", ["A"])).resolves.toBeUndefined();
    await expect(inputChoice(ctx, "Title", "x")).resolves.toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
  test.each(["print", "json"] as const)("%s mode refuses mutations", (mode) => {
    expect(() => {
      requireAttendedUI(dialog([], mode));
    }).toThrow("attended RPC");
  });
});
