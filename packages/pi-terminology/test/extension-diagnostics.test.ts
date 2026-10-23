import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TerminologyExtension } from "../index";
import type { TerminologyCommandContext } from "../index";
import { TerminologyStateStore } from "../state";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "terms-diagnostics-"));
  roots.push(root);
  const path = join(root, "state.json");
  const notify = vi.fn<TerminologyCommandContext["ui"]["notify"]>();
  const classify = vi.fn<TerminologyCommandContext["modelRegistry"]["classify"]>(() => {
    throw new Error("Diagnostics must not classify");
  });
  const resolveKey = vi.fn<TerminologyCommandContext["modelRegistry"]["getApiKeyAndHeaders"]>(
    () => {
      throw new Error("Diagnostics must not resolve credentials or refresh auth");
    },
  );
  const ctx: TerminologyCommandContext = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    sessionManager: { getSessionId: () => "diagnostics-only" },
    modelRegistry: {
      findOfType: () => undefined,
      classify,
      getProviderAuthStatus: () => ({ configured: false }),
      getApiKeyAndHeaders: resolveKey,
    },
    ui: {
      notify,
      setWidget: () => undefined,
      confirm: async () => false,
      custom: async () => {
        throw new Error("Status must not open browser UI");
      },
    },
  };
  return {
    path,
    notify,
    classify,
    resolveKey,
    ctx,
    extension: new TerminologyExtension(new TerminologyStateStore(path)),
  };
}

describe("offline terminology diagnostics", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports 51 concepts, unmeasured policy and TUI auth readiness without a provider call or preference mutation", () => {
    const f = fixture();
    const bytes = JSON.stringify({
      version: 1,
      approvedGlossaries: ["/not-read-by-status/terminology.json"],
      hiddenConceptIds: ["core:deep-module"],
      noticeKeys: ["keep-this-preference"],
      cooldowns: { "core:refactoring": 12_345 },
    });
    writeFileSync(f.path, bytes);
    f.extension.status("", f.ctx);
    const message = f.notify.mock.calls.map(([text]) => text).join("\n");
    expect(message).toContain("51 concepts");
    expect(message).toContain("unmeasured; automatic reminders disabled");
    expect(message).toContain("Mode: tui");
    expect(message).toContain("not configured");
    expect(message).toContain("not ready");
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.resolveKey).not.toHaveBeenCalled();
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
  });

  test("corrupt JSON uses bundled read-only fallback, warns, and leaves exact bad bytes untouched", () => {
    const f = fixture();
    const bytes = "{invalid JSON\n";
    writeFileSync(f.path, bytes);
    expect(() => {
      f.extension.status("", f.ctx);
    }).not.toThrow();
    const message = f.notify.mock.calls.map(([text]) => text).join("\n");
    expect(message).toContain("state could not be read");
    expect(message).toContain("has not been overwritten");
    expect(message).toContain("51 concepts");
    expect(message).toContain("automatic reminders disabled");
    expect(readFileSync(f.path, "utf8")).toBe(bytes);
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.resolveKey).not.toHaveBeenCalled();
  });

  test("rejects status arguments without loading state or consulting native auth", () => {
    const f = fixture();
    writeFileSync(f.path, "{invalid JSON");
    f.extension.status("unexpected", f.ctx);
    expect(f.notify).toHaveBeenCalledExactlyOnceWith("Usage: /terminology-status", "error");
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.resolveKey).not.toHaveBeenCalled();
  });
});
