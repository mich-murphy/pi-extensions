import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import { arrays, integers, record, sampledFrom } from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { CaffeinateNotice, CaffeinateProcessError, registerCoffee } from "../coffee-lifecycle";
import { fakePi } from "./fake-pi";

const ACTIONS = [
  "start",
  "settleIdle",
  "settleBusy",
  "shutdown",
  "exitCurrent",
  "failCurrent",
  "lateExit",
  "lateFail",
] as const;

type Action = (typeof ACTIONS)[number];

class Child {
  stopped = false;
  ended = false;
  private listener: ((end: CaffeinateNotice) => void) | undefined;
  onNotice(listener: (end: CaffeinateNotice) => void): void {
    this.listener = listener;
  }
  stop(): void {
    this.stopped = true;
  }
  get live(): boolean {
    return !this.stopped && !this.ended;
  }
  exit(): void {
    this.ended = true;
    this.listener?.(CaffeinateNotice.exited({ code: 1, signal: null }));
  }
  fail(): void {
    this.ended = true;
    const cause = new Error("boom");
    this.listener?.(
      CaffeinateNotice.failed({ error: new CaffeinateProcessError("start", "EPERM", cause) }),
    );
  }
}

type Model = { heldChildIndex: number | undefined; budget: number; spawns: number; notes: number };

function setup() {
  const pi = fakePi();
  const children: Array<Child> = [];
  registerCoffee(pi.pi, {
    platform: "darwin",
    processIdCaffeinateExitsWith: 1,
    spawnCaffeinate: () => {
      const child = new Child();
      children.push(child);

      return child;
    },
  });

  return { pi, children };
}

function spawn(model: Model, budget: number): void {
  model.heldChildIndex = model.spawns;
  model.spawns += 1;
  model.budget = budget;
}

function stepModel(model: Model, action: Action): void {
  if (action === "start") {
    startModel(model);
  } else if (action === "settleIdle" || action === "shutdown") {
    model.heldChildIndex = undefined;
  } else if (action === "exitCurrent" || action === "failCurrent") {
    exitModel(model, action);
  }
}

function startModel(model: Model): void {
  if (model.heldChildIndex === undefined) {
    spawn(model, 1);
  }
}

function exitModel(model: Model, action: "exitCurrent" | "failCurrent"): void {
  if (model.heldChildIndex === undefined) {
    return;
  }

  model.heldChildIndex = undefined;
  model.notes += 1;

  if (action === "exitCurrent" && model.budget > 0) {
    spawn(model, model.budget - 1);
  }
}

function targets(env: ReturnType<typeof setup>, model: Model, pick: number) {
  const current =
    model.heldChildIndex === undefined ? undefined : env.children[model.heldChildIndex];

  const released = env.children.filter((child) => child !== current);

  return { current, late: released[pick % Math.max(released.length, 1)] };
}

function apply(
  action: Action,
  pi: ReturnType<typeof setup>["pi"],
  { current, late }: ReturnType<typeof targets>,
): void {
  const run: Record<Action, () => void> = {
    start: () => void pi.emit("agent_start"),
    settleIdle: () => {
      pi.setIdle(true);
      void pi.emit("agent_settled");
    },
    settleBusy: () => {
      pi.setIdle(false);
      void pi.emit("agent_settled");
    },
    shutdown: () => void pi.emit("session_shutdown"),
    exitCurrent: () => current?.exit(),
    failCurrent: () => current?.fail(),
    lateExit: () => late?.exit(),
    lateFail: () => late?.fail(),
  };

  run[action]();
}

function assertLifecycle(actions: ReadonlyArray<{ action: Action; pick: number }>): void {
  const env = setup();
  const model: Model = { heldChildIndex: undefined, budget: 0, spawns: 0, notes: 0 };

  for (const { action, pick } of actions) {
    const before = model.notes;
    const target = targets(env, model, pick);
    stepModel(model, action);
    apply(action, env.pi, target);
    assert.equal(env.children.length, model.spawns, `spawns after ${action}`);
    assert.equal(env.pi.notifications.length, model.notes, `notifications after ${action}`);
    assert.ok(model.notes >= before);
    const live = env.children.filter((child) => child.live);
    assert.ok(live.length <= 1, "at most one live child");

    const heldChild =
      model.heldChildIndex === undefined ? undefined : env.children[model.heldChildIndex];

    assert.deepEqual(
      live,
      heldChild?.live === true ? [heldChild] : [],
      "live child is the held one",
    );

    if (action === "shutdown" || action === "settleIdle") {
      assert.equal(live.length, 0, "no live child after release");
    }
  }
}

describe("coffee lifecycle properties", () => {
  test("random event sequences match the held-child model", () => {
    new Hegel((tc) => {
      const actions = tc.draw(
        arrays(
          record({
            action: sampledFrom([...ACTIONS]),
            pick: integers({ minValue: 0, maxValue: 20 }),
          }),
          { maxSize: 40 },
        ),
      );

      assertLifecycle(actions);
    })
      .settings(propertySettings())
      .runSync();
  });
});
