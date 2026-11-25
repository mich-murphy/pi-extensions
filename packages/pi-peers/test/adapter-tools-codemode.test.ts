import { describe, expect, test } from "vitest";
import { registerTools } from "../adapter/tools.js";

type Declared = { name: string; description: string };
type Loadout = { declared: readonly Declared[] };
type Definition = {
  name: string;
  description: string;
  exposure?: string;
  prepareLoadout?: (loadout: Loadout) => { descriptions?: Record<string, string> } | undefined;
};

function definitions(): Map<string, Definition> {
  const tools = new Map<string, Definition>();
  Reflect.apply(registerTools, undefined, [
    {
      registerTool: (tool: Definition) => {
        tools.set(tool.name, tool);
      },
    },
    () => undefined,
  ]);
  return tools;
}

function loadoutOf(names: string[], tools: Map<string, Definition>): Loadout {
  return {
    declared: names.map((name) => ({
      name,
      description: descriptionOf(tools, name),
    })),
  };
}

function descriptionOf(tools: Map<string, Definition>, name: string): string {
  return tools.get(name)?.description ?? name;
}

const note = "Not callable from codemode scripts; call it directly.";

describe.each(["peers_send", "peers_take"])("%s codemode note", (name) => {
  test("is model-only", () => {
    expect(definitions().get(name)?.exposure).toBe("model-only");
  });

  test("leaves the description unchanged when codemode is not declared", () => {
    const tools = definitions();
    const changes = tools
      .get(name)
      ?.prepareLoadout?.(loadoutOf(["peers_list", "peers_send", "peers_take"], tools));
    expect(changes).toBeUndefined();
  });

  test("tells the model to call it directly when codemode is declared", () => {
    const tools = definitions();
    const original = descriptionOf(tools, name);
    const changes = tools
      .get(name)
      ?.prepareLoadout?.(loadoutOf(["peers_list", "peers_send", "peers_take", "codemode"], tools));
    expect(changes).toStrictEqual({ descriptions: { [name]: `${original} ${note}` } });
  });
});

describe("peers_list codemode note", () => {
  test("stays scriptable without a direct-only note", () => {
    const tools = definitions();
    expect(tools.get("peers_list")?.prepareLoadout).toBeUndefined();
    expect(tools.get("peers_list")?.description).not.toContain(note);
  });
});
