import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import {
  arrays,
  booleans,
  floats,
  integers,
  just,
  oneOf,
  record,
  sampledFrom,
  text,
  weightedBooleans,
} from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { readTransientSettings, registerRetry } from "../retry";
import type { RetrySettingsInput, TransientSettings } from "../retry";
import { assistantEntry, fakePi, userEntry } from "./fake-pi";

const MINUTE = 60_000;
const settings = propertySettings(200);

type Mode = ExtensionContext["mode"];

const MODES = ["tui", "rpc", "print", "json"] as const satisfies ReadonlyArray<Mode>;

const SCHEDULING_MODES: ReadonlySet<Mode> = new Set(["tui", "rpc"]);

const TRANSIENT_MESSAGES = [
  "Connection error.",
  "terminated",
  "fetch failed",
  "Our servers are currently overloaded. Please try again later.",
  "OpenAI Responses stream ended before a terminal response event",
  "Claude Code stopped with an error but did not say why.",
  "Claude Code failed to start with an unexpected error.",
] as const;

type Step = { jump: number; event: "none" | "tree" | "shutdown"; error: string };

type Plan = { delaysMinutes: Array<number>; maxAttempts: number; windowMinutes: number };

function expectedOutcomes(
  plan: Plan,
  times: ReadonlyArray<number>,
  resets: ReadonlyArray<boolean>,
) {
  const out: Array<{ gaveUp: boolean; attempt: number; resetsAt: number }> = [];
  let attempts = 0;
  let first = 0;

  for (const [index, now] of times.entries()) {
    attempts = resets[index] === true ? 0 : attempts;
    const attempt = attempts + 1;
    first = attempts === 0 ? now : first;
    const delays = plan.delaysMinutes;
    const resetsAt = now + (delays[Math.min(attempt, delays.length) - 1] ?? 0) * MINUTE;
    const gaveUp = attempt > plan.maxAttempts || resetsAt > first + plan.windowMinutes * MINUTE;
    out.push({ gaveUp, attempt, resetsAt });
    attempts = gaveUp ? 0 : attempt;
  }

  return out;
}

function setup(transient: Plan, mode: Mode) {
  const pi = fakePi(mode, { piRetry: { transient } });
  registerRetry(pi.pi, pi.deps);

  return pi;
}

function failOnce(pi: ReturnType<typeof setup>, at: number, error: string): string {
  pi.advanceTo(at);
  const before = pi.notifications.length;
  pi.startRun();

  const result = pi.settle("error", [userEntry("u"), assistantEntry("a", "error", error)]);

  assert.equal(pi.notifications.length, before + 1);
  const message = pi.notifications[before]?.message ?? "";
  assert.equal(result === undefined, message.includes("persists"), "omit only when scheduled");

  return message;
}

function assertNeverSchedules(plan: Plan, mode: Mode, steps: ReadonlyArray<Step>): void {
  const pi = setup(plan, mode);
  let at = 0;

  for (const { jump, error } of steps) {
    at += jump * MINUTE;
    pi.advanceTo(at);
    pi.startRun();
    assert.equal(
      pi.settle("error", [userEntry("u"), assistantEntry("a", "error", error)]),
      undefined,
    );
  }

  assert.equal(pi.timerCount(), 0, `${mode} mode never schedules`);
  assert.deepEqual(pi.notifications, []);
  assert.deepEqual(pi.sent, []);
  assert.deepEqual(pi.stderr, []);
  assert.deepEqual(pi.appended, []);
}

function assertSchedule(plan: Plan, mode: Mode, steps: ReadonlyArray<Step>): void {
  const times: Array<number> = [];
  let at = 0;

  for (const { jump } of steps) {
    at += jump * MINUTE;
    times.push(at);
  }

  const pi = setup(plan, mode);

  const expected = expectedOutcomes(
    plan,
    times,
    steps.map(({ event }) => event !== "none"),
  );

  for (const [index, when] of times.entries()) {
    const event = steps[index]?.event;

    if (event === "tree") {
      pi.navigateTree();
    }

    if (event === "shutdown") {
      pi.shutdown();
    }

    const message = failOnce(pi, when, steps[index]?.error ?? "");
    const want = expected[index];
    assert.ok(want);

    if (want.gaveUp) {
      assert.equal(
        message,
        `Provider error persists after ${want.attempt - 1} automatic retries. Send a message to continue.`,
      );
    } else {
      assert.equal(
        message,
        `Provider error. Pi will retry at t+${want.resetsAt / MINUTE}m (attempt ${want.attempt}); \`/retry off\` cancels.`,
      );
      assert.ok(want.attempt <= plan.maxAttempts);
    }
  }
}

function drawPlan(tc: TestCase): Plan {
  return {
    delaysMinutes: tc.draw(
      arrays(integers({ minValue: 1, maxValue: 30 }), { minSize: 1, maxSize: 6 }),
    ),
    maxAttempts: tc.draw(integers({ minValue: 1, maxValue: 12 })),
    windowMinutes: tc.draw(integers({ minValue: 1, maxValue: 240 })),
  };
}

type SettingsLeaf = number | string | boolean | null | Array<number>;

