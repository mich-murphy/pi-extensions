import { describe, expect, test } from "vitest";
import piTerminology from "../index";
import type { TerminologyAPI } from "../index";

describe("terminology extension registration", () => {
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
      "terms",
      "terms-approve",
      "terms-auth-refresh",
      "terms-hide",
      "terms-restore",
      "terms-dismiss",
    ]);
    expect(shortcuts).toStrictEqual(["ctrl+shift+t"]);
    expect(events).toStrictEqual(["session_start", "session_shutdown", "input"]);
  });
});
