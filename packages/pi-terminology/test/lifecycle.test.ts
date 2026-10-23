import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TerminologyExtension } from "../index";
import { TerminologyStateStore } from "../state";
import type { Catalogue, Policy } from "../types";

type InputContext = Parameters<TerminologyExtension["input"]>[1];

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly complete: (value: T) => void;
};

const roots: string[] = [];

function extensionFixture(mode: "tui" | "rpc" = "tui") {
  const root = mkdtempSync(join(tmpdir(), "terms-life-"));
  roots.push(root);
  const widgets: {
    readonly lines: readonly string[] | undefined;
    readonly placement?: string;
  }[] = [];
  const notices: { readonly message: string; readonly type: string | undefined }[] = [];
  let classifyCalls = 0;
  const registry: InputContext["modelRegistry"] = {
    findOfType: () => undefined,
    classify: async () => {
      classifyCalls += 1;
      return {
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-1.13.0",
        answers: {},
        stopReason: "error" as const,
        timestamp: Date.now(),
      };
    },
    getProviderAuthStatus: () => ({ configured: false }),
    getApiKeyAndHeaders: async () => ({ ok: false, error: "No API key" }),
  };
  const ctx: InputContext = {
    cwd: root,
    mode,
    hasUI: true,
    modelRegistry: registry,
    sessionManager: { getSessionId: () => "session-a" },
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notices.push({ message, type });
      },
      setWidget: (_key, content, options) => {
        widgets.push({
          lines: Array.isArray(content) ? content : undefined,
          ...(options?.placement === undefined ? {} : { placement: options.placement }),
        });
      },
    },
  };
  return {
    ctx,
    widgets,
    notices,
    classifyCalls: () => classifyCalls,
    extension: new TerminologyExtension(new TerminologyStateStore(join(root, "state.json"))),
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function deferred<T>(): Deferred<T> {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, complete };
}

const concept = {
  id: "core:mutation-testing",
  label: "mutation testing",
  domain: "testing",
  definition: "definition",
  references: [{ kind: "web", title: "Source", url: "https://example.com" }],
} as const;
const recognition = {
  conceptId: concept.id,
  matches: "mutate production",
  doesNotMatch: "ordinary edits",
  tip: "A term for this activity is mutation testing.",
  concept,
  question: {
    type: "bool",
    instructions: "Does it match?",
    criteria: { true: "yes", false: "no" },
  },
} as const;
const catalogue: Catalogue = { concepts: [concept], recognition: [recognition], hash: "hash" };
const measuredPolicy: Policy = {
  schemaVersion: 1,
  model: "jev-1.13.0",
  catalogueHash: "hash",
  criteriaHash: "criteria",
  fixtureHash: "a".repeat(64),
  threshold: 0.95,
  measuredDisplayedPrecision: 0.95,
  measured: true,
};

function measuredFixture() {
  const root = mkdtempSync(join(tmpdir(), "terms-stale-"));
  roots.push(root);
  const widgets: { readonly lines: readonly string[] | undefined; readonly placement?: string }[] =
    [];
  const first =
    deferred<
      ReturnType<InputContext["modelRegistry"]["classify"]> extends Promise<infer T> ? T : never
    >();
  let classifyCalls = 0;
  const registry: InputContext["modelRegistry"] = {
    findOfType: () => ({
      type: "classifier",
      id: "jev-latest",
      name: "Jev",
      api: "typesafe-system-one",
      provider: "typesafe",
      baseUrl: "https://api.typesafe.ai/v1/",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64_000,
    }),
    classify: async () => {
      classifyCalls += 1;
      return first.promise;
    },
    getProviderAuthStatus: () => ({ configured: true }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic" }),
  };
  const ctx: InputContext = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    modelRegistry: registry,
    sessionManager: { getSessionId: () => "session-a" },
    ui: {
      notify: () => undefined,
      setWidget: (_key, content, options) => {
        widgets.push({
          lines: Array.isArray(content) ? content : undefined,
          ...(options?.placement === undefined ? {} : { placement: options.placement }),
        });
      },
    },
  };
  const extension = new TerminologyExtension(
    new TerminologyStateStore(join(root, "state.json")),
    () => ({
      catalogue,
      policy: measuredPolicy,
    }),
  );
  return { ctx, extension, first, widgets, classifyCalls: () => classifyCalls };
}

