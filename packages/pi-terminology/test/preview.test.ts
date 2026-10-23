import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { afterEach, assert, describe, expect, test, vi } from "vitest";
import { loadCatalogue } from "../catalogue";
import { classifierState, classifierWireQuestions, JEV_MODEL_ID } from "../classifier-request";
import { TerminologyExtension } from "../index";
import type { TerminologyCommandContext } from "../index";
import {
  PREVIEW_MAX_WIRE_BYTES,
  previewBinding,
  previewRequestFits,
  validatePreviewPolicy,
} from "../preview-policy";
import type { PreviewAvailability, PreviewPolicy } from "../preview-policy";
import { selectMatches } from "../selection";
import { TerminologyStateStore } from "../state";
import { renderReminder } from "../ui";

const settle = async () => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};
describe("experimental preview", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });
  function fixture(gaps = ["Failed precision gates; unmeasured"]) {
    const root = mkdtempSync(join(tmpdir(), "terms-preview-"));
    roots.push(root);
    const statePath = join(root, "state.json");
    const loaded = loadCatalogue();
    const binding = previewBinding(loaded.catalogue);
    const policy: PreviewPolicy = {
      ...binding,
      schemaVersion: 1,
      developmentOnly: true,
      measured: false,
      promotable: false,
      acceptanceStatus: "not-validated",
      gaps,
      conceptThresholds: Object.fromEntries(
        loaded.catalogue.recognition.map((r) => [r.conceptId, 0.9]),
      ),
    };
    let availability: PreviewAvailability = { ok: true, policy };
    const classify = vi.fn<TerminologyCommandContext["modelRegistry"]["classify"]>(async () => {
      throw new Error("synthetic failure");
    });
    const confirm = vi.fn<TerminologyCommandContext["ui"]["confirm"]>(async () => true);
    const notify = vi.fn<TerminologyCommandContext["ui"]["notify"]>();
    const setWidget = vi.fn<(key: string, content: unknown, options?: unknown) => void>();
    const auth = vi.fn<TerminologyCommandContext["modelRegistry"]["getApiKeyAndHeaders"]>(
      async () => ({ ok: true as const, apiKey: "fake-test-only" }),
    );
    const ctx: TerminologyCommandContext = {
      cwd: root,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "a" },
      modelRegistry: {
        findOfType: () => ({
          type: "classifier",
          id: "jev-latest",
          name: "Jev",
          api: "typesafe-system-one",
          provider: "typesafe",
          baseUrl: "https://invalid.test",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 65_536,
        }),
        classify,
        getProviderAuthStatus: () => ({ configured: true }),
        getApiKeyAndHeaders: auth,
      },
      ui: {
        notify,
        setWidget,
        confirm,
        custom: async () => {
          throw new Error("browser not used");
        },
      },
    };
    const extension = new TerminologyExtension(
      new TerminologyStateStore(statePath),
      () => loaded,
      () => availability,
    );
    const input = () =>
      extension.input({ text: "Please change the implementation", source: "interactive" }, ctx);
    return {
      extension,
      ctx,
      policy,
      binding,
      loaded,
      classify,
      confirm,
      notify,
      auth,
      setWidget,
      input,
      statePath,
      unavailable: () => {
        availability = { ok: false, reason: "missing" };
      },
      mutate: () => {
        availability = {
          ok: true,
          policy: { ...policy, sourceHashes: { ...policy.sourceHashes, "index.ts": "mutated" } },
        };
      },
    };
  }

  test("whole-wire byte guard admits short requests and rejects oversized ASCII and multibyte without changing input", async () => {
    const f = fixture();
    expect(previewRequestFits(f.loaded.catalogue, "Please improve this code")).toBe(true);
    expect(previewRequestFits(f.loaded.catalogue, "a".repeat(40_000))).toBe(false);
    expect(previewRequestFits(f.loaded.catalogue, "界".repeat(20_000))).toBe(false);
    f.extension.sessionStart(f.ctx);
    await settle();
    await f.extension.preview("on 2", f.ctx);
    for (const text of ["a".repeat(40_000), "界".repeat(20_000)]) {
      expect(f.extension.input({ text, source: "interactive" }, f.ctx)).toStrictEqual({
        action: "continue",
      });
      await settle();
    }
    expect(f.classify).not.toHaveBeenCalled();
    expect(
      f.notify.mock.calls.filter(([message]) => message.includes("63 KiB safety limit")),
    ).toHaveLength(1);
    await f.extension.preview("status", f.ctx);
    expect(f.notify.mock.lastCall?.[0]).toContain("calls remaining: 2");
    f.input();
    await settle();
    expect(f.classify).toHaveBeenCalledTimes(1);
  });

  test.each(["a", "界"])(
    "whole-wire guard enforces the exact UTF-8 boundary for %s",
    (character) => {
      const f = fixture();
      const emptyBytes = Buffer.byteLength(
        JSON.stringify({
          model: JEV_MODEL_ID,
          state: classifierState(f.loaded.catalogue, ""),
          questions: classifierWireQuestions(f.loaded.catalogue),
        }),
      );
      const count = Math.floor(
        (PREVIEW_MAX_WIRE_BYTES - emptyBytes) / (2 * Buffer.byteLength(character)),
      );
      expect(previewRequestFits(f.loaded.catalogue, character.repeat(count))).toBe(true);
      expect(previewRequestFits(f.loaded.catalogue, character.repeat(count + 1))).toBe(false);
    },
  );

  test("consent puts rounded-up cost first and bounds long gaps to two brief summaries", async () => {
    const f = fixture(["first ".repeat(100), "second ".repeat(100), "third hidden gap"]);
    f.extension.sessionStart(f.ctx);
    await settle();
    await f.extension.preview("on", f.ctx);
    const consent = f.confirm.mock.calls[0]?.[1];
    assert(typeof consent === "string");
    const lines = consent.split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("Sends current request text to TypeSafe jev-1.13.0: 20 attempts");
    expect(lines[1]).toContain("$0.0551; main Pi model usage additional");
    expect(lines[2]).toContain("not invoice; unvalidated");
    expect(lines[4]).toContain("Gaps (3):");
    expect(consent).not.toContain("third hidden gap");
    expect(consent.length).toBeLessThan(450);
    expect(f.classify).not.toHaveBeenCalled();
  });

  test("candidate validation binds full catalogue, native sources, wire, profile and all cutoffs without production measurement", () => {
    const f = fixture();
    expect(validatePreviewPolicy(f.policy, f.loaded.catalogue, f.binding).ok).toBe(true);
    expect(Object.keys(f.binding.sourceHashes).toSorted()).toStrictEqual([
      "classifier-request.ts",
      "index.ts",
      "native-matcher.ts",
      "preview-policy.ts",
      "selection.ts",
      "ui.ts",
    ]);
    for (const name of Object.keys(f.binding.sourceHashes)) {
      expect(
        validatePreviewPolicy(
          { ...f.policy, sourceHashes: { ...f.policy.sourceHashes, [name]: "mutated" } },
          f.loaded.catalogue,
          f.binding,
        ).ok,
      ).toBe(false);
    }
    for (const change of [
      { measured: true },
      { promotable: true },
      { developmentOnly: false },
      { sourceHashes: {} },
      { profileHash: "other" },
      { wireCriteriaHash: "other" },
      { catalogueHash: "other" },
      { conceptThresholds: {} },
      { gaps: [] },
      { model: "other" },
    ]) {
      expect(
        validatePreviewPolicy({ ...f.policy, ...change }, f.loaded.catalogue, f.binding).ok,
      ).toBe(false);
    }
    expect(validatePreviewPolicy(null, f.loaded.catalogue, f.binding).ok).toBe(false);
    expect(validatePreviewPolicy({ schemaVersion: 1 }, f.loaded.catalogue, f.binding).ok).toBe(
      false,
    );
    expect(f.loaded.policy.measured).toBe(false);
  });

  test("explicit confirmation only; failures reserve allowance, no refunds/retries, warning once, snapshots never resolve auth", async () => {
    const f = fixture();
    f.extension.sessionStart(f.ctx);
    await settle();
    f.input();
    await settle();
    expect(f.classify).not.toHaveBeenCalled();
    f.confirm.mockResolvedValueOnce(false);
    await f.extension.preview("on 2", f.ctx);
    f.input();
    await settle();
    expect(f.classify).not.toHaveBeenCalled();
    await f.extension.preview("on 2", f.ctx);
    expect(f.confirm.mock.calls[1]?.[1]).toContain("jev-1.13.0");
    expect(f.classify).not.toHaveBeenCalled();
    f.input();
    await settle();
    f.input();
    await settle();
    f.input();
    await settle();
    expect(f.classify).toHaveBeenCalledTimes(2);
    expect(f.classify.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, timeoutMs: 5000 });
    expect(f.notify.mock.calls.filter(([m]) => m.includes("allowance exhausted"))).toHaveLength(1);
    const authCount = f.auth.mock.calls.length;
    f.extension.status("", f.ctx);
    await f.extension.preview("status", f.ctx);
    expect(f.auth).toHaveBeenCalledTimes(authCount);
    expect(f.notify.mock.lastCall?.[0]).toContain("calls remaining: 0");
    expect(f.loaded.policy.measured).toBe(false);
    f.extension.sessionStart(f.ctx);
    await settle();
    f.input();
    await settle();
    expect(f.classify).toHaveBeenCalledTimes(2);
  });

  test("noninteractive, missing candidate and corrupt state fail closed and preserve bytes", async () => {
    const f = fixture();
    f.extension.sessionStart(f.ctx);
    await settle();
    await f.extension.preview("on", { ...f.ctx, mode: "rpc" });
    await f.extension.preview("on", { ...f.ctx, hasUI: false });
    expect(f.confirm).not.toHaveBeenCalled();
    f.unavailable();
    await f.extension.preview("on", f.ctx);
    expect(f.confirm).not.toHaveBeenCalled();
    const g = fixture();
    g.extension.sessionStart(g.ctx);
    await settle();
    writeFileSync(g.statePath, "{broken");
    await g.extension.preview("on", g.ctx);
    expect(g.confirm).not.toHaveBeenCalled();
    expect(readFileSync(g.statePath, "utf8")).toBe("{broken");
  });

  test("off clears pending work immediately and candidate changes disable instead of rerunning", async () => {
    const f = fixture();
    f.extension.sessionStart(f.ctx);
    await settle();
    await f.extension.preview("on 1", f.ctx);
    f.input();
    await f.extension.preview("off", f.ctx);
    await settle();
    expect(f.classify).not.toHaveBeenCalled();
    expect(f.setWidget.mock.lastCall?.[1]).toBeUndefined();
    await f.extension.preview("on 1", f.ctx);
    f.unavailable();
    f.input();
    await settle();
    expect(f.classify).not.toHaveBeenCalled();
    await f.extension.preview("status", f.ctx);
    expect(f.notify.mock.lastCall?.[0]).toContain("preview: off");
  });

  test.each(["remove", "mutate"] as const)(
    "%s pending candidate fails closed after reserved native work without refund or retry",
    async (change) => {
      const f = fixture();
      let complete!: (result: ClassifierResult) => void;
      const pending = new Promise<ClassifierResult>((resolve) => {
        complete = resolve;
      });
      f.classify.mockImplementationOnce(async () => pending);
      f.extension.sessionStart(f.ctx);
      await settle();
      await f.extension.preview("on 2", f.ctx);
      f.input();
      await settle();
      expect(f.classify).toHaveBeenCalledTimes(1);
      await f.extension.preview("status", f.ctx);
      expect(f.notify.mock.lastCall?.[0]).toContain("calls remaining: 1");
      const invalidate = { remove: f.unavailable, mutate: f.mutate }[change];
      invalidate();
      complete({
        api: "typesafe-system-one",
        provider: "typesafe",
        model: "jev-1.13.0",
        timestamp: Date.now(),
        stopReason: "stop",
        answers: Object.fromEntries(
          f.loaded.catalogue.recognition.map((r) => [
            r.conceptId,
            { type: "bool" as const, probability: 0.99 },
          ]),
        ),
      });
      await settle();
      expect(f.setWidget.mock.lastCall?.[1]).toBeUndefined();
      expect(f.classify.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
      expect(f.notify.mock.lastCall?.[0]).toContain("attempt remains consumed");
      expect(() => readFileSync(f.statePath)).toThrow(/ENOENT/u);
      await f.extension.preview("status", f.ctx);
      expect(f.notify.mock.lastCall?.[0]).toContain("preview: off; calls remaining: 0");
      f.input();
      await settle();
      expect(f.classify).toHaveBeenCalledTimes(1);
    },
  );

  test("preview renders three visible names, leaves fourth eligible, and final allowed response experimental", async () => {
    const f = fixture();
    f.classify.mockResolvedValue({
      api: "typesafe-system-one",
      provider: "typesafe",
      model: "jev-1.13.0",
      timestamp: Date.now(),
      stopReason: "stop",
      answers: Object.fromEntries(
        f.loaded.catalogue.recognition.map((r) => [
          r.conceptId,
          { type: "bool" as const, probability: 0.99 },
        ]),
      ),
    });
    f.extension.sessionStart(f.ctx);
    await settle();
    await f.extension.preview("on 2", f.ctx);
    const eligible = selectMatches(
      f.loaded.catalogue.recognition.map((recognition) => ({
        concept: recognition.concept,
        recognition,
        probability: 0.99,
        tip: recognition.tip,
      })),
      { hiddenConceptIds: new Set(), dismissedConceptIds: new Set(), cooldowns: new Map() },
      Date.now(),
      new Set(),
    );
    expect(eligible.length).toBeGreaterThan(3);
    f.input();
    await settle();
    const displayed = f.setWidget.mock.lastCall?.[1];
    expect(displayed).toHaveLength(1);
    expect(displayed).toStrictEqual(
      renderReminder(eligible.slice(0, 3)).map((line) => `EXPERIMENTAL (unmeasured): ${line}`),
    );
    expect(JSON.stringify(displayed)).not.toContain("more");
    expect(() => readFileSync(f.statePath)).toThrow(/ENOENT/u);
    f.input();
    await settle();
    expect(f.setWidget.mock.lastCall?.[1]).toStrictEqual(
      renderReminder(eligible.slice(3, 6)).map((line) => `EXPERIMENTAL (unmeasured): ${line}`),
    );
    expect(() => readFileSync(f.statePath)).toThrow(/ENOENT/u);
    await f.extension.preview("status", f.ctx);
    expect(f.notify.mock.lastCall?.[0]).toContain("preview: off; calls remaining: 0");
    await f.extension.preview("off", f.ctx);
    const restarted = new TerminologyExtension(
      new TerminologyStateStore(f.statePath),
      () => f.loaded,
      () => ({ ok: true, policy: f.policy }),
    );
    restarted.sessionStart(f.ctx);
    await settle();
    restarted.input({ text: "Change code", source: "interactive" }, f.ctx);
    await settle();
    expect(f.classify).toHaveBeenCalledTimes(2);
  });
});
