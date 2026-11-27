import type { Types } from "effect";
import { describe, expect, test } from "vitest";
import type { RecordEvent } from "../ledger.ts";
import { isExcluded, isOutsideService, isPiCore } from "../verdict.ts";
import type { PiCoreCandidate } from "../verdict.ts";

type RecordOptions = {
  readonly piPath?: boolean;
  readonly existed?: boolean;
  readonly batchOrdered?: boolean;
  readonly tool?: string;
  readonly error?: string;
};

function record(session: string, options: RecordOptions = {}): RecordEvent {
  const {
    piPath = true,
    existed = true,
    batchOrdered = false,
    tool = "bash",
    error = "ls: unrecognized option",
  } = options;

  type Signal = Extract<RecordEvent, { type: "signal" }>;

  const event: Types.Mutable<Signal> = {
    type: "signal",
    id: `00000000-0000-4000-8000-${session.padStart(12, "0")}`,
    at: "2026-11-25T00:00:00.000Z",
    session,
    owner: "unattributed",
    fingerprint: `${tool}: ${error}`,
    tool,
    error,
  };

  if (piPath) {
    event.evidence = "pi-path";
    event.pathExisted = existed;
  }

  if (batchOrdered) {
    event.cause = "parallel-batch";
  }

  return event;
}

const passing: PiCoreCandidate = {
  owner: "unattributed",
  live: [record("a"), record("b")],
  excluded: [],
  sessions: 2,
};

describe("isPiCore", () => {
  test("passes when every check passes", () => {
    expect(isPiCore(passing)).toBe(true);
  });

  test.each<[string, Partial<PiCoreCandidate>]>([
    ["an owner from this repository", { owner: "pi-claude" }],
    ["one session", { sessions: 1 }],
    ["no live records", { live: [] }],
    ["a record without a Pi path", { live: [record("a"), record("b", { piPath: false })] }],
    ["a batch-ordered record", { excluded: [record("c", { batchOrdered: true })] }],
    ["a Pi path that did not exist", { live: [record("a"), record("b", { existed: false })] }],
    [
      "an outside-service record",
      {
        excluded: [record("c", { tool: "webfetch", error: "Connection refused by example.com" })],
      },
    ],
  ])("fails with %s", (_name, change) => {
    expect(isPiCore({ ...passing, ...change })).toBe(false);
  });
});

describe("isOutsideService", () => {
  test.each<[string, string, boolean]>([
    ["webfetch", "Request failed (404 Not Found). The site could not find this page.", true],
    ["webfetch", "Request failed (503 Service Unavailable)", true],
    ["webfetch", "Connection refused by learn.microsoft.com", true],
    ["webfetch", "Connection reset by example.com", true],
    ["webfetch", "Connection to example.com timed out", true],
    ["webfetch", "Could not resolve host example.invalid", true],
    ["webfetch", "TLS certificate error for example.com (CERT_HAS_EXPIRED)", true],
    ["webfetch", "Web fetch timed out after 30s; the site may be slow.", true],
    ["webfetch", "getaddrinfo ENOTFOUND example.invalid", true],
    ["websearch", "Free-tier rate limit on exa. Ask the user to add a key.", true],
    [
      "websearch",
      "All search providers failed (exa: rejected (HTTP 503); brave: timed out after 10s)",
      true,
    ],
    [
      "websearch",
      "All search providers failed (exa: rejected (HTTP 429); brave: returned an invalid response)",
      false,
    ],
    ["websearch", "All search providers failed (exa: rejected (HTTP 401))", false],
    [
      "webfetch",
      "Invalid URL. Check it for typos and pass a full http:// or https:// address.",
      false,
    ],
    ["webfetch", "Web fetch failed unexpectedly (a pi-web bug). Ask the user to report it.", false],
    ["webfetch", "Response too large (5MB limit). Try a smaller or more specific page.", false],
    ["bash", "Command timed out after 60 seconds", false],
    ["bash", "curl: (6) Could not resolve host example.invalid", false],
    ["read", "Connection refused by example.com", false],
  ])("treats %s failing with %j as outside: %s", (tool, error, expected) => {
    expect(isOutsideService(record("a", { tool, error, piPath: false }))).toBe(expected);
  });

  test("never treats a report as outside", () => {
    const report: RecordEvent = {
      type: "report",
      id: "00000000-0000-4000-8000-000000000001",
      at: "2026-11-25T00:00:00.000Z",
      session: "a",
      owner: "pi-web",
      fingerprint: "webfetch/tool_error",
      kind: "tool_error",
      component: "webfetch",
      summary: "Fetch failed",
      expected: "",
      actual: "Connection refused by example.com",
      impact: "slowed",
    };

    expect(isOutsideService(report)).toBe(false);
  });
});

describe("isExcluded", () => {
  test.each<[string, RecordEvent, boolean]>([
    ["an ordinary record", record("a"), false],
    ["a batch-ordered record", record("a", { batchOrdered: true }), true],
    [
      "an outside-service record",
      record("a", { tool: "webfetch", error: "Request failed (404 Not Found)" }),
      true,
    ],
  ])("treats %s as excluded: %s", (_name, event, expected) => {
    expect(isExcluded(event)).toBe(expected);
  });
});
