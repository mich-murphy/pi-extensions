import { describe, expect, test } from "vitest";
import {
  InvalidDeferredCallError,
  InvalidDeferredCallLimitError,
  SdkProtocolError,
  SdkQueryError,
  SdkResultError,
} from "../sdk/errors";
import {
  diagnoseSdkRunError,
  formatSdkRunError,
  writeSdkFailureDiagnostic,
} from "../sdk/failure-diagnostics";

describe("Claude SDK failure diagnostics", () => {
  test.each([
    [new SdkProtocolError("result", "unsupported stop_reason future"), "protocol"],
    [
      new InvalidDeferredCallLimitError(
        4,
        new InvalidDeferredCallError("missing", "unknown Pi tool"),
      ),
      "tool-contract",
    ],
    [new SdkResultError(undefined, "You're out of extra usage"), "usage-limit"],
    [new SdkQueryError("iterate", new Error("getaddrinfo ENOTFOUND api.example")), "network"],
    [new SdkQueryError("iterate", new Error("Request timed out")), "timeout"],
    [new SdkResultError(undefined, "Your computer went to sleep mid-response"), "host-sleep"],
    [new SdkQueryError("iterate", new Error("This operation was aborted")), "cancelled"],
    [new SdkResultError("model_error", "upstream model error"), "provider"],
  ] as const)("classifies %s as %s", (error, expectedKind) => {
    expect(diagnoseSdkRunError(error).kind).toBe(expectedKind);
  });

  test("emits structured routing fields without the provider message or cause", () => {
    const error = new SdkQueryError(
      "iterate",
      new Error("getaddrinfo ENOTFOUND secret.internal.example"),
    );
    const lines: string[] = [];

    writeSdkFailureDiagnostic(error, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"kind":"network","errorTag":"SdkQueryError","operation":"iterate"');
    expect(lines[0]).not.toContain("secret.internal.example");
    expect(lines[0]).not.toContain("ENOTFOUND");
  });

  test("adds the stable category to the user-facing error", () => {
    expect(formatSdkRunError(new SdkResultError(undefined, "You're out of extra usage"))).toBe(
      "Claude SDK [usage-limit]: You're out of extra usage",
    );
  });
});
