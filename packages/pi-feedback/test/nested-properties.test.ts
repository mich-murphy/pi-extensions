import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import { booleans, integers } from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import { createNestedTracker } from "../nested.ts";

type Step = { readonly id: string; readonly kind: "start" | "end"; readonly failed: boolean };

const PARENT = "p";
const settings = propertySettings(200);

function drawSteps(tc: TestCase): Array<Step> {
  const count = tc.draw(integers({ minValue: 1, maxValue: 6 }), "count");
  const waiting = Array.from({ length: count }, (_, n) => `${PARENT}/${n + 1}`);
  const running: Array<string> = [];
  const steps: Array<Step> = [];

  while (waiting.length + running.length > 0) {
    const pick = tc.draw(
      integers({ minValue: 0, maxValue: waiting.length + running.length - 1 }),
      "pick",
    );

    const next = waiting.shift();

    if (pick < waiting.length + 1 && next !== undefined) {
      running.push(next);
      steps.push({ id: next, kind: "start", failed: false });
    } else {
      waiting.unshift(...(next === undefined ? [] : [next]));
      const [ending] = running.splice(pick - waiting.length, 1);
      assert.ok(ending !== undefined);
      steps.push({ id: ending, kind: "end", failed: tc.draw(booleans(), "failed") });
    }
  }

  return steps;
}

function childError(id: string): string {
  return `ENOENT: no such file '${id}.txt'`;
}

function scriptError(rethrown: string | undefined): string {
  return `Script failed\nScript error:\n${rethrown ?? "boom"}`;
}

function rethrownError(steps: ReadonlyArray<Step>, rethrow: boolean): string | undefined {
  const failed = steps.find((step) => step.failed);

  return rethrow && failed !== undefined ? childError(failed.id) : undefined;
}

function replay(steps: ReadonlyArray<Step>, tracker: ReturnType<typeof createNestedTracker>) {
  const batches = new Map<string, ReadonlyArray<string>>();

  for (const step of steps) {
    if (step.kind === "start") {
      tracker.start({ toolCallId: step.id, toolName: "read", args: {}, parentToolCallId: PARENT });
    } else {
      const ended = tracker.end(
        { toolCallId: step.id, toolName: "read", isError: step.failed, parentToolCallId: PARENT },
        childError(step.id),
      );

      batches.set(
        step.id,
        (ended.batch ?? []).map((call) => call.id),
      );
    }
  }

  return batches;
}

function expectedBatch(steps: ReadonlyArray<Step>, id: string): Array<string> {
  const at = (kind: Step["kind"], target: string): number =>
    steps.findIndex((step) => step.kind === kind && step.id === target);

  return steps.flatMap((step) =>
    step.kind === "start" &&
    at("start", step.id) < at("end", id) &&
    at("end", step.id) > at("start", id)
      ? [step.id]
      : [],
  );
}

describe("nested call tracking", () => {
  test("a failed call's batch is exactly the siblings whose runs overlapped it, and a script's error is hidden only when it repeats one", () => {
    assertHegel(settings, (tc) => {
      const steps = drawSteps(tc);
      const tracker = createNestedTracker();

      for (const [id, batch] of replay(steps, tracker)) {
        assert.deepEqual(batch, expectedBatch(steps, id));
      }

      const rethrown = rethrownError(steps, tc.draw(booleans(), "rethrow"));
      const parent = { toolCallId: PARENT, toolName: "codemode", isError: true };
      assert.equal(tracker.end(parent, scriptError(rethrown)).suppressed, rethrown !== undefined);
      assert.equal(tracker.end(parent, scriptError(rethrown)).suppressed, false);
    });
  });
});
