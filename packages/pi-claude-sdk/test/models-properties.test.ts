import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { minimumCacheableTokensFor, undatedModelId } from "../models";

const settings = propertySettings(200);

// Independent oracle: documented minimums per known identifier (ids, aliases, canonical ids).
const KNOWN: readonly (readonly [string, number])[] = [
  ["claude-5.5-sonnet", 512],
  ["claude-5.5-opus", 512],
  ["claude-5.2-fable", 512],
  ["claude-5.5-haiku", 512],
  ["claude-4.5-haiku", 4096],
  ["sonnet", 512],
  ["opus", 512],
  ["haiku", 512],
  ["claude-haiku-4-5", 4096],
  ["claude-sonnet-5-5", 512],
  ["claude-opus-5-5", 512],
  ["claude-fable-5-2", 512],
  ["claude-haiku-5-5", 512],
  ["claude-fable-5", 512],
  ["claude-fable-5-1", 512],
  ["claude-mythos-5", 512],
  ["claude-mythos-5-1", 512],
  ["claude-mythos-5-2", 512],
  ["claude-opus-5", 512],
  ["claude-mythos-preview", 2048],
  ["claude-opus-4-7", 2048],
  ["claude-opus-4-5", 4096],
  ["claude-opus-4-6", 4096],
  ["claude-opus-4-8", 1024],
  ["claude-sonnet-5", 1024],
  ["claude-sonnet-4-6", 1024],
  ["claude-sonnet-4-5", 1024],
  ["claude-opus-4-1", 1024],
  ["claude-opus-4", 1024],
  ["claude-sonnet-4", 1024],
  ["claude-3-5-haiku", 2048],
];
const PROTOTYPE_NAMES = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
  "toLocaleString",
];
const FOREIGN_PREFIXES = [
  "anthropic/",
  "claude-sdk",
  "claude-sdk//",
  "openai/",
  "Claude-SDK/",
  " claude-sdk/",
];

function drawKnown(tc: TestCase): readonly [string, number] {
  return tc.draw(gs.sampledFrom(KNOWN));
}

function drawDate(tc: TestCase): string {
  return String(tc.draw(gs.integers({ minValue: 0, maxValue: 99_999_999 }))).padStart(8, "0");
}

function assertVariantsAgree(tc: TestCase): void {
  const [id, minimum] = drawKnown(tc);
  const date = drawDate(tc);
  for (const variant of [id, `claude-sdk/${id}`, `${id}-${date}`, `claude-sdk/${id}-${date}`]) {
    assert.equal(minimumCacheableTokensFor(variant), minimum, variant);
  }
}

function assertUndatedStrips(tc: TestCase): void {
  const [id] = drawKnown(tc);
  const date = drawDate(tc);
  assert.equal(undatedModelId(id), id);
  assert.equal(undatedModelId(`${id}-${date}`), id);
  assert.equal(undatedModelId(undatedModelId(`${id}-${date}`)), id);
  assert.equal(undatedModelId(`${id}-${date}-x`), `${id}-${date}-x`);
  assert.equal(minimumCacheableTokensFor(`claude-opus-4-${date}-1`), undefined);
}

function assertUnknownIsUndefined(tc: TestCase): void {
  const name = tc.draw(gs.sampledFrom(PROTOTYPE_NAMES));
  const [id] = drawKnown(tc);
  const prefix = tc.draw(gs.sampledFrom(FOREIGN_PREFIXES));
  const junk = `zz-${tc.draw(gs.text({ maxSize: 20 }))}`;
  const date = drawDate(tc);
  for (const variant of [name, `claude-sdk/${name}`, `${name}-${date}`, `${prefix}${id}`, junk]) {
    assert.equal(minimumCacheableTokensFor(variant), undefined, variant);
  }
}

describe("model metadata properties", () => {
  test("claude-sdk prefix and date suffix never change a known id's minimum", () => {
    new Hegel((tc) => {
      assertVariantsAgree(tc);
    })
      .settings(settings)
      .runSync();
  });

  test("undatedModelId strips one date suffix and is stable on undated ids", () => {
    new Hegel((tc) => {
      assertUndatedStrips(tc);
    })
      .settings(settings)
      .runSync();
  });

  test("non-keys and foreign prefixes have no minimum", () => {
    new Hegel((tc) => {
      assertUnknownIsUndefined(tc);
    })
      .settings(settings)
      .runSync();
  });
});
