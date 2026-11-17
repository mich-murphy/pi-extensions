import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, expect, test } from "vitest";
import { models } from "../models";
import { assertModelMetadata } from "./sdk-model-metadata";

function catalog(): ModelInfo[] {
  return models.map((entry) => ({
    value: entry.sdkModel === "claude-fable-5-2" ? "fable" : entry.sdkModel,
    resolvedModel: entry.canonicalModel,
    displayName: entry.name,
    description: "Metadata contract fixture",
    ...(entry.canonicalModel === "claude-haiku-4-5"
      ? {}
      : {
          supportsAdaptiveThinking: true,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        }),
  }));
}

function rowAt(rows: ModelInfo[], index: number): ModelInfo {
  const row = rows.at(index);
  assert(row !== undefined, "missing fixture row");
  return row;
}

function fableRow(rows: ModelInfo[]): ModelInfo {
  return rowAt(rows, 2);
}

describe("advertised SDK model metadata", () => {
  test("matches concrete Fable to its supported alias resolution without losing any models", () => {
    const rows = catalog();
    rowAt(rows, 4).value = "claude-haiku-4-5-20251001";
    rowAt(rows, 4).resolvedModel = "claude-haiku-4-5-20251001";
    expect(() => {
      assertModelMetadata(rows);
    }).not.toThrow();
  });

  test("accepts a direct concrete selector row", () => {
    const rows = catalog();
    fableRow(rows).value = "claude-fable-5-2";
    expect(() => {
      assertModelMetadata(rows);
    }).not.toThrow();
  });

  test("rejects a missing advertised model", () => {
    for (let index = 0; index < models.length; index++) {
      expect(() => {
        assertModelMetadata(catalog().filter((_, row) => row !== index));
      }).toThrow("missing model metadata");
    }
  });

  test("does not infer capabilities from a model family or an older alias resolution", () => {
    const rows = catalog();
    fableRow(rows).resolvedModel = "claude-fable-5-1";
    expect(() => {
      assertModelMetadata(rows);
    }).toThrow("missing model metadata");
  });

  test("does not mask moving alias drift with another correctly resolved row", () => {
    const rows = catalog();
    rows.push({ ...rowAt(rows, 0), value: "default" });
    rowAt(rows, 0).resolvedModel = "claude-sonnet-5";
    expect(() => {
      assertModelMetadata(rows);
    }).toThrow("metadata resolution");
    rows.shift();
    expect(() => {
      assertModelMetadata(rows);
    }).toThrow("missing model metadata for sonnet");
  });

  test("prefers direct selectors even when an alias has the expected resolution", () => {
    const rows = catalog();
    rows.push({ ...fableRow(rows), value: "claude-fable-5-2", resolvedModel: "claude-fable-5-1" });
    expect(() => {
      assertModelMetadata(rows);
    }).toThrow("metadata resolution");
    delete rowAt(rows, -1).resolvedModel;
    expect(() => {
      assertModelMetadata(rows);
    }).toThrow("missing resolution");
  });

  test("requires resolution rather than trusting the selector name", () => {
    const rows = catalog();
    delete rowAt(rows, 0).resolvedModel;
    expect(() => {
      assertModelMetadata(rows);
    }).toThrow("missing resolution");
    delete fableRow(rows).resolvedModel;
    expect(() => {
      assertModelMetadata(rows.slice(1), models.slice(1));
    }).toThrow("missing model metadata");
  });

  test("rejects absent or incomplete native capabilities on a canonical alias match", () => {
    for (const field of [
      "supportsAdaptiveThinking",
      "supportsEffort",
      "supportedEffortLevels",
    ] as const) {
      const rows = catalog();
      Object.assign(fableRow(rows), { [field]: undefined });
      expect(() => {
        assertModelMetadata(rows);
      }).toThrow("native thinking metadata");
    }
    const rows = catalog();
    fableRow(rows).supportedEffortLevels = ["low", "medium", "high"];
    expect(() => {
      assertModelMetadata(rows);
    }).toThrow("native thinking metadata");
  });

  test("does not grant legacy Haiku adaptive thinking or native effort", () => {
    const rows = catalog();
    rowAt(rows, 4).supportsEffort = true;
    expect(() => {
      assertModelMetadata(rows);
    }).toThrow("native thinking metadata");
  });
});
