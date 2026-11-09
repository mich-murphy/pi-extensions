import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { VALIDATION_REASONS, validationRecoveryReason } from "../validation-recovery";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };
const MAX_REASON_LENGTH = 400;

function drawMarker(tc: TestCase): string {
  return `ZQ${tc.draw(gs.integers({ minValue: 1e9, maxValue: 9e15 }))}QZ`;
}

function drawInput(tc: TestCase, marker: string): unknown {
  const reason = tc.draw(gs.sampledFrom([...VALIDATION_REASONS, marker, "", 7]));
  const shapes: unknown[] = [
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
    tc.draw(gs.integers()),
  ];
  return shapes[tc.draw(gs.integers({ minValue: 0, maxValue: shapes.length - 1 }))];
}

function assertTotalBoundedValueFree(tc: TestCase): void {
  const marker = drawMarker(tc);
  for (const error of VALIDATION_REASONS) {
    const reason = validationRecoveryReason({ error, message: marker, [marker]: marker });
    assert.ok(!reason.includes(marker), reason);
  }
  const reason = validationRecoveryReason(drawInput(tc, marker));
  assert.equal(typeof reason, "string");
  assert.ok(reason.length > 0 && reason.length <= MAX_REASON_LENGTH, reason);
  assert.ok(!reason.includes(marker), reason);
}

function assertReasonsDistinct(tc: TestCase): void {
  const marker = drawMarker(tc);
  const noise = tc.draw(gs.sampledFrom([{}, { extra: marker }, { nested: { error: marker } }]));
  const messages = new Map(
    VALIDATION_REASONS.map((error) => [error, validationRecoveryReason({ ...noise, error })]),
  );
  const fallback = validationRecoveryReason({ ...noise, error: marker });
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
      .databaseKey("pi-claude-sdk/validation-recovery-total")
      .settings(settings)
      .runSync();
  });

  test("each reason has its own message except the default-sharing one", () => {
    new Hegel((tc) => {
      assertReasonsDistinct(tc);
    })
      .databaseKey("pi-claude-sdk/validation-recovery-distinct")
      .settings(settings)
      .runSync();
  });
});
