import process from "node:process";
import { Effect } from "effect";
import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";
import { cacheDiagnosticsTracker } from "../cache-diagnostics";
import { SdkQueryError } from "../sdk/errors";
import { writeSdkFailureDiagnostic } from "../sdk/failure-diagnostics";
import { textBlock } from "./fixtures";

const stderr = process.stderr;
const ttyDescriptor = Object.getOwnPropertyDescriptor(stderr, "isTTY");
const write = vi.fn<typeof stderr.write>().mockReturnValue(true);

function setTerminalStderr(isTTY: boolean | undefined): void {
  Object.defineProperty(stderr, "isTTY", { configurable: true, value: isTTY });
}

function emitCacheDiagnostics(): void {
  const tracker = Effect.runSync(cacheDiagnosticsTracker("enabled"));
  assert(tracker !== undefined);
  const recordUsage = tracker("claude-sdk/sonnet", {
    promptBlocks: [textBlock("stable")],
    cacheBreakpoint: 0,
  });
  recordUsage({ input: 100, output: 10, cacheRead: 50, cacheWrite: 0 });
}

describe("terminal-safe diagnostic output", () => {
  beforeEach(() => {
    write.mockClear();
    vi.spyOn(stderr, "write").mockImplementation(write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (ttyDescriptor === undefined) {
      Reflect.deleteProperty(stderr, "isTTY");
    } else {
      Object.defineProperty(stderr, "isTTY", ttyDescriptor);
    }
  });

  test("failure diagnostics never write to terminal stderr, including cancellation", () => {
    setTerminalStderr(true);
    writeSdkFailureDiagnostic(SdkQueryError.cancelled("iterate", "stop"));
    expect(write).not.toHaveBeenCalled();
  });

  test.each([false, undefined])("failure diagnostics with redirected stderr.isTTY=%s", (isTTY) => {
    setTerminalStderr(isTTY);
    writeSdkFailureDiagnostic(SdkQueryError.cancelled("iterate", "stop"));
    expect(write).toHaveBeenCalledExactlyOnceWith(
      '[claude-sdk-error] {"schemaVersion":1,"kind":"cancelled","errorTag":"SdkQueryError","operation":"iterate"}\n',
    );
  });

  test("enabled cache request and usage diagnostics never write to terminal stderr", () => {
    setTerminalStderr(true);
    emitCacheDiagnostics();
    expect(write).not.toHaveBeenCalled();
  });

  test.each([false, undefined])("cache diagnostics with redirected stderr.isTTY=%s", (isTTY) => {
    setTerminalStderr(isTTY);
    emitCacheDiagnostics();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^\[claude-sdk-cache\] \{"type":"request",.*\}\n$/u),
    );
    expect(write).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\[claude-sdk-cache\] \{"type":"usage",.*\}\n$/u),
    );
  });

  test("disabled cache diagnostics stay disabled with redirected stderr", () => {
    setTerminalStderr(false);
    expect(Effect.runSync(cacheDiagnosticsTracker("disabled"))).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  test("checks the destination when writing, not when creating the cache tracker", () => {
    setTerminalStderr(false);
    const tracker = Effect.runSync(cacheDiagnosticsTracker("enabled"));
    assert(tracker !== undefined);
    setTerminalStderr(true);
    tracker("claude-sdk/sonnet", { promptBlocks: [textBlock("stable")], cacheBreakpoint: 0 });
    expect(write).not.toHaveBeenCalled();
  });
});
