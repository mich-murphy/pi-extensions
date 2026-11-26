import cloudflare from "@cloudflare/oxlint-config";
import type { OxlintConfig } from "oxlint";
import { defineConfig } from "oxlint";

type Rules = NonNullable<OxlintConfig["rules"]>;

const projectPlugins = [
  "eslint",
  "typescript",
  "unicorn",
  "oxc",
  "import",
  "promise",
] satisfies NonNullable<OxlintConfig["plugins"]>;

const immutableValuesOverInPlaceSpreads = {
  "oxc/no-map-spread": "off",
} satisfies Rules;

const allowEffectTaggedErrorFactories = {
  "unicorn/throw-new-error": "off",
} satisfies Rules;

const piSharesTheTuiProcess = {
  "unicorn/no-process-exit": "error",
} satisfies Rules;

const lintStrictTypedBoundariesAndUnusedBindings = {
  "eslint/no-unused-vars": "error",
  "typescript/await-thenable": "error",
  "typescript/return-await": "error",
  "typescript/switch-exhaustiveness-check": "error",
} satisfies Rules;

const keepArrayTypeStyleForTheBaseline = {
  "typescript/array-type": "error",
} satisfies Rules;

const presetRulesPendingFixes = {
  "import/no-namespace": "off",
} satisfies Rules;

const readlineImportMessage = String.raw`readline splits lines on U+2028 and U+2029, which are legal inside JSON strings, so it silently corrupts JSONL. Read the file and split on \n only.`;

const preserveJsonLines = {
  "eslint/no-restricted-imports": [
    "error",
    {
      paths: ["readline", "node:readline", "readline/promises", "node:readline/promises"].map(
        (name) => ({ name, message: readlineImportMessage }),
      ),
    },
  ],
} satisfies Rules;

