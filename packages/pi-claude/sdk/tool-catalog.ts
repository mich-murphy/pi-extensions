import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { z } from "zod";
import { writeRedirectedDiagnostic } from "../diagnostic-output";
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

const readSchemaObject = Schema.decodeUnknownSync(Schema.JsonObject);

function schemaObject(value: Schema.Json): Schema.JsonObject {
  if (isJsonArray(value) || !Schema.is(Schema.ObjectKeyword)(value)) {
    throw new SdkToolContractError({ reason: "schema" });
  }

  return value;
}

function schemaEntries(value: Schema.JsonObject) {
  return Object.entries(value).filter(([key]) => key !== "__proto__");
}

function isJsonArray(input: Schema.Json): input is Schema.JsonArray {
  return Array.isArray(input);
}

function schemaChildren(key: string, value: Schema.Json): readonly Schema.Json[] {
  switch (key) {
    case "properties": {
      return schemaEntries(schemaObject(value)).map(([, child]) => child);
    }

    case "items": {
      return [value];
    }

    case "additionalProperties": {
      return Schema.is(Schema.Boolean)(value) ? [] : [value];
    }

    case "anyOf": {
      if (!isJsonArray(value)) {
        throw new SdkToolContractError({ reason: "schema" });
      }

      return value;
    }

    default: {
      return [];
    }
  }
}

function assertSupported(schema: Schema.JsonObject): void {
  for (const [key, value] of schemaEntries(schema)) {
    if (!keywords.has(key)) {
      throw new SdkToolContractError({ reason: "schema" });
    }

    for (const child of schemaChildren(key, value)) {
      assertSupported(schemaObject(child));
    }
  }
}

function normalizeSchema(record: Schema.JsonObject): Schema.JsonObject {
  const normalized = Object.fromEntries(
    schemaEntries(record)
      .filter(([key]) => key !== "$schema")
      .map(([key, child]) => {
        if (key === "properties") {
          return [
            key,
            Object.fromEntries(
              schemaEntries(schemaObject(child)).map(([name, property]) => [
                name,
                normalizeSchema(schemaObject(property)),
              ]),
            ),
          ];
        }

        if (key === "anyOf" && isJsonArray(child)) {
          return [key, child.map((schema) => normalizeSchema(schemaObject(schema)))];
        }

        if (
          key === "items" ||
          (key === "additionalProperties" && Schema.is(Schema.ObjectKeyword)(child))
        ) {
          return [key, normalizeSchema(schemaObject(child))];
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

  if (
    normalized.type !== undefined &&
    isJsonArray(normalized.type) &&
    normalized.anyOf === undefined
  ) {
    normalized.anyOf = normalized.type.map((type) => normalizeSchema({ type }));
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

function sortJson(input: Schema.Json): Schema.Json {
  if (isJsonArray(input)) {
    return input.map((child) => sortJson(child));
  }

  if (!Schema.is(Schema.ObjectKeyword)(input)) {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function canonical(value: Schema.JsonObject): string {
  return JSON.stringify(sortJson(normalizeSchema(value)));
}

const reportedDegraded = new Set<string>();

export type CatalogTool = {
  readonly declaration: Tool;
  readonly mcpName: string;
  readonly sdkName: string;
  readonly schema: z.ZodType;
  readonly degraded?: boolean;
};

function mcpToolName(name: string): string {
  return /^[a-zA-Z0-9_-]{1,55}$/u.test(name) && !name.startsWith("pi_")
    ? name
    : `pi_${createHash("sha256").update(name).digest("hex").slice(0, 48)}`;
}

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
      const source = readSchemaObject(structuredClone(declaration.parameters));
      assertSupported(source);

      const schema = z.fromJSONSchema(
        z.record(z.string(), z.json()).parse(normalizeSchema(source)),
      );

      if (
        schema.def.type !== "object" ||
        canonical(source) !==
          canonical(readSchemaObject(z.toJSONSchema(schema, { target: "draft-7", io: "input" })))
      ) {
        throw new SdkToolContractError({ reason: "schema" });
      }

      return { declaration, mcpName, sdkName: sdkToolName(name), schema };
    } catch {
      if (!reportedDegraded.has(name)) {
        reportedDegraded.add(name);
        writeRedirectedDiagnostic(
          `[claude-tool-schema] unsupported schema, using permissive: ${JSON.stringify(name)}\n`,
        );
      }

      return {
        declaration,
        mcpName,
        sdkName: sdkToolName(name),
        schema: z.object({}).catchall(z.json()),
        degraded: true,
      };
    }
  });
}
