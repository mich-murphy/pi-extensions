import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeConfiguration } from "../adapter/config.js";
import { setupPaths } from "./backend.js";
import { createPrivate, digest, durableUnlink, regularBytes, withSetupLock } from "./files.js";
import type { ManagedSetup } from "./managed.js";
import { replaceOwned } from "./owned-file.js";
import type { LocalPlan } from "./plan.js";
import { SETTINGS_CHANGED } from "./refusal.js";
import { decodeManaged, parseJson } from "./schema.js";

export async function saveOwnedPlan(
  agentDir: string,
  previous: ManagedSetup,
  plan: LocalPlan,
  allowAdapterChange = false,
): Promise<void> {
  const paths = setupPaths(agentDir);
  await withSetupLock(paths.lock, previous.executable, async () => {
    const metadata = await regularBytes(paths.metadata);
    const adapter = await regularBytes(paths.adapter);
    const gateway = await regularBytes(paths.gateway);
    const pairing = await regularBytes(join(paths.directory, "pairing.json"));

    if (
      metadata === undefined ||
      adapter === undefined ||
      gateway === undefined ||
      digest(adapter) !== previous.adapterSha256 ||
      digest(gateway) !== previous.gatewaySha256 ||
      (pairing === undefined ? undefined : digest(pairing)) !== previous.pairingSha256
    ) {
      throw SETTINGS_CHANGED();
    }

    const current = decodeManaged(parseJson(metadata));

    if (!sameManaged(current, previous)) {
      throw SETTINGS_CHANGED();
    }

    const nextAdapter = `${JSON.stringify(plan.adapter, null, 2)}\n`;
    const nextGateway = `${JSON.stringify(plan.gateway, null, 2)}\n`;

    if (
      !allowAdapterChange &&
      !isDeepStrictEqual(decodeConfiguration(parseJson(adapter)), plan.adapter)
    ) {
      throw new Error(
        "This change would also change this Pi's peer permissions, so nothing was saved.",
      );
    }

    const next = { ...previous };
    next.adapterSha256 = digest(nextAdapter);
    next.gatewaySha256 = digest(nextGateway);
    await createPrivate(
      paths.journal,
      JSON.stringify({
        ...next,
        phase: "reviewed-config-update",
        previousAdapterSha256: previous.adapterSha256,
        previousGatewaySha256: previous.gatewaySha256,
      }),
    );

    await replaceOwned(paths.gateway, previous.gatewaySha256, nextGateway);
    await replaceOwned(paths.adapter, previous.adapterSha256, nextAdapter);
    await replaceOwned(paths.metadata, digest(metadata), `${JSON.stringify(next, null, 2)}\n`);
    await durableUnlink(paths.journal);
  });
}

function sameManaged(current: ManagedSetup, previous: ManagedSetup): boolean {
  const fields = [
    "version",
    "executable",
    "executableSha256",
    "adapterSha256",
    "gatewaySha256",
    "pairingSha256",
    "gatewayPath",
    "socketPath",
  ] as const;

  return fields.every((field) => current[field] === previous[field]);
}
