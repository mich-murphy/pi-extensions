import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import { arrays, fromRegex, integers, sampledFrom, text } from "@hegeldev/hegel/generators";
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

const SAFE_NAME =
  /^(?:max|public|csrf)|less$|[_.-](?:url|uri|path|file|dir|name|length|size|count|limit|type|endpoint|version|format)$|(?:secret|key)[_.-]?id$/iu;

const PLACEHOLDER_VALUE = /^(?:x{3,}|\.{3,}|undefined|redacted|placeholder|filtered)$/iu;

function drawName(tc: TestCase): string {
  const prefix = tc.draw(fromRegex("[A-Za-z0-9_]{0,4}"), "name prefix");
  const keyword = tc.draw(sampledFrom(KEYWORDS), "keyword");
  const suffix = tc.draw(fromRegex("[A-Za-z0-9_]{0,4}"), "name suffix");
  const name = `${prefix}${keyword}${suffix}`;
  tc.assume(!SAFE_NAME.test(name));

  return name;
}

const ANY_KEYWORDS = [
  ...KEYWORDS,
  "pwd",
  "credentials",
  "access_key",
  "private_key",
  "client_secret",
  "session_id",
  "auth",
];

const ANY_STYLES = {
  env: (name: string, value: string) => `${name}=${value}`,
  "spaced env": (name: string, value: string) => `${name} = ${value}`,
  walrus: (name: string, value: string) => `${name} := ${value}`,
  export: (name: string, value: string) => `export ${name}=${value}`,
  yaml: (name: string, value: string) => `${name}: ${value}`,
  "double quoted": (name: string, value: string) => `${name}="${value}"`,
  "single quoted": (name: string, value: string) => `${name}='${value}'`,
  json: (name: string, value: string) => `{"${name}":"${value}"}`,
  "flag equals": (name: string, value: string) => `--${name}=${value}`,
  "flag space": (name: string, value: string) => `--${name} ${value}`,
  "stringified env": (name: string, value: string) =>
    JSON.stringify({ path: ".env", content: `${name}="${value}"\nPORT=5432` }),
} as const;

type AnyStyle = keyof typeof ANY_STYLES;

const ANY_STYLE_NAMES: ReadonlyArray<AnyStyle> = [
  "env",
  "spaced env",
  "walrus",
  "export",
  "yaml",
  "double quoted",
  "single quoted",
  "json",
  "flag equals",
  "flag space",
  "stringified env",
];

const LINE_END_TAILS = ["", "\n", "\nPORT=5432"];

const ANY_TAILS = ["", "\n", " next", "\tend; more", "\nPORT=5432"];

function tailsFor(style: AnyStyle): ReadonlyArray<string> {
  return style === "yaml" ? LINE_END_TAILS : ANY_TAILS;
}

function fitsStyle(style: Style, tail: string): boolean {
  return style !== "yaml" || tail === "" || tail === "\n";
}

const VALUE_CHARS = "0123456789abcdfghijkmpqrsuvwzABCDFGHIJKMPQRSUVWZ!@#^&+/~_".split("");

function drawAnyName(tc: TestCase): string {
  const prefix = tc.draw(sampledFrom(["", "DB_", "my", "X-", "aws_", "PG"]), "name prefix");
  const keyword = tc.draw(sampledFrom(ANY_KEYWORDS), "keyword");
  const suffix = tc.draw(sampledFrom(["", "_1", "S", "_value", "2"]), "name suffix");

  return `${prefix}${keyword}${suffix}`;
}

const PROSE_WORDS = [
  "the",
  "is",
  "wrong",
  "expected",
  "40",
  "chars",
  "see",
  "docs",
  "invalid",
  "Error",
  "hunter2",
  "missing",
  "file",
  "password",
  "token",
  "secret",
  "api_key",
  "pwd",
  "credentials",
  "auth",
  "session_id",
];

function drawWords(tc: TestCase, minSize: number, label: string): string {
  return tc.draw(arrays(sampledFrom(PROSE_WORDS), { minSize, maxSize: 6 }), label).join(" ");
}

function drawProseLine(tc: TestCase): string {
  const before = drawWords(tc, 1, "words");
  const colon = tc.draw(integers({ minValue: 0, maxValue: 1 }), "colon") === 1;

  return colon ? `${before}: ${drawWords(tc, 2, "words after colon")}` : before;
}

const FRAGMENTS = [
  "password",
  "token",
  "api_key",
  "=",
  ": ",
  ":=",
  "==",
  " ",
  "\n",
  String.raw`\n`,
  '"',
  String.raw`\"`,
  "'",
  ",",
  ";",
  REDACTED,
  "<",
  ">",
  "${",
  "}",
  "$",
  "%",
  "--",
  "-u ",
  "Authorization: ",
  "Bearer ",
  "Basic ",
  "Cookie: ",
  "://",
  "@",
  "sk-",
  "hunter2",
  "abcdefghijklmnop",
  "changeme",
  "max_tokens",
];

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
        tc.assume(fitsStyle(style, tail));
        tc.assume(!PLACEHOLDER_VALUE.test(value));
        const input = `${head}${STYLES[style](name, `${value}${trailing}`)}${tail}`;
        const expected = `${head}${STYLES[style](name, `${REDACTED}${trailing}`)}${tail}`;
        tc.note(`input=${JSON.stringify(input)}`);
        assert.equal(redact(input), expected);
      });
    },
    propertyTimeout(5000),
  );

  test(
    "a value assigned to a secret name in any supported form is removed at any length",
    () => {
      assertHegel(settings, (tc) => {
        const name = drawAnyName(tc);
        const style = tc.draw(sampledFrom(ANY_STYLE_NAMES), "style");
        const value = tc
          .draw(arrays(sampledFrom(VALUE_CHARS), { minSize: 1, maxSize: 30 }), "value")
          .join("");
        const head = tc.draw(sampledFrom(["", "error: ", "env\n", "(", "$ "]), "head");
        const tail = tc.draw(sampledFrom([...tailsFor(style)]), "tail");
        const input = `${head}${ANY_STYLES[style](name, value)}${tail}`;
        const expected = `${head}${ANY_STYLES[style](name, REDACTED)}${tail}`;
        tc.note(`input=${JSON.stringify(input)}`);
        assert.equal(redact(input), expected);
      });
    },
    propertyTimeout(5000),
  );

  test(
    "redaction is idempotent and never throws",
    () => {
      assertHegel(settings, (tc) => {
        const pieces = tc.draw(arrays(sampledFrom(FRAGMENTS), { maxSize: 24 }), "fragments");
        const noise = tc.draw(text({ maxSize: 40 }), "noise");
        const at = tc.draw(integers({ minValue: 0, maxValue: pieces.length }), "noise position");
        const input = [...pieces.slice(0, at), noise, ...pieces.slice(at)].join("");
        tc.note(`input=${JSON.stringify(input)}`);
        const once = redact(input);
        assert.equal(redact(once), once);
      });
    },
    propertyTimeout(5000),
  );

  test(
    "prose without an assignment or a known token is unchanged",
    () => {
      assertHegel(settings, (tc) => {
        const count = tc.draw(integers({ minValue: 1, maxValue: 4 }), "line count");
        const separator = tc.draw(sampledFrom(["\n", ". "]), "separator");
        const input = Array.from({ length: count }, () => drawProseLine(tc)).join(separator);
        tc.note(`input=${JSON.stringify(input)}`);
        assert.equal(redact(input), input);
      });
    },
    propertyTimeout(5000),
  );
});
