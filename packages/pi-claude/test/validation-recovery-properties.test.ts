import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import { integers, sampledFrom } from "@hegeldev/hegel/generators";
import { Option } from "effect";
import type { Schema } from "effect";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import {
  VALIDATION_REASONS,
  decodeValidationInput,
  validationRecoveryReason,
} from "../validation-recovery";

const settings = propertySettings(200);
const MAX_REASON_LENGTH = 400;

function drawMarker(tc: TestCase): string {
  return `ZQ${tc.draw(integers({ minValue: 1e9, maxValue: 9e15 }))}QZ`;
}

function drawInput(tc: TestCase, marker: string): Schema.Json | undefined {
  const reason = tc.draw(sampledFrom([...VALIDATION_REASONS, marker, "", 7]));

  const inputs: Array<Schema.Json | undefined> = [
    marker,
    [marker, { error: marker }],
    { error: marker },
    { error: reason, [marker]: marker, nested: { error: marker } },
    { error: reason, message: marker },
    { error: reason, message: marker },
    { error: [marker], message: marker },
    { error: { toString: marker } },
    null,
    undefined,
    tc.draw(integers()),
  ];

  return inputs[tc.draw(integers({ minValue: 0, maxValue: inputs.length - 1 }))];
}

function assertTotalBoundedValueFree(tc: TestCase): void {
  const marker = drawMarker(tc);

  for (const error of VALIDATION_REASONS) {
    const reason = validationRecoveryReason(
      Option.getOrUndefined(decodeValidationInput({ error, message: marker, [marker]: marker })),
    );

    assert.ok(!reason.includes(marker), reason);
  }

  const reason = validationRecoveryReason(
    Option.getOrUndefined(decodeValidationInput(drawInput(tc, marker))),
  );

  assert.ok(typeof reason === "string");
  assert.ok(reason.length > 0 && reason.length <= MAX_REASON_LENGTH, reason);
  assert.ok(!reason.includes(marker), reason);
}

function assertReasonsDistinct(tc: TestCase): void {
  const marker = drawMarker(tc);
  const noise = tc.draw(sampledFrom([{}, { extra: marker }, { nested: { error: marker } }]));

  const messages = new Map(
    VALIDATION_REASONS.map((error) => [error, validationRecoveryReason({ ...noise, error })]),
  );

  const fallback = validationRecoveryReason(
    Option.getOrUndefined(decodeValidationInput({ ...noise, error: marker })),
  );

  const shared = messages.get("invalid_tool_input");
  assert.equal(shared, fallback);
  assert.equal(shared, validationRecoveryReason(undefined));

  const others = VALIDATION_REASONS.filter((reason) => reason !== "invalid_tool_input").map(
    (reason) => messages.get(reason),
  );

  assert.equal(new Set(others).size, others.length);
  assert.ok(!others.includes(shared));
}

describe("validation recovery reason properties", () => {
  test("is total, bounded and never echoes input values", () => {
    new Hegel((tc) => {
      assertTotalBoundedValueFree(tc);
    })
      .settings(settings)
      .runSync();
  });

  test("each reason has its own message except the default-sharing one", () => {
    new Hegel((tc) => {
      assertReasonsDistinct(tc);
    })
      .settings(settings)
      .runSync();
  });
});
