import { visibleText } from "../../adapter/config.js";
import { inputChoice, selectChoice } from "../dialog.js";
import type { DialogContext } from "../dialog.js";
import type { MenuModel, Row, Screen } from "./model.js";

const BACK = "Back";

export async function driveRpc(model: MenuModel, ctx: DialogContext): Promise<void> {
  while (!model.closed) {
    // eslint-disable-next-line eslint/no-await-in-loop -- RPC dialogs are sequential; each answer decides the next screen.
    await step(model, ctx);
  }
}

function heading(model: MenuModel, ...extra: (string | undefined)[]): string {
  return [
    model.title(),
    ...extra.flatMap((line) => (line === undefined || line === "" ? [] : [visibleText(line)])),
  ].join("\n");
}

function rowText(row: Row): string {
  return row.value === "" ? row.label : `${row.label}: ${row.value}`;
}

async function list(
  model: MenuModel,
  ctx: DialogContext,
  screen: Extract<Screen, { kind: "list" }>,
): Promise<void> {
  const rows = screen.rows();
  const options = rows.map((row) => rowText(row));

  const answer = await selectChoice(ctx, heading(model, screen.note, model.error), [
    ...options,
    ...(model.depth === 0 ? [] : [BACK]),
  ]);

  const row = rows[options.indexOf(answer ?? BACK)];

  if (row === undefined) {
    model.back();
  } else {
    model.activateRow(row);
  }
}

async function toggles(
  model: MenuModel,
  ctx: DialogContext,
  screen: Extract<Screen, { kind: "toggle" }>,
): Promise<void> {
  const items = screen.items();
  const options = items.map((item) => `${item.label}: ${item.on ? "On" : "Off"}`);
  const answer = await selectChoice(ctx, heading(model), [...options, BACK]);
  const item = items[options.indexOf(answer ?? BACK)];

  if (item === undefined) {
    model.back();
  } else {
    model.toggle(item.id);
  }
}

async function text(
  model: MenuModel,
  ctx: DialogContext,
  screen: Extract<Screen, { kind: "text" }>,
): Promise<void> {
  const answer = await inputChoice(
    ctx,
    heading(model, screen.description, model.error),
    screen.placeholder,
  );

  if (answer === undefined) {
    model.back();
  } else {
    await model.submit(answer);
  }
}

async function step(model: MenuModel, ctx: DialogContext): Promise<void> {
  const screen = model.top;

  switch (screen.kind) {
    case "list": {
      return list(model, ctx, screen);
    }

    case "toggle": {
      return toggles(model, ctx, screen);
    }

    case "text": {
      return text(model, ctx, screen);
    }

    case "progress": {
      await screen.done;

      return undefined;
    }

    case "report": {
      await selectChoice(ctx, heading(model, ...screen.lines()), [BACK]);
      model.back();

      return undefined;
    }

    case "outcome": {
      const answer = await selectChoice(ctx, heading(model, ...screen.lines()), ["Close", BACK]);

      if (answer === "Close") {
        model.close();
      } else {
        model.back();
      }

      return undefined;
    }
  }
}
