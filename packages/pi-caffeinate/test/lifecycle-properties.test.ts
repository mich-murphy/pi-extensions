import assert from "node:assert/strict";
import { Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings } from "../../../test-support/hegel-settings";
import { CaffeinateProcessError, registerNoSleep } from "../no-sleep-lifecycle";
import type { CaffeinateEnd } from "../no-sleep-lifecycle";
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
  private listener: ((end: CaffeinateEnd) => void) | undefined;
  onEnd(listener: (end: CaffeinateEnd) => void): void {
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
    this.listener?.({ _tag: "exited", code: 1, signal: null });
  }
  fail(): void {
    this.ended = true;
    const cause = new Error("boom");
    this.listener?.({ _tag: "failed", error: new CaffeinateProcessError("start", "EPERM", cause) });
  }
}

/** Independent model: which child index is held, and the restart budget of the current start. */
type Model = { held: number | undefined; budget: number; spawns: number; notes: number };

function setup() {
  const pi = fakePi();
  const children: Child[] = [];
  registerNoSleep(pi.pi, {
    platform: "darwin",
    processId: 1,
    spawnCaffeinate: () => {
      const child = new Child();
      children.push(child);
      return child;
    },
  });
  return { pi, children };
}

function spawn(model: Model, budget: number): void {
  model.held = model.spawns;
  model.spawns += 1;
  model.budget = budget;
}

function stepModel(model: Model, action: Action): void {
  if (action === "start") {
    startModel(model);
  } else if (action === "settleIdle" || action === "shutdown") {
    model.held = undefined;
  } else if (action === "exitCurrent" || action === "failCurrent") {
    exitModel(model, action);
  }
}

function startModel(model: Model): void {
  if (model.held === undefined) {
    spawn(model, 1);
  }
}

function exitModel(model: Model, action: "exitCurrent" | "failCurrent"): void {
  if (model.held === undefined) {
    return;
  }
  model.held = undefined;
  model.notes += 1;
  if (action === "exitCurrent" && model.budget > 0) {
    spawn(model, model.budget - 1);
  }
}

function targets(env: ReturnType<typeof setup>, model: Model, pick: number) {
  const current = model.held === undefined ? undefined : env.children[model.held];
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

function assertLifecycle(actions: readonly { action: Action; pick: number }[]): void {
  const env = setup();
  const model: Model = { held: undefined, budget: 0, spawns: 0, notes: 0 };
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
    const heldChild = model.held === undefined ? undefined : env.children[model.held];
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

describe("no-sleep lifecycle properties", () => {
  test("random event sequences match the held-child model", () => {
    new Hegel((tc) => {
      const actions = tc.draw(
        gs.arrays(
          gs.record({
            action: gs.sampledFrom([...ACTIONS]),
            pick: gs.integers({ minValue: 0, maxValue: 20 }),
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
