import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import { fromRegex, sampledFrom } from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { REDACTED, redact } from "../redact.ts";

const settings = propertySettings(200);

const KEYWORDS = [
  "api_key",
  "apikey",
  "API-KEY",
  "token",
  "TOKEN",
  "secret",
  "Secret",
  "password",
  "PASSWD",
];

const STYLES = {
  env: (name: string, value: string) => `${name}=${value}`,
  yaml: (name: string, value: string) => `${name}: ${value}`,
  "double quoted": (name: string, value: string) => `${name}="${value}"`,
  "single quoted": (name: string, value: string) => `${name}='${value}'`,
  json: (name: string, value: string) => `{"${name}":"${value}"}`,
} as const;

type Style = keyof typeof STYLES;

const STYLE_NAMES: ReadonlyArray<Style> = ["env", "yaml", "double quoted", "single quoted", "json"];

function drawName(tc: TestCase): string {
  const prefix = tc.draw(fromRegex("[A-Za-z0-9_]{0,4}"), "name prefix");
  const keyword = tc.draw(sampledFrom(KEYWORDS), "keyword");
  const suffix = tc.draw(fromRegex("[A-Za-z0-9_]{0,4}"), "name suffix");

  return `${prefix}${keyword}${suffix}`;
}

describe("redact assigned values", () => {
  test(
    "an assigned value of 8 or more characters is removed whole, wherever , or ; appear in it",
    () => {
      assertHegel(settings, (tc) => {
        const name = drawName(tc);
        const style = tc.draw(sampledFrom(STYLE_NAMES), "style");
        const value = tc.draw(fromRegex("[a-z0-9.,;]{7,23}[a-z0-9.]"), "value");
        const trailing = tc.draw(fromRegex("[,;]{0,2}"), "trailing");
        const head = tc.draw(sampledFrom(["", "error: ", "env\n", "("]), "head");
        const tail = tc.draw(sampledFrom(["", "\n", " next", "\tend; more"]), "tail");
        const input = `${head}${STYLES[style](name, `${value}${trailing}`)}${tail}`;
        const expected = `${head}${STYLES[style](name, `${REDACTED}${trailing}`)}${tail}`;
        tc.note(`input=${JSON.stringify(input)}`);
        assert.equal(redact(input), expected);
      });
    },
    propertyTimeout(5000),
  );
});
