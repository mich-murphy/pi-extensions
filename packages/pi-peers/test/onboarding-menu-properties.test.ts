import type { TestCase } from "@hegeldev/hegel";
import { booleans, integers, sampledFrom } from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import { actionForm } from "../onboarding/menu/forms.js";
import type { Progress } from "../onboarding/menu/forms.js";
import { MenuModel } from "../onboarding/menu/model.js";
import type { Screen } from "../onboarding/menu/model.js";
import { remoteDraft } from "../onboarding/menu/remote-form.js";
import { peersMenu } from "../onboarding/menu/root.js";
import type { RootState } from "../onboarding/menu/root.js";
import { setupForm } from "../onboarding/menu/setup-form.js";
import type { SetupFormOptions } from "../onboarding/menu/setup-form.js";
import { defaultChoices } from "../onboarding/plan.js";
import { NO_CHANGES } from "../onboarding/route.js";

const ids = ["setup", "mode", "machineId", "scopeId", "label", "permissions", "review", "apply"];
const texts = ["", "ok-host", "BAD VALUE", "team", "x".repeat(200)];

type Run = { blocked: boolean; events: Array<string>; depths: Array<number> };

function unconsented(events: ReadonlyArray<string>): Array<number> {
  return events.flatMap((event, index) =>
    event === "effect" && events[index - 1] !== "consent:Apply" ? [index] : [],
  );
}

function press(model: MenuModel, tc: TestCase): void {
  const key = tc.draw(integers({ minValue: 0, maxValue: 3 }));

  if (key === 0) {
    model.back();
  } else if (key === 1) {
    model.activate(tc.draw(sampledFrom(ids)));
  } else if (key === 2) {
    model.submit(tc.draw(sampledFrom(texts))).catch(() => undefined);
  } else {
    model.toggle(tc.draw(sampledFrom(["discover", "push"])));
  }
}

function run(tc: TestCase): Run {
  const blocked = tc.draw(booleans());
  const events: Array<string> = [];
  const depths: Array<number> = [];

  const options: SetupFormOptions = {
    draft: {
      mode: "local",
      choices: defaultChoices("Prop Host"),
      socket: "/private/owned/s",
      socketRequired: false,
      shared: false,
      remote: remoteDraft(),
    },
    details: () => "details",
    apply: () => {
      events.push("effect");
    },
  };

  if (blocked) {
    options.blocked = "no source";
  }

  const form = setupForm(options);

  const root: Screen = {
    kind: "list",
    title: "Peers",
    rows: () => [
      { id: "setup", label: "Setup", value: "", activation: { kind: "open", screen: () => form } },
    ],
  };

  const model = new MenuModel(root, { consented: (action) => events.push(`consent:${action}`) });
  const steps = tc.draw(integers({ minValue: 1, maxValue: 40 }));

  for (let index = 0; index < steps && !model.closed; index += 1) {
    press(model, tc);
    depths.push(model.depth);
  }

  return { blocked, events, depths };
}

const routeIds = [
  "status",
  "setup",
  "doctor",
  "reconnect",
  "reset",
  "disable",
  "keep",
  "repair",
  "issuer",
  "export",
  "apply",
  "review",
];

function existingScreen(blockedRepair: boolean, events: Array<string>) {
  return (progress: Progress) => {
    const effect = (name: string) => () => {
      progress(name, [], async () => {
        events.push(`effect:${name}`);

        return { ok: true, headline: `✓ ${name}`, facts: [] };
      });
    };

    return {
      kind: "list" as const,
      title: "Setup",
      rows: () => [
        {
          id: "keep",
          label: "Keep and reconnect",
          value: "",
          activation: { kind: "consent" as const, action: "Reconnect", run: effect("keep") },
        },
        {
          id: "repair",
          label: "Repair",
          value: "",
          activation: {
            kind: "open" as const,
            screen: () =>
              actionForm({
                title: "Repair",
                details: () => ["details"],
                consent: () => ({
                  label: "Repair installation",
                  action: "Repair",
                  gate: blockedRepair
                    ? { kind: "blocked", reason: "no source" }
                    : { kind: "ready", value: undefined },
                  description: "Repair",
                  run: effect("repair"),
                }),
              }),
          },
        },
        {
          id: "issuer",
          label: "Issuer actions",
          value: "",
          activation: {
            kind: "open" as const,
            screen: () => ({
              kind: "list" as const,
              title: "Issuer",
              rows: () => [
                {
                  id: "export",
                  label: "Export",
                  value: "",
                  activation: {
                    kind: "open" as const,
                    screen: () =>
                      actionForm({
                        title: "Export",
                        details: () => ["details"],
                        consent: () => ({
                          label: "Export bundle",
                          action: "Apply",
                          gate: { kind: "ready", value: undefined },
                          description: "Export",
                          run: effect("export"),
                        }),
                      }),
                  },
                },
              ],
            }),
          },
        },
      ],
    };
  };
}

function runExisting(tc: TestCase) {
  const blockedRepair = tc.draw(booleans());
  const events: Array<string> = [];
  const depths: Array<number> = [];

  const state = (): RootState => ({
    status: { value: "Connected", lines: ["Connected"] },
    doctor: ["✓ ok"],
    setup: {
      value: "Manage",
      description: "View or change the saved setup.",
      configured: true,
      cancelled: () => NO_CHANGES,
      screen: existingScreen(blockedRepair, events),
    },
    resettable: true,
    busy: false,
  });

  const root = (name: string) => async () => {
    events.push(`effect:${name}`);

    return { ok: true, headline: `✓ ${name}`, facts: [] };
  };

  const model = peersMenu(
    {
      state,
      reset: root("reset"),
      reconnect: root("reconnect"),
      started: () => undefined,
      finished: () => undefined,
    },
    { consented: (action) => events.push(`consent:${action}`) },
  );

  const steps = tc.draw(integers({ minValue: 1, maxValue: 40 }));

  for (let index = 0; index < steps && !model.closed; index += 1) {
    const before = model.depth;
    const back = tc.draw(booleans());

    if (back) {
      model.back();
      depths.push(model.closed || model.depth === 0 ? 0 : before - model.depth - 1);
    } else {
      model.activate(tc.draw(sampledFrom(routeIds)));
    }
  }

  return { blockedRepair, events, depths };
}

function unconsentedAny(events: ReadonlyArray<string>): Array<number> {
  return events.flatMap((event, index) =>
    event.startsWith("effect:") && !(events[index - 1] ?? "").startsWith("consent:") ? [index] : [],
  );
}

describe("peers menu model properties", () => {
  test("existing-state roots: every effect follows its consent, back pops one level, a blocked repair never runs", () => {
    assertHegel(propertySettings(200), (tc) => {
      const { blockedRepair, events, depths } = runExisting(tc);
      expect(unconsentedAny(events)).toStrictEqual([]);
      expect(depths.filter((delta) => delta !== 0)).toStrictEqual([]);
      expect(
        events.filter((event) => event === "effect:repair").length * Number(blockedRepair),
      ).toBe(0);
    });
  });
  test("random keys never run an effect without consent, and depth never goes negative", () => {
    assertHegel(propertySettings(200), (tc) => {
      const { blocked, events, depths } = run(tc);
      expect(depths.filter((depth) => depth < 0)).toStrictEqual([]);
      expect(unconsented(events)).toStrictEqual([]);
      expect(events.length * Number(blocked)).toBe(0);
    });
  });
});
