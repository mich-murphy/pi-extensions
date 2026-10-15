import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { TerminologyExtension } from "../index";
import type { TerminologyCommandContext } from "../index";
import { TerminologyStateStore } from "../state";

const roots: string[] = [];

async function unusedCustomUi<T>(): Promise<T> {
  throw new Error("custom UI not used");
}

function commandFixture(confirmResult: boolean, prefix = "terms-command-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi", "terminology.json"), "{}");
  const notices: { readonly message: string; readonly type: string | undefined }[] = [];
  const confirms: { readonly title: string; readonly message: string }[] = [];
  const ctx: TerminologyCommandContext = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    modelRegistry: {
      findOfType: () => undefined,
      classify: async () => ({
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-1.13.0",
        answers: {},
        stopReason: "error",
        timestamp: Date.now(),
      }),
      getProviderAuthStatus: () => ({ configured: false }),
      getApiKeyAndHeaders: async () => ({ ok: false, error: "No API key" }),
    },
    sessionManager: { getSessionId: () => "session-a" },
    ui: {
      notify: (message, type) => {
        notices.push({ message, type });
      },
      confirm: async (title, message) => {
        confirms.push({ title, message });
        return confirmResult;
      },
      custom: unusedCustomUi,
      setWidget: () => undefined,
    },
  };
  return {
    ctx,
    notices,
    confirms,
    root,
    store: new TerminologyStateStore(join(root, "state.json")),
  };
}

const classifierModel = {
  type: "classifier",
  id: "jev-latest",
  name: "Jev",
  api: "typesafe-system-one",
  provider: "typesafe",
  baseUrl: "https://api.typesafe.ai/v1/",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64_000,
} satisfies ClassifierModel<ClassifierApi>;

describe("terminology commands", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approves the canonical project glossary path without trusting project resources", async () => {
    const fixture = commandFixture(true);
    const extension = new TerminologyExtension(fixture.store);
    await extension.approve("", fixture.ctx);
    expect(fixture.confirms[0]?.message).toContain("/terminology.json");
    expect(fixture.store.load().approvedGlossaries.size).toBe(1);
    expect(fixture.notices.at(-1)).toStrictEqual({
      message: "Terminology glossary approved.",
      type: "info",
    });
  });

  test("escapes unsafe canonical path for consent while storing the real path", async () => {
    const fixture = commandFixture(true, "terms-\u001B[31m-");
    await new TerminologyExtension(fixture.store).approve("", fixture.ctx);
    expect(fixture.confirms).toHaveLength(1);
    const message = fixture.confirms.map((confirm) => confirm.message).join("\n");
    expect(message).toContain(String.raw`\u001B[31m`);
    expect(message).not.toContain("\u001B");
    expect([...fixture.store.load().approvedGlossaries]).toStrictEqual([
      realpathSync(join(fixture.root, ".pi", "terminology.json")),
    ]);
  });

  test("refreshes native auth on explicit command", async () => {
    const fixture = commandFixture(true);
    const ctx: TerminologyCommandContext = {
      ...fixture.ctx,
      modelRegistry: {
        ...fixture.ctx.modelRegistry,
        findOfType: () => classifierModel,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic" }),
      },
    };
    await new TerminologyExtension(fixture.store).refreshAuth("", ctx);
    expect(fixture.notices.at(-1)).toStrictEqual({
      message: "Terminology classifier authentication is ready.",
      type: "info",
    });
  });

  test("rejects bad usage and preserves state when approval is declined", async () => {
    const badUsage = commandFixture(true);
    const extension = new TerminologyExtension(badUsage.store);
    await extension.approve("extra", badUsage.ctx);
    expect(badUsage.notices.at(-1)).toStrictEqual({
      message: "Usage: /terms-approve",
      type: "error",
    });

    const declined = commandFixture(false);
    await new TerminologyExtension(declined.store).approve("", declined.ctx);
    expect(declined.store.load().approvedGlossaries.size).toBe(0);
    expect(declined.notices.at(-1)).toStrictEqual({
      message: "Terminology glossary was not approved.",
      type: "info",
    });
  });
});
