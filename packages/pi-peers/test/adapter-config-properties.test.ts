import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import { arrays, sampledFrom } from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { decodeConfiguration, dropRetiredPermissions } from "../adapter/config.js";
import { permissions as livePermissions } from "../onboarding/plan.js";
import { decodeGateway } from "../onboarding/schema.js";

const retired = ["read", "interest"] as const;
const everyPermission = [...livePermissions, ...retired];

type Policy = {
  machineId: string;
  scopeId: string;
  permissions: Array<string>;
  direction: "outgoing" | "incoming";
};

function drawPolicies(tc: TestCase): Array<Policy> {
  return tc.draw(
    arrays(
      sampledFrom(["alpha", "beta"]).flatMap((machineId) =>
        sampledFrom(["outgoing", "incoming"] as const).flatMap((direction) =>
          arrays(sampledFrom(everyPermission), { unique: true }).map((permissions) => ({
            machineId,
            scopeId: "team",
            permissions,
            direction,
          })),
        ),
      ),
      { maxSize: 6 },
    ),
    "policies",
  );
}

function grants(policies: ReadonlyArray<Policy>): Array<string> {
  return policies
    .flatMap((policy) =>
      policy.permissions
        .filter((permission) => !retired.some((name) => name === permission))
        .map((permission) => `${policy.machineId}/${policy.direction}/${permission}`),
    )
    .toSorted();
}

function assertDropKeepsLiveGrants(tc: TestCase): void {
  const policies = drawPolicies(tc);
  const gateway = { machineId: "alpha", socketPath: "/tmp/g.sock", scopeIds: ["team"], policies };
  const dropped = dropRetiredPermissions(gateway);
  assert.deepEqual(dropRetiredPermissions(dropped), dropped, "dropping twice changes more");
  const decoded = decodeGateway(gateway);

  const kept = decoded.policies.map((policy) => ({
    ...policy,
    permissions: [...policy.permissions],
  }));

  assert.deepEqual(grants(kept), grants(policies), "a live grant was lost or invented");
  assert.equal(
    kept.filter((policy) => policy.permissions.length === 0).length,
    policies.filter((policy) => policy.permissions.length === 0).length,
    "retirement left a policy with no permissions, which the gateway refuses to start with",
  );

  if (policies.every((policy) => grants([policy]).length === policy.permissions.length)) {
    assert.equal(JSON.stringify(dropped), JSON.stringify(gateway), "an untouched file changed");
  }

  const adapter = decodeConfiguration({
    machineId: "alpha",
    socketPath: "/tmp/g.sock",
    scopeIds: ["team"],
    label: "alpha",
    policies: policies.map(({ direction: _direction, ...policy }) => policy),
  });

  assert.deepEqual(
    adapter.policies.map((policy) => policy.permissions),
    kept.map((policy) => policy.permissions),
    "the adapter and setup decoders drop retired permissions differently",
  );
}

describe("Hegel retired permission properties", () => {
  test(
    "older configs keep every live grant, lose every retired one, and never gain an empty policy",
    { timeout: propertyTimeout(30_000) },
    () => {
      assertHegel(propertySettings(200), (tc) => {
        assertDropKeepsLiveGrants(tc);
      });
    },
  );
});
