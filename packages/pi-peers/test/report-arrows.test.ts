// Report, status, doctor and outcome text must not use `→` as a path separator: Pi wraps long
// lines, and a wrapped row that starts with `→ ` reads as SettingsList's cursor on a report screen
// (Bombadil's noCursorInViews). The menu breadcrumb separator is `›`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { diagnostics, statusSummary, statusText } from "../adapter/presentation.js";
import { doctor } from "../onboarding/doctor.js";
import { outcomeLines } from "../onboarding/menu/progress.js";
import { afterSave, failed, NotActive, pendingOutcome, SAVED_NEXT } from "../onboarding/outcome.js";

const peer = { machineId: "dev-01", sessionId: "s".repeat(36), runtimeNonce: "a".repeat(32) };

/** Every line of `text` that contains an arrow. */
function arrows(text: string): string[] {
  return text.split("\n").filter((line) => line.includes("→"));
}

describe("report text never uses → as a separator", () => {
  test.each([
    [{ enabled: true, status: "connected", peer, scopes: ["local"] }, "enabled"],
    [{ enabled: true, status: "activation_pending", peer }, "enabled"],
    [{ enabled: true, status: "activation_unconfirmed", peer }, "enabled"],
    [{ enabled: true, status: "disconnected", peer }, "enabled"],
    [{ enabled: false }, "enabled"],
    [undefined, "enabled"],
    [undefined, "configuration or startup failed. Check …"],
    [undefined, "participation disabled"],
    [undefined, "not enabled (no user-agent pi-peers.json)"],
  ])("status %j / %s", (status, diagnostic) => {
    expect(arrows(statusText(statusSummary(status, diagnostic)))).toStrictEqual([]);
    expect(arrows(statusText(statusSummary(status, diagnostic, { inMenu: true })))).toStrictEqual(
      [],
    );
    expect(arrows(diagnostics(status, diagnostic))).toStrictEqual([]);
  });

  test.each([
    ["pending", pendingOutcome("Settings saved")],
    ["after save", afterSave(new Error("busy"), ["detail"])],
    ["not active", afterSave(new NotActive("Pi is busy. Try again when idle."))],
    ["failed", failed("Setup failed", "refused", SAVED_NEXT, ["technical"])],
  ])("outcome: %s", (_name, outcome) => {
    expect(arrows(outcomeLines(outcome).join("\n"))).toStrictEqual([]);
  });

  test("doctor without a configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-peers-arrows-"));
    try {
      expect(arrows(await doctor(directory))).toStrictEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
