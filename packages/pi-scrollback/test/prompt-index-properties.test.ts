import assert from "node:assert/strict";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import type { TestCase } from "@hegeldev/hegel";
import { integers, sampledFrom } from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { initTheme } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme";
import { assertHegel, propertySettings } from "../../../test-support/hegel-settings";
import { promptIndexCache } from "../host";

initTheme("dark");

const settings = propertySettings(100);
const WORDS = ["alpha", "beta beta", "", "gamma\ndelta", "same"] as const;

const OPERATIONS = [
  "append-user",
  "append-text",
  "grow-text",
  "edit-text",
  "remove",
  "replace-user",
  "retext-user",
  "width",
  "nest",
] as const;

function draw<T>(tc: TestCase, values: ReadonlyArray<T>, label: string): T | undefined {
  const index = tc.draw(integers({ minValue: -1, maxValue: values.length - 1 }), label);

  return values[index];
}

type Made = { readonly texts: Array<Text>; readonly users: Array<UserMessageComponent> };

function addUser(made: Made, parent: Container, word: string): void {
  const user = new UserMessageComponent(word);
  made.users.push(user);
  parent.addChild(user);
}

function addText(made: Made, parent: Container, body: string): void {
  const text = new Text(body, 0, 0);
  made.texts.push(text);
  parent.addChild(text);
}

type Step = {
  readonly tc: TestCase;
  readonly document: Container;
  readonly made: Made;
  readonly word: string;
  readonly width: number;
};

function setLastText(step: Step, body: string): number {
  const index = step.tc.draw(integers({ minValue: -3, maxValue: -1 }), "text");
  step.made.texts.at(index)?.setText(body);

  return step.width;
}

function removeChild(step: Step): number {
  const child = draw(step.tc, step.document.children, "removed");

  if (child !== undefined) {
    step.document.removeChild(child);
  }

  return step.width;
}

function replaceUser(step: Step): number {
  const maxValue = step.document.children.length;
  const at = step.tc.draw(integers({ minValue: 0, maxValue }), "at");
  const user = new UserMessageComponent(step.word);
  step.made.users.push(user);
  step.document.children.splice(at, 1, user);

  return step.width;
}

function retextUser(step: Step): number {
  const user = draw<Component>(step.tc, step.made.users, "user");

  if (user !== undefined) {
    Reflect.set(user, "text", `${step.word} renamed`);
    addText(step.made, step.document, "after rename");
  }

  return step.width;
}

function nest(step: Step): number {
  const inner = new Container();
  addUser(step.made, inner, step.word);
  addText(step.made, inner, "nested output");
  step.document.addChild(inner);

  return step.width;
}

const HANDLERS: Record<(typeof OPERATIONS)[number], (step: Step) => number> = {
  "append-user": (step) => {
    addUser(step.made, step.document, step.word);

    return step.width;
  },
  "append-text": (step) => {
    addText(step.made, step.document, `${step.word}\nout`);

    return step.width;
  },
  "grow-text": (step) => setLastText(step, `more\n${step.word}\nmore ${step.word}`),
  "edit-text": (step) => setLastText(step, step.word),
  remove: removeChild,
  "replace-user": replaceUser,
  "retext-user": retextUser,
  width: (step) => draw(step.tc, [20, 30, 40], "width") ?? step.width,
  nest,
};

function edit(tc: TestCase, document: Container, width: number, made: Made): number {
  const operation = tc.draw(sampledFrom([...OPERATIONS]), "operation");
  const word = tc.draw(sampledFrom([...WORDS]), "word");

  return HANDLERS[operation]({ tc, document, made, word, width });
}

describe("prompt index properties", () => {
  test("the incremental prompt index equals a full rebuild after every edit", () => {
    assertHegel(settings, (tc) => {
      const document = new Container();
      const incremental = promptIndexCache();
      const steps = tc.draw(integers({ minValue: 1, maxValue: 30 }), "steps");
      let width = 40;
      const made: Made = { texts: [], users: [] };

      for (let step = 0; step < steps; step++) {
        width = edit(tc, document, width, made);
        const lines = document.render(width);
        const got = incremental(document, lines, width);
        assert.deepEqual(got, promptIndexCache()(document, lines, width));
      }
    });
  });
});
