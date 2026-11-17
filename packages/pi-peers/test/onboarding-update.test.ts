import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyLocal, setupPaths } from "../onboarding/backend.js";
import { createPrivate } from "../onboarding/files.js";
import type { ManagedSetup } from "../onboarding/managed.js";
import { defaultChoices, localPlan } from "../onboarding/plan.js";
import { saveOwnedPlan } from "../onboarding/update.js";
import { nativeFixture } from "./onboarding-fixtures.js";

const metadataFields = [
  "version",
  "executable",
  "executableSha256",
  "adapterSha256",
  "gatewaySha256",
  "pairingSha256",
  "gatewayPath",
  "socketPath",
  "unknownField",
] as const;
type PairMutation = "replace" | "remove";
async function snapshot(agent: string) {
  const paths = setupPaths(agent);
  const entries = await readdir(paths.directory);
  const files = [paths.adapter, ...entries.map((name) => join(paths.directory, name))];
  const state = await Promise.all(
    files.map(async (path) => {
      const bytes = await readFile(path);
      const stat = await lstat(path, { bigint: true });
      return { path, bytes, mtimeNs: stat.mtimeNs, ino: stat.ino };
    }),
  );
  return { entries, state };
}
async function changePair(path: string, mutation: PairMutation) {
  if (mutation === "remove") {
    await rm(path);
    return;
  }
  await writeFile(path, '{"external":"changed public pairing"}');
}
function changedMetadata(
  previous: ManagedSetup,
  field: (typeof metadataFields)[number],
  root: string,
) {
  const replacement = {
    version: 2,
    executable: join(root, "external-bin"),
    executableSha256: "0".repeat(64),
    adapterSha256: "0".repeat(64),
    gatewaySha256: "0".repeat(64),
    pairingSha256: "0".repeat(64),
    gatewayPath: join(root, "external-gateway.json"),
    socketPath: join(root, "external.sock"),
    unknownField: "not owned",
  };
  return { ...previous, [field]: replacement[field] };
}
describe("reviewed maintenance refuses metadata/pairing drift before mutation", () => {
  let fixture: Awaited<ReturnType<typeof nativeFixture>>;
  let agent: string;
  beforeEach(async () => {
    fixture = await nativeFixture();
    vi.stubEnv("HOME", fixture.root);
    agent = join(fixture.root, "agent");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(fixture.root, { recursive: true, force: true });
  });
  async function reviewed(withPairing: boolean) {
    const plan = localPlan(defaultChoices("Maintenance"), setupPaths(agent).socket);
    const prepare = withPairing
      ? async () => {
          await createPrivate(
            join(setupPaths(agent).directory, "pairing.json"),
            '{"public":"reviewed fixture"}',
          );
          return plan;
        }
      : undefined;
    const previous = await applyLocal(
      agent,
      plan,
      { acquire: async () => fixture.executable },
      () => undefined,
      prepare,
    );
    return { plan, previous };
  }
  test.each(metadataFields)(
    "changed metadata scalar/schema %s is retained with zero projection/journal writes",
    async (field) => {
      const { plan, previous } = await reviewed(true);
      await writeFile(
        setupPaths(agent).metadata,
        JSON.stringify(changedMetadata(previous, field, fixture.root)),
      );
      const before = await snapshot(agent);
      await expect(saveOwnedPlan(agent, previous, plan)).rejects.toBeInstanceOf(Error);
      await expect(snapshot(agent)).resolves.toStrictEqual(before);
    },
  );
  test.each([
    { name: "changed owned pairing", reviewed: true, mutation: "replace" as const },
    { name: "removed owned pairing", reviewed: true, mutation: "remove" as const },
    {
      name: "new external pairing where none was reviewed",
      reviewed: false,
      mutation: "replace" as const,
    },
  ])("$name is retained even when no pairingContent update was requested", async (entry) => {
    const { plan, previous } = await reviewed(entry.reviewed);
    await changePair(join(setupPaths(agent).directory, "pairing.json"), entry.mutation);
    const before = await snapshot(agent);
    await expect(saveOwnedPlan(agent, previous, plan)).rejects.toThrow("Managed snapshots changed");
    await expect(snapshot(agent)).resolves.toStrictEqual(before);
  });
  test("pairing drift also refuses a reviewed pairing replacement before journal creation", async () => {
    const { plan, previous } = await reviewed(true);
    await changePair(join(setupPaths(agent).directory, "pairing.json"), "replace");
    const before = await snapshot(agent);
    await expect(
      saveOwnedPlan(agent, previous, plan, '{"public":"approved replacement"}'),
    ).rejects.toThrow("Managed snapshots changed");
    await expect(snapshot(agent)).resolves.toStrictEqual(before);
  });
});
