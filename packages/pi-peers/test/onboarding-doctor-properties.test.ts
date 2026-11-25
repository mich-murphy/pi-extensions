import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Schema } from "effect";
import { describe, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { decodeConfiguration } from "../adapter/config.js";
import type { Configuration } from "../adapter/config.js";
import { invalidFields } from "../onboarding/doctor.js";

type Field = { required: boolean; valid: readonly Schema.Json[]; invalid: readonly Schema.Json[] };
const fields = {
  machineId: { required: true, valid: ["host", "a-1"], invalid: ["Host", "", 3] },
  socketPath: {
    required: true,
    valid: ["/tmp/pi.sock"],
    invalid: ["relative", `/${"x".repeat(120)}`, "/tmp/\u0007"],
  },
  scopeIds: {
    required: true,
    valid: [["local"], ["a", "b"]],
    invalid: [[], ["a", "a"], ["bad scope"], "local"],
  },
  label: {
    required: true,
    valid: ["Pi", "界 session"],
    invalid: ["", "\u0007", "‮", " ", "x".repeat(129)],
  },
  policies: {
    required: true,
    valid: [
      [],
      [{ machineId: "beta", scopeId: "team", permissions: ["discover", "push"] }],
      [
        {
          machineId: "beta",
          scopeId: "team",
          permissions: ["discover", "read", "push", "interest"],
        },
      ],
    ],
    invalid: [
      [{ machineId: "beta", scopeId: "team", permissions: ["admin"] }],
      [{ machineId: "Beta", scopeId: "team", permissions: [] }],
      {},
    ],
  },
  shareBranch: { required: false, valid: [true, false], invalid: ["yes", 1] },
  maxWaitSeconds: { required: false, valid: [1, 60, 300], invalid: [0, 301, 1.5, "60"] },
} satisfies Record<keyof Configuration, Field>;

function accepted(value: Schema.Json): boolean {
  try {
    decodeConfiguration(value);
    return true;
  } catch {
    return false;
  }
}
function assertDoctorMatchesAdapter(tc: TestCase): void {
  const value: Record<string, Schema.Json> = {};
  const expected: string[] = [];
  for (const [name, field] of Object.entries<Field>(fields)) {
    const choice = tc.draw(gs.sampledFrom(["absent", "valid", "invalid"] as const), name);
    if (choice === "absent") {
      expected.push(...(field.required ? [name] : []));
      continue;
    }
    value[name] = tc.draw(
      gs.sampledFrom(choice === "valid" ? field.valid : field.invalid),
      `${name} value`,
    );
    expected.push(...(choice === "invalid" ? [name] : []));
  }
  const stray = tc.draw(gs.optional(gs.sampledFrom(["watch", "publications", "extra"])), "stray");
  if (stray !== null) {
    value[stray] = true;
    expected.push("unknown");
  }
  const reported = invalidFields(value);
  assert.equal(
    reported.length === 0,
    accepted(value),
    "the doctor and the adapter disagree on whether the config is valid",
  );
  assert.deepEqual(
    reported
      .map((entry) => entry.split(" ")[0] ?? entry)
      .toSorted((left, right) => left.localeCompare(right)),
    expected.toSorted((left, right) => left.localeCompare(right)),
    "the doctor named the wrong fields",
  );
}

describe("Hegel doctor configuration properties", () => {
  test(
    "the doctor reports problems exactly when the adapter rejects the config, naming each bad field",
    { timeout: propertyTimeout(30_000) },
    () => {
      assertHegel(propertySettings(200), (tc) => {
        assertDoctorMatchesAdapter(tc);
      });
    },
  );
});
