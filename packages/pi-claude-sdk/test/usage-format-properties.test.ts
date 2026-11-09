import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { formatClaudeUsageStatus } from "../sdk-usage";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };

describe("formatClaudeUsageStatus properties", () => {
  test("remaining percentage has at most two decimals and is within rounding of 100 - used", () => {
    new Hegel((tc) => {
      const used = tc.draw(gs.floats({ minValue: 0, maxValue: 100, allowNan: false }), "used");
      const text = formatClaudeUsageStatus({
        subscriptionType: null,
        rateLimitsAvailable: true,
        windows: [{ name: "W", usedPercent: used, resetsAt: null }],
        extraUsageEnabled: null,
      });
      const match = /^W: (?<remaining>\d+(?:\.\d{1,2})?)% remaining, /u.exec(text);
      assert.ok(match?.groups, `unexpected rendering: ${text}`);
      const remaining = Number(match.groups.remaining);
      assert.ok(Math.abs(remaining - (100 - used)) <= 0.005 + 1e-9, text);
    })
      .databaseKey("pi-claude-sdk/usage-format")
      .settings(settings)
      .runSync();
  });
});
