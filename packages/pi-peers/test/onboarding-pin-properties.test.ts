import type { TestCase } from "@hegeldev/hegel";
import { arrays, binary, booleans, integers, sampledFrom } from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import { validatePin } from "../onboarding/catalog.js";

type Pin = { sourceRevision: string; version: string; manifestSha256?: string; narHash?: string };

type Field = "sourceRevision" | "manifestSha256" | "narHash";

const HEX = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const FOREIGN: Record<Field, ReadonlyArray<string>> = {
  sourceRevision: ["A", "F", "g", " ", "-", "_", "\n", "é"],
  manifestSha256: ["A", "F", "g", " ", "-", "_", "\n", "é"],
  narHash: [" ", "-", "_", ".", "\n", "é"],
};

function hex(tc: TestCase, length: number, name: string): string {
  const digits = tc.draw(
    arrays(integers({ minValue: 0, maxValue: 15 }), { minSize: length, maxSize: length }),
    name,
  );

  return digits.map((digit) => HEX[digit]).join("");
}

function validPin(tc: TestCase): Pin {
  const pin: Pin = {
    sourceRevision: hex(tc, 40, "sourceRevision"),
    version: tc.draw(sampledFrom(["0.1.0", "1.2.3-rc.1", "10.0.7"]), "version"),
  };

  if (tc.draw(booleans(), "has manifestSha256")) {
    pin.manifestSha256 = hex(tc, 64, "manifestSha256");
  }

  if (tc.draw(booleans(), "has narHash")) {
    const bytes = tc.draw(binary({ minSize: 32, maxSize: 32 }), "nar bytes");
    pin.narHash = `sha256-${Buffer.from(bytes).toString("base64")}`;
  }

  return pin;
}

function corrupt(tc: TestCase, value: string, field: Field): string {
  const kinds =
    field === "narHash"
      ? (["replace", "drop", "insert", "noncanonical"] as const)
      : (["replace", "drop", "insert"] as const);

  const kind = tc.draw(sampledFrom(kinds), "edit");

  if (kind === "noncanonical") {
    const at = value.length - 2;
    const index = BASE64.indexOf(value.charAt(at));
    const step = tc.draw(integers({ minValue: 1, maxValue: 3 }), "padding bits");

    return value.slice(0, at) + BASE64.charAt(index + step) + value.slice(at + 1);
  }

  if (kind === "insert") {
    const at = tc.draw(integers({ minValue: 0, maxValue: value.length }), "at");
    const extra = tc.draw(sampledFrom([...HEX, ...FOREIGN[field]]), "extra");

    return value.slice(0, at) + extra + value.slice(at);
  }

  if (kind === "drop") {
    const at = tc.draw(integers({ minValue: 0, maxValue: value.length - 1 }), "at");

    return value.slice(0, at) + value.slice(at + 1);
  }

  const first = field === "narHash" ? "sha256-".length : 0;
  const at = tc.draw(integers({ minValue: first, maxValue: value.length - 1 }), "at");
  const replacement = tc.draw(sampledFrom(FOREIGN[field]), "replacement");

  return value.slice(0, at) + replacement + value.slice(at + 1);
}

function corruptOneDigest(tc: TestCase, pin: Pin): Pin {
  const fields = (["sourceRevision", "manifestSha256", "narHash"] as const).filter(
    (field) => pin[field] !== undefined,
  );

  const field = tc.draw(sampledFrom(fields), "field");

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
