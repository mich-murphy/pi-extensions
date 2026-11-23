import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MAX_BODY_BYTES } from "../protocol/json.js";
import { MAX_AUTHORED_BYTES } from "../protocol/schema.js";

const gatewayWire = readFileSync(new URL("../gateway/src/wire.rs", import.meta.url), "utf8");

function rustConstant(name: string): number {
  const match = new RegExp(String.raw`const ${name}: usize = (?<value>[\d_]+);`, "u").exec(
    gatewayWire,
  );
  if (match?.groups?.value === undefined) {
    throw new Error(`gateway/src/wire.rs no longer declares ${name}`);
  }
  return Number(match.groups.value.replaceAll("_", ""));
}

describe("protocol limits shared with the Rust gateway", () => {
  test.each([
    ["MAX_BODY", MAX_BODY_BYTES],
    ["MAX_AUTHORED", MAX_AUTHORED_BYTES],
  ])("the gateway's %s equals the TypeScript limit", (name, limit) => {
    expect(rustConstant(name)).toBe(limit);
  });
});
