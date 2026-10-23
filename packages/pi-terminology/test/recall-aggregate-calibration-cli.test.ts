import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { diagnoseRecallCalibration } from "../scripts/diagnose-recall-calibration";

const mocks = {
  files: new Map<string, string>(),
  read: vi.fn<(path: string) => Promise<string>>(),
  write:
    vi.fn<(path: string, text: string, options: { flag: "wx"; mode: number }) => Promise<void>>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  stat: vi.fn<(path: string) => Promise<unknown>>(),
  fixtures: vi.fn<NonNullable<Parameters<typeof diagnoseRecallCalibration>[2]>["fixtures"]>(),
  hash: "fbed4fced475b8c76e6da2a47550bbd02dacf26b00d475e639bd4297b98d19fc",
};
const io = {
  readText: mocks.read,
  canonical: mocks.realpath,
  write: mocks.write,
  marker: mocks.stat,
  fixtures: mocks.fixtures,
  hash: (value: string) =>
    value.includes('"NEVER-READ"') ? mocks.hash : createHash("sha256").update(value).digest("hex"),
};
const root = join(homedir(), ".pi/agent/pi-terminology/recall-2026-10-22");
const manifest = join(root, "manifest.json");
const output = "/tmp/offline-mocked-diagnostic.json";
function populate() {
  const ids = Array.from({ length: 51 }, (_, c) => `class-${c}`);
  const fixtures = Array.from({ length: 612 }, (_, r) => ({
    id: String(r),
    kind: "synthetic" as const,
    prompt: `invented training case ${r}`,
    named: [],
    labels: Object.fromEntries(
      ids.map((id, c) => [id, c === r % 51 ? ("positive" as const) : ("negative" as const)]),
    ),
  }));
  mocks.fixtures.mockResolvedValue(fixtures);
  const observations = fixtures
    .map((row, r) =>
      JSON.stringify({
        profile: "test-profile",
        observation: {
          id: row.id,
          split: "tuning",
          repeat: 0,
          alreadyNamed: [],
          probabilities: Object.fromEntries(
            ids.map((id, c) => [id, { native: Number(c === r % 51) }]),
          ),
        },
      }),
    )
    .join("\n");
  mocks.files.set(
    manifest,
    JSON.stringify({
      calibration: [
        {
          file: "fixtures/calibration.json",
          sha256: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"),
          records: 612,
          kind: "synthetic",
        },
      ],
      heldout: [{ file: "NEVER-READ" }],
    }),
  );
  mocks.files.set(join(root, "fixtures/calibration.json"), JSON.stringify(fixtures));
  mocks.files.set(join(root, "calibrate.observations.jsonl"), observations);
  mocks.files.set(
    join(root, "calibrate.report.json"),
    JSON.stringify({
      profile: "test-profile",
      thresholds: Object.fromEntries(ids.map((id) => [id, 0.9])),
    }),
  );
  mocks.files.set(
    join(root, "calibrate.receipt.json"),
    JSON.stringify({
      phase: "calibrate",
      binding: { manifest: mocks.hash, sources: { "immutable.ts": "original-source-hash" } },
    }),
  );
}
describe("offline calibration CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.files.clear();
    mocks.hash = "fbed4fced475b8c76e6da2a47550bbd02dacf26b00d475e639bd4297b98d19fc";
    mocks.read.mockImplementation(async (path) => {
      const text = mocks.files.get(path);
      if (text === undefined) {
        throw new Error(`Forbidden read: ${path}`);
      }
      return text;
    });
    mocks.realpath.mockImplementation(async (path) => path);
    mocks.stat.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
    mocks.write.mockResolvedValue(undefined);
    populate();
  });

  test("offline CLI reads only the pinned calibration artifacts and writes one exclusive private diagnostic", async () => {
    const result = await diagnoseRecallCalibration(manifest, output, io);
    expect(result.feasible).toBe(true);
    expect(result.collectionProvenance).toMatchObject({
      nativeProofClaim: false,
      calibrationCompletePresent: false,
      originalSourceBindings: { "immutable.ts": "original-source-hash" },
    });
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(output, expect.any(String), {
      flag: "wx",
      mode: 0o600,
    });
    const allowed = new Set(mocks.files.keys());
    expect(mocks.read.mock.calls.map(([path]) => path).every((path) => allowed.has(path))).toBe(
      true,
    );
    expect(mocks.stat).toHaveBeenCalledExactlyOnceWith(join(root, "calibrate.complete.json"));
  });

  test("refuses arbitrary manifests and non-diagnostic output names before IO", async () => {
    await expect(diagnoseRecallCalibration("/tmp/manifest.json", output, io)).rejects.toThrow(
      /fixed current/u,
    );
    await expect(diagnoseRecallCalibration(manifest, "/tmp/policy.json", io)).rejects.toThrow(
      /offline-/u,
    );
    expect(mocks.read).not.toHaveBeenCalled();
  });

  test("rejects manifest mutations and symlinks without collection reads", async () => {
    mocks.hash = "mutated";
    await expect(diagnoseRecallCalibration(manifest, output, io)).rejects.toThrow(/hash mismatch/u);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    mocks.realpath.mockResolvedValue("/tmp/heldout.json");
    await expect(diagnoseRecallCalibration(manifest, output, io)).rejects.toThrow(/symlinks/u);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  test("never filters missing or extra observations and cannot write over an existing file", async () => {
    const path = join(root, "calibrate.observations.jsonl");
    const original = String(mocks.files.get(path));
    mocks.files.set(path, original.split("\n").slice(1).join("\n"));
    await expect(diagnoseRecallCalibration(manifest, output, io)).rejects.toThrow(
      /Missing observations/u,
    );
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.files.set(path, original);
    mocks.write.mockRejectedValue(Object.assign(new Error("exists"), { code: "EEXIST" }));
    await expect(diagnoseRecallCalibration(manifest, output, io)).rejects.toThrow("exists");
  });

  test("complete marker presence is reported but is not asserted to be native proof", async () => {
    mocks.stat.mockResolvedValue({});
    const result = await diagnoseRecallCalibration(manifest, output, io);
    expect(result.collectionProvenance).toMatchObject({
      calibrationCompletePresent: true,
      nativeProofClaim: false,
    });
    expect(result.promotable).toBe(false);
  });

  test("unexpected marker errors fail closed without output", async () => {
    mocks.stat.mockRejectedValue(new Error("permission denied"));
    await expect(diagnoseRecallCalibration(manifest, output, io)).rejects.toThrow(
      "permission denied",
    );
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
