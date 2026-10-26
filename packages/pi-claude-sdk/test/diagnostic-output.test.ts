import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Effect } from "effect";
import { afterEach, assert, beforeEach, describe, expect, test, vi } from "vitest";
import { cacheDiagnosticsTracker, parseCacheDiagnosticsMode } from "../cache-diagnostics";
import type { CacheDiagnosticsMode } from "../cache-diagnostics";
import { writeRedirectedDiagnostic } from "../diagnostic-output";
import { SdkQueryError } from "../sdk/errors";
import { writeSdkFailureDiagnostic } from "../sdk/failure-diagnostics";
import { textBlock } from "./fixtures";

const stderr = process.stderr;
const ttyDescriptor = Object.getOwnPropertyDescriptor(stderr, "isTTY");
const write = vi.fn<typeof stderr.write>().mockReturnValue(true);

function setTerminalStderr(isTTY: boolean | undefined): void {
  Object.defineProperty(stderr, "isTTY", { configurable: true, value: isTTY });
}

function emitCacheDiagnostics(mode: CacheDiagnosticsMode = "enabled"): void {
  const tracker = Effect.runSync(cacheDiagnosticsTracker(mode));
  assert(tracker !== undefined);
  const recordUsage = tracker("claude-sdk/sonnet", {
    promptBlocks: [textBlock("stable")],
    cacheBreakpoints: [0],
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
    tracker("claude-sdk/sonnet", { promptBlocks: [textBlock("stable")], cacheBreakpoints: [0] });
    expect(write).not.toHaveBeenCalled();
  });

  test("parses the diagnostics switches, the file destination implying enabled", () => {
    expect(parseCacheDiagnosticsMode({})).toBe("disabled");
    expect(parseCacheDiagnosticsMode({ PI_CLAUDE_SDK_CACHE_DIAGNOSTICS: "1" })).toBe("enabled");
    expect(
      parseCacheDiagnosticsMode({ PI_CLAUDE_SDK_CACHE_DIAGNOSTICS_FILE: "/tmp/cache.jsonl" }),
    ).toStrictEqual({ file: "/tmp/cache.jsonl" });
  });

  test("appends owner-only JSONL to the diagnostics file even on a terminal, never throwing", () => {
    setTerminalStderr(true);
    const directory = mkdtempSync(join(tmpdir(), "pi-claude-sdk-cache-"));
    const file = join(directory, "cache.jsonl");

    emitCacheDiagnostics({ file });
    emitCacheDiagnostics({ file });

    const records = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
    expect(records).toMatchObject([
      { type: "request" },
      { type: "usage" },
      { type: "request" },
      { type: "usage" },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(write).not.toHaveBeenCalled();
    expect(() => {
      emitCacheDiagnostics({ file: join(directory, "missing", "cache.jsonl") });
    }).not.toThrow();
  });

  test("a throwing write never propagates from redirected diagnostics", () => {
    setTerminalStderr(false);
    write.mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });
    expect(() => {
      writeRedirectedDiagnostic("line\n");
    }).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("a throwing write is not even attempted on a terminal", () => {
    setTerminalStderr(true);
    write.mockImplementationOnce(() => {
      throw new Error("EPIPE");
    });
    expect(() => {
      writeRedirectedDiagnostic("line\n");
    }).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
