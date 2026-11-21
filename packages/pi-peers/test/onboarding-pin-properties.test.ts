import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import { validatePin } from "../onboarding/catalog.js";

// The oracle is built by construction, not by copying the validator's patterns: a pin drawn from
// lowercase hex digits and canonical base64 is valid, and any one edit below makes it invalid.

type Pin = { sourceRevision: string; version: string; manifestSha256?: string; narHash?: string };
type Field = "sourceRevision" | "manifestSha256" | "narHash";

const HEX = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// Characters outside each field's alphabet, so a replacement always breaks the field.
const FOREIGN: Record<Field, readonly string[]> = {
  sourceRevision: ["A", "F", "g", " ", "-", "_", "\n", "é"],
  manifestSha256: ["A", "F", "g", " ", "-", "_", "\n", "é"],
  narHash: [" ", "-", "_", ".", "\n", "é"],
};

function hex(tc: TestCase, length: number, name: string): string {
  const digits = tc.draw(
    gs.arrays(gs.integers({ minValue: 0, maxValue: 15 }), { minSize: length, maxSize: length }),
    name,
  );
  return digits.map((digit) => HEX[digit]).join("");
}

function validPin(tc: TestCase): Pin {
  const pin: Pin = {
    sourceRevision: hex(tc, 40, "sourceRevision"),
    version: tc.draw(gs.sampledFrom(["0.1.0", "1.2.3-rc.1", "10.0.7"]), "version"),
  };
  if (tc.draw(gs.booleans(), "has manifestSha256")) {
    pin.manifestSha256 = hex(tc, 64, "manifestSha256");
  }
  if (tc.draw(gs.booleans(), "has narHash")) {
    const bytes = tc.draw(gs.binary({ minSize: 32, maxSize: 32 }), "nar bytes");
    pin.narHash = `sha256-${Buffer.from(bytes).toString("base64")}`;
  }
  return pin;
}

/**
 * One edit that makes the field invalid: a foreign character, a missing one, an extra one, or (for
 * the NAR hash) a last digest character whose unused padding bits are set, which no 32-byte value
 * encodes to.
 */
function corrupt(tc: TestCase, value: string, field: Field): string {
  const kinds =
    field === "narHash"
      ? (["replace", "drop", "insert", "noncanonical"] as const)
      : (["replace", "drop", "insert"] as const);
  const kind = tc.draw(gs.sampledFrom(kinds), "edit");
  if (kind === "noncanonical") {
    // "sha256-" + 43 characters + "=": the 43rd carries 4 data bits and 2 zero bits, so a canonical
    // one has an alphabet index divisible by 4. The next 1–3 indices set those zero bits.
    const at = value.length - 2;
    const index = BASE64.indexOf(value.charAt(at));
    const step = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }), "padding bits");
    return value.slice(0, at) + BASE64.charAt(index + step) + value.slice(at + 1);
  }
  if (kind === "insert") {
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: value.length }), "at");
    const extra = tc.draw(gs.sampledFrom([...HEX, ...FOREIGN[field]]), "extra");
    return value.slice(0, at) + extra + value.slice(at);
  }
  if (kind === "drop") {
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: value.length - 1 }), "at");
    return value.slice(0, at) + value.slice(at + 1);
  }
  // The narHash prefix "sha256-" ends in a foreign character, so replace only after it.
  const first = field === "narHash" ? "sha256-".length : 0;
  const at = tc.draw(gs.integers({ minValue: first, maxValue: value.length - 1 }), "at");
  const replacement = tc.draw(gs.sampledFrom(FOREIGN[field]), "replacement");
  return value.slice(0, at) + replacement + value.slice(at + 1);
}

/** The pin with one of its present digests corrupted. */
function corruptOneDigest(tc: TestCase, pin: Pin): Pin {
  const fields = (["sourceRevision", "manifestSha256", "narHash"] as const).filter(
    (field) => pin[field] !== undefined,
  );
  const field = tc.draw(gs.sampledFrom(fields), "field");
  return { ...pin, [field]: corrupt(tc, pin[field] ?? "", field) };
}

describe("trusted gateway pin properties", () => {
  test("a pin of lowercase hex digests and a canonical NAR hash is accepted", () => {
    assertHegel(propertySettings(200), (tc) => {
      const pin = validPin(tc);
      expect(() => {
        validatePin(pin);
      }).not.toThrow();
    });
  });

  test("one wrong, missing or extra character in any digest, or a non-canonical NAR hash, is rejected", () => {
    assertHegel(propertySettings(200), (tc) => {
      const corrupted = corruptOneDigest(tc, validPin(tc));
      expect(() => {
        validatePin(corrupted);
      }).toThrow("Invalid trusted gateway pin");
    });
  });
});
