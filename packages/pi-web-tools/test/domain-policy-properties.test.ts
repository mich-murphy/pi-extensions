import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Result } from "effect";
import { describe, expect, test } from "vitest";
import { checkDomainPolicy } from "../domain-policy";
import type { DomainPolicy } from "../domain-policy";
import { parsePublicHttpUrl } from "../types";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };

// A tiny label pool makes suffix collisions, near misses ("notevil") and case variants common.
const LABELS = ["evil", "notevil", "com", "org", "a", "b", "EVIL", "Com"];
const labelsGenerator = (minSize: number, maxSize: number) =>
  gs.arrays(gs.sampledFrom(LABELS), { minSize, maxSize });

function toUrl(labels: readonly string[], trailingDot: boolean) {
  const parsed = parsePublicHttpUrl(`https://${labels.join(".")}${trailingDot ? "." : ""}/x`);
  if (Result.isFailure(parsed)) {
    throw new Error("generated url rejected");
  }
  return parsed.success;
}

// Label-based oracle: an entry matches when its labels are a suffix of the host's labels.
const lower = (labels: readonly string[]) => labels.map((label) => label.toLowerCase());
function matches(host: readonly string[], entry: readonly string[]): boolean {
  const h = lower(host);
  const e = lower(entry);
  return (
    e.length <= h.length && e.every((label, index) => label === h[h.length - e.length + index])
  );
}
function expectedAllowed(host: readonly string[], allow: string[][], deny: string[][]): boolean {
  if (deny.some((entry) => matches(host, entry))) {
    return false;
  }
  return allow.length === 0 || allow.some((entry) => matches(host, entry));
}
const toPolicy = (allow: string[][], deny: string[][]): DomainPolicy => ({
  allow: allow.map((entry) => entry.join(".").toLowerCase()),
  deny: deny.map((entry) => entry.join(".").toLowerCase()),
});

type Names = string[][];
const okFor = (url: ReturnType<typeof toUrl>, allow: Names, deny: Names) =>
  Result.isSuccess(checkDomainPolicy(url, toPolicy(allow, deny)));

function checkVerdict(host: string[], allow: Names, deny: Names, dot: boolean): void {
  assert.equal(okFor(toUrl(host, dot), allow, deny), expectedAllowed(host, allow, deny));
}

function checkMonotonic(host: string[], allow: Names, deny: Names, extra: string[]): void {
  const url = toUrl(host, false);
  if (!okFor(url, allow, deny)) {
    assert.equal(okFor(url, allow, [...deny, extra]), false);
  }
  if (allow.length > 0 && okFor(url, allow, deny)) {
    assert.equal(okFor(url, [...allow, extra], deny), true);
  }
}

const listGenerator = gs.arrays(labelsGenerator(1, 3), { maxSize: 3 });

describe("checkDomainPolicy properties", () => {
  test("verdict matches a label-suffix model, with or without a trailing dot", () => {
    new Hegel((tc) => {
      expect(() => {
        checkVerdict(
          tc.draw(labelsGenerator(1, 4), "host"),
          tc.draw(listGenerator, "allow"),
          tc.draw(listGenerator, "deny"),
          tc.draw(gs.booleans(), "trailingDot"),
        );
      }).not.toThrow();
    })
      .databaseKey("pi-web-tools/domain-policy-model")
      .settings(settings)
      .runSync();
  });

  test("adding a deny entry never helps and adding an allow entry never hurts", () => {
    new Hegel((tc) => {
      expect(() => {
        checkMonotonic(
          tc.draw(labelsGenerator(1, 4), "host"),
          tc.draw(listGenerator, "allow"),
          tc.draw(listGenerator, "deny"),
          tc.draw(labelsGenerator(1, 3), "extra"),
        );
      }).not.toThrow();
    })
      .databaseKey("pi-web-tools/domain-policy-monotonic")
      .settings(settings)
      .runSync();
  });
});
