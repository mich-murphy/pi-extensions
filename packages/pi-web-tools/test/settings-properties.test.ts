import assert from "node:assert/strict";
import * as gs from "@hegeldev/hegel/generators";
import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { propertySettings, assertHegel } from "../../../test-support/hegel-settings";
import {
  BRAVE_API_KEY_ENV,
  clampInteger,
  EXA_API_KEY_ENV,
  FETCH_TIMEOUT_SECONDS,
  InvalidSetting,
  PARALLEL_API_KEY_ENV,
  PROVIDERS_ENV,
  parseSettings,
} from "../settings";

const settings = propertySettings(200);
const ALLOW_ENV = "PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS";
const DENY_ENV = "PI_WEB_TOOLS_FETCH_DENY_DOMAINS";

const LABELS = ["a", "evil", "Com", "x-y", "1", "xn--p1ai", "Mixed-Case"];
const entryLabels = gs.arrays(gs.sampledFrom(LABELS), { minSize: 1, maxSize: 4 });
const entry = gs.tuples(entryLabels, gs.booleans(), gs.sampledFrom(["", " ", "\t "]));

// Each defect turns a well-formed name into one the policy could never match as intended.
const DEFECTS: readonly (readonly [string, (name: string) => string])[] = [
  ["wildcard", (name) => `*.${name}`],
  ["leading dot", (name) => `.${name}`],
  ["scheme", (name) => `https://${name}`],
  ["path", (name) => `${name}/docs`],
  ["port", (name) => `${name}:8080`],
  ["inner space", (name) => `${name} extra`],
  ["empty label", (name) => `${name}..com`],
  ["userinfo", (name) => `user@${name}`],
  ["double trailing dot", (name) => `${name}..`],
  ["lone dot", () => "."],
];

type Defect = (typeof DEFECTS)[number];

function checkKeysIgnored(keys: string[], base: Record<string, string>): void {
  const withKeys = {
    ...base,
    [EXA_API_KEY_ENV]: keys[0],
    [PARALLEL_API_KEY_ENV]: keys[1],
    [BRAVE_API_KEY_ENV]: keys[2],
  };
  assert.deepStrictEqual(parseSettings(withKeys), parseSettings(base));
}

function checkNormalized(entries: [string[], boolean, string][]): void {
  const raw = entries
    .map(([labels, dot, pad]) => `${pad}${labels.join(".")}${dot ? "." : ""}${pad}`)
    .join(",");
  const expected = [...new Set(entries.map(([labels]) => labels.join(".").toLowerCase()))];
  const parsed = parseSettings({ [ALLOW_ENV]: raw, [DENY_ENV]: raw });
  assert.ok(Result.isSuccess(parsed));
  assert.deepStrictEqual(parsed.success.fetch.allowDomains, expected);
  assert.deepStrictEqual(parsed.success.fetch.denyDomains, expected);
}

function failureMessage(envName: string, value: string): string {
  const parsed = parseSettings({ [envName]: value });
  assert.ok(Result.isFailure(parsed), `${value} must be rejected`);
  assert.ok(parsed.failure instanceof InvalidSetting);
  return parsed.failure.message;
}

function checkMalformed(labels: string[], defect: Defect, neighbour: string, envName: string) {
  const bad = defect[1](labels.join("."));
  const message = failureMessage(envName, `${neighbour}, ${bad}`);
  assert.ok(message.includes(envName));
  // The message is identical for any bad entry, so it cannot echo the value.
  assert.equal(message, failureMessage(envName, "*.reference-entry"));
}

// Independent oracle: out-of-range input pins to the bound, in-range input lands on a nearest integer.
function checkNearest(value: number): void {
  const { min, max } = FETCH_TIMEOUT_SECONDS;
  const clamped = clampInteger(value, FETCH_TIMEOUT_SECONDS);
  if (value <= min) {
    assert.equal(clamped, min);
  } else if (value >= max) {
    assert.equal(clamped, max);
  } else {
    assert.ok(Math.abs(clamped - value) <= 0.5, `${value} -> ${clamped}`);
  }
}

function checkClamp(a: number, b: number): void {
  const bounds = FETCH_TIMEOUT_SECONDS;
  checkNearest(a);
  checkNearest(b);
  const clamped = clampInteger(a, bounds);
  assert.ok(Number.isInteger(clamped));
  assert.ok(clamped >= bounds.min && clamped <= bounds.max);
  assert.equal(clampInteger(clamped, bounds), clamped);
  const [low, high] = a <= b ? [a, b] : [b, a];
  assert.ok(clampInteger(low, bounds) <= clampInteger(high, bounds));
}

describe("parseSettings properties", () => {
  test("API keys never influence the parsed settings", () => {
    assertHegel(settings, (tc) => {
      checkKeysIgnored(
        tc.draw(gs.arrays(gs.text({ maxSize: 24 }), { minSize: 3, maxSize: 3 }), "keys"),
        tc.draw(gs.sampledFrom([{}, { [PROVIDERS_ENV]: "parallel, exa" }]), "base"),
      );
    });
  });

  test("domain entries normalize to lowercase names without a trailing dot", () => {
    assertHegel(settings, (tc) => {
      checkNormalized(tc.draw(gs.arrays(entry, { maxSize: 5 }), "entries"));
    });
  });

  test("malformed domain entries fail loudly and name only the variable", () => {
    assertHegel(settings, (tc) => {
      checkMalformed(
        tc.draw(entryLabels, "labels"),
        tc.draw(gs.sampledFrom(DEFECTS), "defect"),
        tc.draw(entryLabels, "neighbour").join("."),
        tc.draw(gs.sampledFrom([ALLOW_ENV, DENY_ENV]), "env"),
      );
    });
  });
});

describe("clampInteger properties", () => {
  const bounds = FETCH_TIMEOUT_SECONDS;
  test("stays in bounds, is idempotent and monotonic", () => {
    assertHegel(settings, (tc) => {
      checkClamp(
        // Biased around the 1..120 bounds, where rounding and pinning actually matter.
        tc.draw(gs.floats({ minValue: -5, maxValue: 130 }), "a"),
        tc.draw(gs.floats({ minValue: -1e6, maxValue: 1e6 }), "b"),
      );
    });
  });

  test.each([Number.NaN, Infinity, -Infinity])("non-finite input %s gets the default", (value) => {
    expect(clampInteger(value, bounds)).toBe(bounds.default);
  });
});
