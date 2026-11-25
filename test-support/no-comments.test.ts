import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "../config/oxlint/no-comments.ts";

RuleTester.describe = (text, fn) => {
  void describe(text, fn);
};

RuleTester.it = (text, fn) => {
  void it(text, fn);
};

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const banned = { message: /^Comments are banned/u };
const missingReason = { message: /^Suppressions need a reason/u };
const blanket = { message: /^Name the rules a suppression disables/u };
const suppression = { message: /^Do not suppress pi-extensions\/no-comments/u };

tester.run("no-comments", plugin.rules["no-comments"], {
  valid: [
    "const answer = 42;",
    "const url = 'https://example.com'; const path = '//not-a-comment';",
    "// oxlint-disable-next-line eslint/no-await-in-loop -- sequential by protocol\nawait step();",
    "/* oxlint-disable typescript/no-unsafe-type-assertion -- trusted fixture module */\nconst x = 1;",
    "// eslint-disable-next-line no-console -- CLI entry point owns stdout\nconsole.log(1);",
    "// oxlint-enable no-console\nconst x = 1;",
    "// @ts-expect-error -- malformed on purpose\nconst x: number = 'one';",
    '/// <reference lib="dom" />\nconst x = 1;',
    "// SPDX-License-Identifier: MIT\nconst x = 1;",
    "/*\n * Copyright 2026 Example\n */\nconst x = 1;",
    "// https://github.com/nodejs/node/issues/12345\nconst x = 1;",
    "/* https://www.rfc-editor.org/rfc/rfc9110#section-15.5.20 */\nconst x = 1;",
    "#!/usr/bin/env node\nconst x = 1;",
  ],
  invalid: [
    { code: "// increment the counter\ncount += 1;", errors: [banned] },
    { code: "count += 1; // increment", errors: [banned] },
    {
      code: "/** Adds two numbers. */\nexport function add(a: number, b: number) { return a + b; }",
      errors: [banned],
    },
    {
      code: "/*\n * Workaround: retry twice because the API flakes.\n */\nretry(2);",
      errors: [banned],
    },
    { code: "// const old = legacy();\nconst x = 1;", errors: [banned] },
    {
      code: "// See https://github.com/org/repo/issues/1 for why we retry\nretry(2);",
      errors: [banned],
    },
    { code: "// TODO: remove once fixed\nconst x = 1;", errors: [banned] },
    { code: "// IMPORTANT: do not remove\nconst x = 1;", errors: [banned] },
    { code: "// eslint-disable-next-line no-console\nconsole.log(1);", errors: [missingReason] },
    { code: "/* oxlint-disable -- reason */\n// prose\nconst x = 1;", errors: [blanket, banned] },
    {
      code: "// oxlint-disable-next-line -- reason\n// prose\nconst x = 1;",
      errors: [blanket, banned],
    },
    { code: "// eslint-disable-next-line\nconst x = 1;", errors: [blanket] },
    {
      code: "/* oxlint-disable typescript/no-unsafe-type-assertion */\nconst x = 1;",
      errors: [missingReason],
    },
    { code: "// @ts-expect-error\nconst x: number = 'one';", errors: [missingReason] },
    { code: "// oxlint-disable-next-line no-console --\nconsole.log(1);", errors: [missingReason] },
    {
      code: "// oxlint-disable-next-line pi-extensions/no-comments\n// keep me\nconst x = 1;",
      errors: [suppression, banned],
    },
  ],
});
