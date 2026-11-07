import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { decodeConfiguration, loadConfiguration } from "../adapter/config.js";
import { sendWithRetries } from "../adapter/send.js";
import { ConnectionFailure } from "../adapter/transport.js";
import { waitFor } from "../adapter/wait.js";

describe("adapter configuration and retry boundaries", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const path of directories.splice(0)) {
      await rm(path, { recursive: true, force: true });
    }
  });
  const sender = { machineId: "alpha", sessionId: "one", runtimeNonce: "1".repeat(32) };
  const recipient = { machineId: "beta", sessionId: "two", runtimeNonce: "2".repeat(32) };
  const config = {
    machineId: "alpha",
    socketPath: "/tmp/gateway.sock",
    scopeIds: ["team"],
    label: "label",
    policies: [],
  };

  test("user configuration absent, valid, oversized, unreadable, and invalid files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "psc-config-"));
    directories.push(directory);
    const path = join(directory, "session-communication.json");
    await expect(loadConfiguration(directory)).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify(config));
    await expect(loadConfiguration(directory)).resolves.toStrictEqual(config);
    await writeFile(path, " ".repeat(32_769));
    await expect(loadConfiguration(directory)).rejects.toThrow("could not be loaded");
    await writeFile(path, "{broken");
    await expect(loadConfiguration(directory)).rejects.toThrow("Invalid session");
    await rm(path);
    await mkdir(path);
    await expect(loadConfiguration(directory)).rejects.toThrow("could not be loaded");
  });

  test.each([
    { socketPath: "relative.sock" },
    { socketPath: `/tmp/${"a".repeat(104)}` },
    { socketPath: "/tmp/\u001b.sock" },
    { label: "" },
    { label: "\ud800" },
    { label: "x".repeat(129) },
    { label: "\u009b" },
    { scopeIds: [] },
    { scopeIds: ["team", "team"] },
    { scopeIds: ["a", "b", "c", "d", "e"] },
    {
      policies: Array.from({ length: 257 }, () => ({
        machineId: "beta",
        scopeId: "team",
        permissions: [],
      })),
    },
    { extra: true },
  ])("rejects invalid explicit configuration %j", (override) => {
    expect(() => decodeConfiguration({ ...config, ...override })).toThrow(Error);
  });

  function sendOptions(
    request: Parameters<typeof sendWithRetries>[0]["request"],
    signal?: AbortSignal,
  ) {
    return {
      sender,
      recipient,
      scopeId: "team",
      message: {
        id: "3".repeat(32),
        kind: "update" as const,
        content: "content",
        format: "text" as const,
      },
      request,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  test("send preflight and cancellation prove non-admission without invoking transport", async () => {
    const request = vi.fn<Parameters<typeof sendWithRetries>[0]["request"]>();
    const options = sendOptions(request);
    await expect(
      sendWithRetries({ ...options, message: { ...options.message, content: "x".repeat(33_000) } }),
    ).resolves.toMatchObject({ tag: "not_admitted", code: "delivery_too_large" });
    await expect(sendWithRetries(sendOptions(request, AbortSignal.abort()))).resolves.toMatchObject(
      { tag: "not_admitted", code: "cancelled" },
    );
    expect(request).not.toHaveBeenCalled();
  });

  test.each([
    [false, "overloaded", "not_admitted", "overloaded"],
    [true, "overloaded", "unknown", "unavailable"],
    [false, "cancelled", "not_admitted", "cancelled"],
    [true, "protocol_error", "unknown", "protocol_error"],
  ] as const)(
    "send terminal failure possible=%s code=%s",
    async (possible, code, tag, expectedCode) => {
      await expect(
        sendWithRetries(
          sendOptions(async () => {
            throw new ConnectionFailure(code, possible);
          }),
        ),
      ).resolves.toMatchObject({ tag, code: expectedCode });
    },
  );

  test("send treats unexpected exceptions and wrong operations as protocol failures", async () => {
    await expect(
      sendWithRetries(
        sendOptions(async () => {
          throw new Error("private diagnostic");
        }),
      ),
    ).resolves.toMatchObject({ tag: "not_admitted", code: "protocol_error" });
    await expect(
      sendWithRetries(
        sendOptions(async (rid) => ({
          v: 1,
          op: "result",
          rid,
          forOp: "close",
          outcome: { tag: "ok", value: {} },
        })),
      ),
    ).resolves.toMatchObject({ tag: "unknown", code: "protocol_error" });
  });

  test("cancelling backoff preserves possible admission and never launches a later attempt", async () => {
    const abort = new AbortController();
    const request = vi.fn<Parameters<typeof sendWithRetries>[0]["request"]>(async () => {
      queueMicrotask(() => {
        abort.abort();
      });
      throw new ConnectionFailure("unavailable", true);
    });
    await expect(sendWithRetries(sendOptions(request, abort.signal))).resolves.toMatchObject({
      tag: "unknown",
      code: "cancelled",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  test("retry exhaustion stays bounded and same invocation can recover admitted receipt", async () => {
    vi.useFakeTimers();
    const request = vi.fn<Parameters<typeof sendWithRetries>[0]["request"]>(
      async (_rid, _deadline) => {
        throw new ConnectionFailure("unavailable", true);
      },
    );
    const result = sendWithRetries(sendOptions(request));
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ tag: "unknown", code: "unavailable" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(new Set(request.mock.calls.map((call) => call[0])).size).toBe(3);
  });

  test("shared wait cancellation, deadlines, and rejection do not alter the shared promise", async () => {
    const shared = Promise.resolve("ready");
    await expect(
      waitFor(shared, performance.now() + 1000, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(
      waitFor(shared, performance.now() - 1, new AbortController().signal),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      waitFor(
        Promise.reject(new Error("opaque")),
        performance.now() + 1000,
        new AbortController().signal,
      ),
    ).rejects.toThrow("opaque");
    const abort = new AbortController();
    const waiting = waitFor(
      new Promise(() => {
        /* Deliberately unresolved shared initialization. */
      }),
      performance.now() + 1000,
      abort.signal,
    );
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    await expect(shared).resolves.toBe("ready");
  });
});
