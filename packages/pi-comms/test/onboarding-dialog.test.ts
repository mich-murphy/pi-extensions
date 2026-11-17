import { describe, expect, test } from "vitest";
import { reviewAction, reviewLocal } from "../onboarding/dialog.js";
import { defaultChoices } from "../onboarding/plan.js";
import { dialog } from "./onboarding-fixtures.js";

const apply = "Apply — perform the listed changes and enable participation";
const details = () =>
  Array.from(
    { length: 20 },
    (_, index) => `Reviewed effect ${index}: private files, account trust and recovery`,
  ).join("\n");
const choices = defaultChoices("Dialog host");
describe("native onboarding dialog decisions (unit UI fixture, no acquisition)", () => {
  test.each([
    { field: "Machine identity", value: "changed-host", key: "machineId" as const },
    { field: "Scope", value: "team", key: "scopeId" as const },
    { field: "Session label", value: "Reviewed session", key: "label" as const },
  ])("edits $field and requires a fresh final Apply", async (entry) => {
    const ui = dialog(["Edit choices", entry.field, entry.value, apply]);
    const plan = await reviewLocal(ui, choices, "/private/owned/s", details);
    expect(plan?.choices[entry.key]).toBe(entry.value);
    expect(ui.ui.input).toHaveBeenCalledOnce();
    expect(ui.ui.select).toHaveBeenCalledTimes(3);
  });
  test("Back preserves inferred choices, not an implicit Apply", async () => {
    const plan = await reviewLocal(
      dialog(["Edit choices", "Back", apply]),
      choices,
      "/private/owned/s",
      details,
    );
    expect(plan?.choices).toStrictEqual(choices);
  });
  test("permission decisions retain only explicitly allowed grants", async () => {
    const plan = await reviewLocal(
      dialog(["Edit choices", "Permissions", "Allow", "Deny", "Allow", "Deny", apply]),
      choices,
      "/private/owned/s",
      details,
    );
    expect(plan?.choices.permissions).toStrictEqual(["discover", "push"]);
  });
  test.each(["Cancel", undefined])(
    "permission %s midway cancels the entire review",
    async (answer) => {
      await expect(
        reviewLocal(
          dialog(["Edit choices", "Permissions", "Deny", answer]),
          choices,
          "/private/owned/s",
          details,
        ),
      ).resolves.toBeUndefined();
    },
  );
  test.each([
    ["Edit choices", undefined],
    ["Edit choices", "Machine identity", undefined],
  ])("escape from field selection/input never returns an applied plan: %j", async (...answers) => {
    await expect(
      reviewLocal(dialog(answers), choices, "/private/owned/s", details),
    ).resolves.toBeUndefined();
  });
  test("invalid inferred input is explained and can be corrected before Apply", async () => {
    const ui = dialog(["Machine identity", "fixed-host", apply]);
    const plan = await reviewLocal(
      ui,
      { ...choices, machineId: "INVALID MACHINE" },
      "/private/owned/s",
      details,
    );
    expect(plan?.adapter.machineId).toBe("fixed-host");
    expect(ui.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid choices"),
      "warning",
    );
  });
  test("invalid choices followed by edit cancellation do not escape as a plan", async () => {
    await expect(
      reviewLocal(
        dialog([undefined]),
        { ...choices, machineId: "INVALID MACHINE" },
        "/private/owned/s",
        details,
      ),
    ).resolves.toBeUndefined();
  });
  test("details page forward/back navigation returns to mandatory review before Apply", async () => {
    const ui = dialog([
      "Review details",
      "Next details",
      "Previous details",
      "Back to review",
      apply,
    ]);
    const plan = await reviewLocal(ui, choices, "/private/owned/s", details);
    expect(plan?.choices).toStrictEqual(choices);
    expect(ui.ui.select).toHaveBeenCalledTimes(5);
    expect(ui.ui.select).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Plan details 1/"),
      ["Back to review", "Next details", "Cancel — no changes"],
      { timeout: 120_000 },
    );
  });
  test.each(["Cancel — no changes", "forged response", undefined])(
    "details %s cancels rather than approving",
    async (answer) => {
      await expect(
        reviewLocal(dialog(["Review details", answer]), choices, "/private/owned/s", details),
      ).resolves.toBeUndefined();
    },
  );
  test("maintenance details also require explicit final Apply", async () => {
    await expect(
      reviewAction(
        dialog(["Review details", "Next details", "Back to review", "Apply — maintenance"]),
        "Maintenance",
        details(),
        "Apply — maintenance",
      ),
    ).resolves.toBe(true);
  });
});
