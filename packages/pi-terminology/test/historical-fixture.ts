import { readFileSync } from "node:fs";
import { isPolicy } from "../catalogue";
import type { Catalogue, Policy } from "../types";
import { composeGlossaries, parseGlossary } from "../validation";
import { expectOk } from "./helpers";

/** Consumed experiments use their immutable six-concept snapshot, never today's live bundle. */
export function historicalCatalogue(): Catalogue {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../evals/v2/candidates/with-criteria.json", import.meta.url), "utf8"),
  );
  return expectOk(
    composeGlossaries([expectOk(parseGlossary(value, "historical candidate", "core"))]),
  );
}

export function historicalPolicy(catalogue: Catalogue): Policy {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL("../evals/results/2026-10-15-round-2/policy.json", import.meta.url),
      "utf8",
    ),
  );
  if (!isPolicy(value, catalogue)) {
    throw new Error("Invalid historical policy fixture");
  }
  return value;
}
