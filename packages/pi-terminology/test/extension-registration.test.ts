import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loadCatalogue } from "../catalogue";
import piTerminology from "../index";
import type { TerminologyAPI } from "../index";

describe("terminology extension registration", () => {
  test("root package enables the extension without promoting the unmeasured policy", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({
      pi: { extensions: expect.arrayContaining(["./packages/pi-terminology/index.ts"]) },
    });
    expect(loadCatalogue().policy.measured).toBe(false);
  });
  test("registers commands and raw input lifecycle handlers without activating globally", () => {
    const commands: string[] = [];
    const events: string[] = [];
    const shortcuts: string[] = [];
    const api: TerminologyAPI = {
      registerCommand: (name) => {
        commands.push(name);
      },
      registerShortcut: (shortcut) => {
        shortcuts.push(shortcut);
      },
      on: (event) => {
        events.push(event);
        return () => undefined;
      },
    };
    piTerminology(api);
    expect(commands).toStrictEqual([
      "terminology",
      "terminology-preview",
      "terminology-status",
      "terminology-approve",
      "terminology-auth-refresh",
      "terminology-hide",
      "terminology-restore",
      "terminology-dismiss",
    ]);
    expect(shortcuts).toStrictEqual(["ctrl+shift+t"]);
    expect(events).toStrictEqual(["session_start", "session_shutdown", "input"]);
  });
});