export default defineConfig({
  extends: [cloudflare],
  env: { ...cloudflare.env, builtin: true, node: true },
  ignorePatterns: [...cloudflare.ignorePatterns, "config/oxlint/anti-slop/**"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "error",
  },
  options: {
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
  plugins: [...new Set([...(cloudflare.plugins ?? []), ...projectPlugins])],
  jsPlugins: [
    "./config/oxlint/no-comments.ts",
    {
      name: "anti-slop",
      specifier: "./config/oxlint/anti-slop/index.ts",
    },
    {
      name: "anti-slop-effect",
      specifier: "./config/oxlint/anti-slop/effect/index.ts",
    },
  ],
  rules: {
    ...immutableValuesOverInPlaceSpreads,
    ...allowEffectTaggedErrorFactories,
    ...piSharesTheTuiProcess,
    ...lintStrictTypedBoundariesAndUnusedBindings,
    ...keepArrayTypeStyleForTheBaseline,
    ...preserveJsonLines,
    ...presetRulesPendingFixes,
    "typescript/only-throw-error": "error",
    "typescript/prefer-promise-reject-errors": "error",
    "typescript/restrict-plus-operands": "error",
    "typescript/no-confusing-void-expression": "error",
    "typescript/no-deprecated": "error",
    "typescript/no-dynamic-delete": "error",
    "typescript/no-invalid-void-type": "error",
    "typescript/no-mixed-enums": "error",
    "typescript/no-namespace": "error",
    "typescript/related-getter-setter-pairs": "error",
    "typescript/prefer-literal-enum-member": "error",
    "typescript/strict-boolean-expressions": "error",
    "typescript/promise-function-async": "error",
    "typescript/method-signature-style": "error",
    "eslint/radix": "error",
    "eslint/default-param-last": "error",
    "eslint/no-shadow": "error",
    "eslint/no-param-reassign": "error",
    "eslint/require-unicode-regexp": "error",
    "unicorn/no-array-callback-reference": "error",
    "unicorn/no-instanceof-array": "error",
    "unicorn/no-new-buffer": "error",
    "unicorn/new-for-builtins": "error",
    "unicorn/prefer-type-error": "error",
    "unicorn/error-message": "error",
    "unicorn/no-object-as-default-parameter": "error",
    "unicorn/no-useless-switch-case": "error",
    "promise/no-nesting": "error",
    "promise/no-return-wrap": "error",
    "promise/param-names": "error",
    "typescript/consistent-type-definitions": ["error", "type"],
    "typescript/consistent-type-assertions": "error",
    "typescript/consistent-indexed-object-style": "error",
    "typescript/consistent-generic-constructors": "error",
    "typescript/no-inferrable-types": "error",
    "typescript/non-nullable-type-assertion-style": "error",
    "typescript/prefer-nullish-coalescing": "error",
    "typescript/prefer-function-type": "error",
    "typescript/prefer-for-of": "error",
    "typescript/prefer-readonly": "error",
    "typescript/dot-notation": "error",
    "typescript/adjacent-overload-signatures": "error",
    "typescript/unified-signatures": "error",
    "typescript/class-literal-property-style": "error",
    "typescript/ban-tslint-comment": "error",
    "typescript/parameter-properties": [
      "error",
      {
        allow: ["readonly", "private readonly"],
      },
    ],
    "eslint/no-underscore-dangle": [
      "error",
      {
        allow: ["_tag", "_exhaustive"],
      },
    ],
    "eslint/func-style": [
      "error",
      "declaration",
      {
        allowArrowFunctions: true,
      },
    ],
    "eslint/prefer-template": "error",
    "eslint/prefer-object-spread": "error",
    "eslint/prefer-rest-params": "error",
    "eslint/prefer-spread": "error",
    "eslint/prefer-exponentiation-operator": "error",
    "eslint/prefer-numeric-literals": "error",
    "eslint/prefer-named-capture-group": "error",
    "eslint/logical-assignment-operators": "error",
    "eslint/operator-assignment": "error",
    "eslint/no-useless-computed-key": "error",
    "eslint/no-useless-return": "error",
    "eslint/no-else-return": "error",
    "eslint/no-lonely-if": "error",
    "eslint/no-negated-condition": "error",
    "eslint/no-nested-ternary": "error",
    "eslint/no-implicit-coercion": "error",
    "eslint/no-multi-assign": "error",
    "eslint/no-return-assign": "error",
    "eslint/no-lone-blocks": "error",
    "eslint/no-new-func": "error",
    "eslint/no-empty-function": "error",
    "eslint/no-sequences": "error",
    "eslint/default-case-last": "error",
    "unicorn/no-array-for-each": "error",
    "unicorn/no-array-reduce": "error",
    "unicorn/no-await-expression-member": "error",
    "unicorn/no-lonely-if": "error",
    "unicorn/no-negated-condition": "error",
    "unicorn/no-nested-ternary": "error",
    "unicorn/no-unreadable-iife": "error",
    "unicorn/no-unreadable-array-destructuring": "error",
    "unicorn/prefer-logical-operator-over-ternary": "error",
    "unicorn/prefer-default-parameters": "error",
    "unicorn/switch-case-braces": "error",
    "typescript/prefer-find": "error",
    "typescript/prefer-includes": "error",
    "typescript/prefer-string-starts-ends-with": "error",
    "typescript/prefer-regexp-exec": "error",
    "typescript/prefer-reduce-type-parameter": "error",
    "unicorn/prefer-array-flat": "error",
    "unicorn/prefer-includes": "error",
    "unicorn/prefer-negative-index": "error",
    "unicorn/prefer-object-from-entries": "error",
    "unicorn/prefer-spread": "error",
    "unicorn/prefer-regexp-test": "error",
    "unicorn/prefer-string-trim-start-end": "error",
    "unicorn/prefer-code-point": "error",
    "unicorn/prefer-date-now": "error",
    "unicorn/prefer-math-min-max": "error",
    "unicorn/prefer-math-trunc": "error",
    "unicorn/prefer-modern-math-apis": "error",
    "unicorn/no-unnecessary-array-flat-depth": "error",
    "unicorn/no-unnecessary-array-splice-count": "error",
    "unicorn/no-length-as-slice-end": "error",
    "unicorn/no-useless-collection-argument": "error",
    "eslint/no-useless-call": "error",
    "import/no-default-export": "error",
    "import/no-duplicates": "error",
    "import/first": "error",
    "import/newline-after-import": "error",
    "import/no-mutable-exports": "error",
    "import/no-cycle": "error",
    "typescript/consistent-type-exports": "error",
    "oxc/no-barrel-file": "error",
    "unicorn/prefer-module": "error",
    "pi-extensions/no-comments": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
  overrides: [
    {
      files: [
        "packages/*/index.ts",
        "config/oxlint/*.ts",
        ".agents/skills/*/scripts/*-provider.ts",
        "packages/*/test/bombadil/*.ts",
        "packages/*/test/fixtures/*.ts",
        "vitest*.config.ts",
        "oxlint.config.ts",
      ],
      rules: {
        "import/no-default-export": "off",
      },
    },
    {
      files: ["packages/*/test/**"],
      plugins: ["vitest"],
      rules: {
        "eslint/no-await-in-loop": "off",
        "vitest/no-restricted-vi-methods": [
          "error",
          {
            mock: "Inject a fake through a real seam instead of mocking a module.",
            doMock: "Inject a fake through a real seam instead of mocking a module.",
          },
        ],
        "vitest/consistent-test-it": [
          "error",
          {
            fn: "test",
            withinDescribe: "test",
          },
        ],
        "vitest/no-standalone-expect": [
          "error",
          {
            additionalTestBlockFunctions: ["it.effect", "it.live"],
          },
        ],
        "vitest/require-top-level-describe": "error",
        "vitest/no-conditional-in-test": "error",
        "vitest/prefer-strict-equal": "error",
        "vitest/prefer-each": "error",
        "vitest/prefer-expect-resolves": "error",
        "vitest/prefer-to-be": "error",
        "vitest/prefer-to-contain": "error",
        "vitest/prefer-to-have-length": "error",
        "vitest/prefer-comparison-matcher": "error",
        "vitest/prefer-equality-matcher": "error",
        "vitest/prefer-hooks-on-top": "error",
        "vitest/prefer-hooks-in-order": "error",
        "vitest/no-duplicate-hooks": "error",
        "vitest/no-alias-methods": "error",
        "vitest/no-test-return-statement": "error",
        "vitest/expect-expect": [
          "error",
          {
            assertFunctionNames: ["expect", "expect*", "assert", "assert*"],
          },
        ],
      },
    },
    {
      files: ["packages/pi-web/collapsed-text.ts"],
      rules: {
        "unicorn/prefer-code-point": "off",
      },
    },
    {
      files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      rules: {
        "eslint/constructor-super": "error",
        "eslint/getter-return": "error",
        "eslint/no-class-assign": "error",
        "eslint/no-const-assign": "error",
        "eslint/no-dupe-class-members": "error",
        "eslint/no-dupe-keys": "error",
        "eslint/no-func-assign": "error",
        "eslint/no-import-assign": "error",
        "eslint/no-new-native-nonconstructor": "error",
        "eslint/no-obj-calls": "error",
        "eslint/no-setter-return": "error",
        "eslint/no-this-before-super": "error",
        "eslint/no-unreachable": "error",
        "eslint/no-unsafe-negation": "error",
        "eslint/no-with": "error",
      },
    },
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      rules: {
        "eslint/no-throw-literal": "error",
      },
    },
    {
      files: [
        "**/*.{test,spec,integration,e2e}.{ts,tsx,mts,cts}",
        "**/__tests__/**/*.{ts,tsx,mts,cts}",
      ],
      rules: {
        "typescript/no-explicit-any": "error",
        "typescript/no-non-null-assertion": "error",
        "typescript/no-unsafe-argument": "error",
        "typescript/no-unsafe-assignment": "error",
        "typescript/no-unsafe-member-access": "error",
        "typescript/only-throw-error": "error",
        "typescript/unbound-method": "error",
      },
    },
    {
      files: ["**/*.{js,jsx,mjs,cjs}"],
      rules: {
        "typescript/no-unsafe-argument": "error",
        "typescript/no-unsafe-assignment": "error",
        "typescript/no-unsafe-call": "error",
        "typescript/no-unsafe-member-access": "error",
        "typescript/no-unsafe-return": "error",
      },
    },
  ],
});