describe("terminology lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("interactive input returns continue immediately and leaves the prompt untouched", async () => {
    const fixture = extensionFixture();
    const prompt = "Please change production code to see whether tests catch it.";
    const result = fixture.extension.input({ text: prompt, source: "interactive" }, fixture.ctx);
    expect(result).toStrictEqual({ action: "continue" });
    expect(prompt).toBe("Please change production code to see whether tests catch it.");
    await settle();
    expect(fixture.classifyCalls()).toBe(0);
    expect(fixture.widgets.at(-1)).toStrictEqual({ lines: undefined, placement: "aboveEditor" });
  });

  test("does not classify RPC, extension, slash, image or oversized inputs", async () => {
    const fixture = extensionFixture("rpc");
    expect(
      fixture.extension.input({ text: "use terms", source: "interactive" }, fixture.ctx),
    ).toStrictEqual({ action: "continue" });
    const tui = extensionFixture();
    tui.extension.input({ text: "use terms", source: "rpc" }, tui.ctx);
    tui.extension.input({ text: "/terminology", source: "interactive" }, tui.ctx);
    tui.extension.input(
      { text: "describe screenshot", source: "interactive", images: [{}] },
      tui.ctx,
    );
    tui.extension.input({ text: "x".repeat(60_001), source: "interactive" }, tui.ctx);
    await settle();
    expect(fixture.classifyCalls()).toBe(0);
    expect(tui.classifyCalls()).toBe(0);
    expect(tui.widgets.at(-1)).toStrictEqual({ lines: undefined, placement: "aboveEditor" });
  });

  test("every new model-bound input invalidates stale pending reminders", async () => {
    const fixture = measuredFixture();
    fixture.extension.sessionStart(fixture.ctx);
    await settle();
    fixture.extension.input(
      { text: "Change production code to see whether tests catch it.", source: "interactive" },
      fixture.ctx,
    );
    await settle();
    expect(fixture.classifyCalls()).toBe(1);
    fixture.extension.input({ text: "generated follow-up", source: "extension" }, fixture.ctx);
    fixture.first.complete({
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-1.13.0",
      answers: { [concept.id]: { type: "bool", probability: 0.99 } },
      stopReason: "stop",
      timestamp: 1,
    });
    await settle();
    await settle();
    expect(fixture.classifyCalls()).toBe(1);
    expect(fixture.widgets.at(-1)).toStrictEqual({ lines: undefined, placement: "aboveEditor" });
  });

  test("discards classifier results completed after the advisory deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
    const fixture = measuredFixture();
    fixture.extension.sessionStart(fixture.ctx);
    await settle();
    fixture.extension.input(
      { text: "Change production code to see whether tests catch it.", source: "interactive" },
      fixture.ctx,
    );
    await settle();
    expect(fixture.classifyCalls()).toBe(1);
    vi.setSystemTime(new Date("2026-10-14T00:00:06Z"));
    fixture.first.complete({
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-1.13.0",
      answers: { [concept.id]: { type: "bool", probability: 0.99 } },
      stopReason: "stop",
      timestamp: 1,
    });
    await settle();
    await settle();
    expect(fixture.widgets.at(-1)).toStrictEqual({ lines: undefined, placement: "aboveEditor" });
  });

  test("session start and shutdown invalidate pending generations", async () => {
    const fixture = extensionFixture();
    fixture.extension.sessionStart(fixture.ctx);
    expect(fixture.widgets.at(-1)).toStrictEqual({ lines: undefined, placement: "aboveEditor" });
    fixture.extension.input({ text: "name this behavior", source: "interactive" }, fixture.ctx);
    fixture.extension.cancelAll();
    await settle();
    expect(fixture.widgets.at(-1)).toStrictEqual({ lines: undefined, placement: "aboveEditor" });
    expect(fixture.classifyCalls()).toBe(0);
  });
});