type FieldName = keyof TransientSettings;

type TestFields = Partial<Record<FieldName, SettingsLeaf>>;

const fieldNames = ["enabled", "delaysMinutes", "maxAttempts", "windowMinutes"] as const;

const leaf = oneOf<SettingsLeaf>(
  integers({ minValue: -5, maxValue: 400 }),
  floats({ allowNan: true, allowInfinity: true }),
  floats({ minValue: 0.1, maxValue: 50 }),
  text({ maxSize: 5 }),
  booleans(),
  just(null),
  arrays(integers({ minValue: -3, maxValue: 40 }), { maxSize: 4 }),
  arrays(floats({ allowNan: true, allowInfinity: true }), { maxSize: 3 }),
);

function checkValid(result: TransientSettings): void {
  assert.ok(typeof result.enabled === "boolean");
  assert.ok(Number.isInteger(result.maxAttempts) && result.maxAttempts > 0);
  assert.ok(Number.isFinite(result.windowMinutes) && result.windowMinutes > 0);
  assert.ok(result.delaysMinutes.length > 0);
  assert.ok(result.delaysMinutes.every((d) => Number.isFinite(d) && d > 0));
  assert.deepEqual(Object.keys(result).toSorted(), [
    "delaysMinutes",
    "enabled",
    "maxAttempts",
    "windowMinutes",
  ]);
}

function assertReader(settingsCase: number, fields: TestFields, junkKeys: Array<string>): void {
  const transient = fields;
  const plain = unpollutedSettings(settingsCase, transient, fields);

  const junk = Object.fromEntries(
    junkKeys.map((key) => [key, { maxAttempts: 99, enabled: false }]),
  );

  const inherited = { maxAttempts: 3, delaysMinutes: [7], windowMinutes: 9, enabled: false };
  const top = wrap(plain, { piRetry: { transient: inherited } });

  const polluted =
    settingsCase === 0
      ? wrap(
          {
            piRetry: wrap(
              { transient: wrap({ ...transient, ...junk }, inherited), ...junk },
              { transient: inherited },
            ),
            ...junk,
          },
          {},
        )
      : top;

  const base = readTransientSettings(plain);
  const result = readTransientSettings(polluted);
  assert.deepEqual(result, base, "junk keys such as __proto__/constructor change nothing");

  if (result !== undefined) {
    checkValid(result);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  }
}

function drawFields(tc: TestCase): TestFields {
  const fields: TestFields = {};

  for (const name of fieldNames) {
    if (tc.draw(booleans())) {
      fields[name] = tc.draw(leaf);
    }
  }

  if (tc.draw(weightedBooleans(0.1), "empty delays")) {
    fields.delaysMinutes = [];
  }

  return fields;
}

function unpollutedSettings(
  settingsCase: number,
  transient: TestFields,
  fields: TestFields,
): RetrySettingsInput & TestFields {
  if (settingsCase === 0) {
    return { piRetry: { transient } };
  }

  return settingsCase === 1 ? { piRetry: fields.enabled } : { ...fields };
}

function wrap<Fields extends RetrySettingsInput | TestFields | { transient: TestFields }>(
  own: Fields,
  proto: RetrySettingsInput | TestFields | { transient: TestFields },
): Fields {
  const copy = { ...own };
  Object.setPrototypeOf(copy, proto);

  return copy;
}

function assertModeOutcome(plan: Plan, mode: Mode, steps: ReadonlyArray<Step>): void {
  const check = SCHEDULING_MODES.has(mode) ? assertSchedule : assertNeverSchedules;
  check(plan, mode, steps);
}

function assertEveryModeGenerated(seen: ReadonlySet<Mode>): void {
  if ((settings.testCases ?? 0) < 50) {
    return;
  }

  assert.deepEqual([...seen].toSorted(), [...MODES].toSorted(), "every mode is generated");
}

describe("transient backoff properties", () => {
  test("schedule matches the independent model in every mode", () => {
    const seenModes = new Set<Mode>();

    new Hegel((tc) => {
      const plan = drawPlan(tc);
      const mode = tc.draw(sampledFrom(MODES));
      seenModes.add(mode);

      const steps = tc.draw(
        arrays(
          record({
            jump: integers({ minValue: 0, maxValue: 20 }),
            event: sampledFrom(["none", "none", "none", "tree", "shutdown"] as const),
            error: sampledFrom(TRANSIENT_MESSAGES),
          }),
          { minSize: 1, maxSize: 15 },
        ),
      );

      assertModeOutcome(plan, mode, steps);
    })
      .settings(settings)
      .runSync();

    assertEveryModeGenerated(seenModes);
  });

  test("reader never throws, only returns valid settings, ignores prototype keys", () => {
    new Hegel((tc) => {
      const fields = drawFields(tc);
      const settingsCase = tc.draw(integers({ minValue: 0, maxValue: 2 }));

      const junk = tc.draw(
        arrays(sampledFrom(["__proto__", "constructor", "prototype", "toString"]), {
          maxSize: 4,
        }),
      );

      assertReader(settingsCase, fields, junk);
    })
      .settings(settings)
      .runSync();
  });
});
