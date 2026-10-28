import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";
import { z } from "zod";
import { SdkToolContractError } from "./errors";

const keywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "enum",
  "const",
  "description",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
]);

function schemaChildren(key: string, value: unknown): readonly unknown[] {
  switch (key) {
    case "properties": {
      return Object.values(z.record(z.string(), z.unknown()).parse(value));
    }
    case "items": {
      return [value];
    }
    case "additionalProperties": {
      return typeof value === "boolean" ? [] : [value];
    }
    case "anyOf": {
      return z.array(z.unknown()).parse(value);
    }
    default: {
      return [];
    }
  }
}

function assertSupported(schema: unknown): void {
  for (const [key, value] of Object.entries(z.record(z.string(), z.unknown()).parse(schema))) {
    if (!keywords.has(key)) {
      throw new SdkToolContractError({ reason: "schema" });
    }
    for (const child of schemaChildren(key, value)) {
      assertSupported(child);
    }
  }
}

function normalizeSchema(input: unknown): unknown {
  const record = z.record(z.string(), z.unknown()).parse(input);
  const normalized = Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "$schema")
      .map(([key, child]) => {
        if (key === "properties") {
          return [
            key,
            Object.fromEntries(
              Object.entries(z.record(z.string(), z.unknown()).parse(child)).map(
                ([name, property]) => [name, normalizeSchema(property)],
              ),
            ),
          ];
        }
        if (key === "anyOf" && Array.isArray(child)) {
          return [key, child.map((schema: unknown) => normalizeSchema(schema))];
        }
        if (
          key === "items" ||
          (key === "additionalProperties" && typeof child === "object" && child !== null)
        ) {
          return [key, normalizeSchema(child)];
        }
        return [key, child];
      }),
  );
  if (normalized.type === "object" && !("additionalProperties" in normalized)) {
    normalized.additionalProperties = {};
  }
  if (normalized.additionalProperties === true) {
    normalized.additionalProperties = {};
  }
  if (Array.isArray(normalized.type) && normalized.anyOf === undefined) {
    normalized.anyOf = normalized.type.map((type: unknown) => normalizeSchema({ type }));
    delete normalized.type;
  }
  if (normalized.type === "integer") {
    if (normalized.multipleOf !== undefined && normalized.multipleOf !== 1) {
      throw new SdkToolContractError({ reason: "schema" });
    }
    normalized.type = "number";
    normalized.multipleOf = 1;
  }
  return normalized;
}

function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((child: unknown) => sortJson(child));
  }
  if (typeof input !== "object" || input === null) {
    return input;
  }
  return Object.fromEntries(
    Object.entries(input)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function canonical(value: unknown): string {
  return JSON.stringify(sortJson(normalizeSchema(value)));
}

export type CatalogTool = {
  readonly declaration: Tool;
  readonly mcpName: string;
  readonly sdkName: string;
  readonly schema: z.ZodType;
};

function mcpToolName(name: string): string {
  return /^[a-zA-Z0-9_-]{1,55}$/u.test(name) && !name.startsWith("pi_")
    ? name
    : `pi_${createHash("sha256").update(name).digest("hex").slice(0, 48)}`;
}

/** SDK-declared tool name, derived from the Pi name alone (independent of the current catalog). */
export function sdkToolName(piName: string): string {
  return `mcp__pi__${mcpToolName(piName)}`;
}

export function compileToolCatalog(tools: readonly Tool[]): readonly CatalogTool[] {
  const seen = new Set<string>();
  return tools.map((declaration) => {
    const name = declaration.name;
    const mcpName = mcpToolName(name);
    if (name.length === 0 || seen.has(mcpName)) {
      throw new SdkToolContractError({ reason: "naming" });
    }
    seen.add(mcpName);
    try {
      const source: unknown = structuredClone(declaration.parameters);
      assertSupported(source);
      const schema = z.fromJSONSchema(
        z.record(z.string(), z.json()).parse(normalizeSchema(source)),
      );
      if (
        !(schema instanceof z.ZodObject) ||
        canonical(source) !== canonical(z.toJSONSchema(schema, { target: "draft-7", io: "input" }))
      ) {
        throw new SdkToolContractError({ reason: "schema" });
      }
      return { declaration, mcpName, sdkName: sdkToolName(name), schema };
    } catch {
      throw new SdkToolContractError({ reason: "schema" });
    }
  });
}
