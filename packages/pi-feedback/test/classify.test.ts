import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClassifyOutcome, classifyRecord } from "../classify.ts";
import { JEV_MODEL, JEV_MODEL_ID, MAX_MERGE_COMPARISONS } from "../jev.ts";
import { appendEvent, ledgerPath, readLedger } from "../ledger.ts";
import type { LedgerEvent, RecordEvent } from "../ledger.ts";
import { fakeClock, signal, verdictEvent } from "./events.ts";
import { fakeClassifier } from "./fake-classifier.ts";

const recordScores = { harnessPath: 0.9, pathExisted: 0.8, outsideService: 0.05 };

function answerWith(sameCause: number) {
  return (context: ClassifierContext) =>
    "sameCause" in context.questions ? { sameCause } : recordScores;
}

function asSignal(event: LedgerEvent): RecordEvent {
  if (event.type !== "signal") {
    throw new Error("test setup: not a signal");
  }

  return event;
}

describe("classifyRecord", () => {
  let root: string;
  let ledger: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-classify-"));
    ledger = ledgerPath(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function seed(events: readonly LedgerEvent[]): Promise<void> {
    const clock = fakeClock(1000);

    for (const event of events) {
      const { id: _id, at: _at, ...draft } = event;
      await appendEvent(ledger, draft, clock);
    }
  }

  async function stored(type: LedgerEvent["type"]): Promise<LedgerEvent[]> {
    const { events } = await readLedger(ledger);

    return events.filter((event) => event.type === type);
  }

  test("stores one verdict per fingerprint from the pinned model", async () => {
    const classifier = fakeClassifier(answerWith(0.1));
    const record = asSignal(signal({ n: 1, session: "a" }));

    const outcome = await classifyRecord({
      registry: classifier.registry,
      ledger,
      record,
      input: { path: "/tmp/a" },
    });

    expect(outcome).toStrictEqual(ClassifyOutcome.classified({ calls: 1, failed: 0 }));
    expect(classifier.calls.map((call) => call.model)).toStrictEqual([JEV_MODEL_ID]);
    expect(classifier.calls[0]?.context.state).toStrictEqual({
      tool: "read",
      error: "ENOENT: no such file",
      input: '{"path":"/tmp/a"}',
    });
    await expect(stored("verdict")).resolves.toMatchObject([
      { fingerprint: record.fingerprint, model: JEV_MODEL, ...recordScores },
    ]);

    await classifyRecord({ registry: classifier.registry, ledger, record });
    expect(classifier.calls).toHaveLength(1);
  });

  test("redacts and clips the call input", async () => {
    const classifier = fakeClassifier(answerWith(0.1));
    await classifyRecord({
      registry: classifier.registry,
      ledger,
      record: asSignal(signal({ n: 1, session: "a" })),
      input: { command: `TOKEN=ghp_${"a".repeat(30)} ${"x".repeat(900)}` },
    });
    const input = classifier.calls[0]?.context.state.input;
    expect(input).toContain("TOKEN=<secret>");
    expect(input).toHaveLength(400);
  });

  test("asks about a report's own words", async () => {
    const classifier = fakeClassifier(answerWith(0.1));
    const { events } = await readLedger(ledger);
    expect(events).toStrictEqual([]);
    await classifyRecord({
      registry: classifier.registry,
      ledger,
      record: {
        type: "report",
        id: "00000000-0000-4000-8000-000000000001",
        at: "2026-11-25T00:00:00.000Z",
        session: "a",
        owner: "pi-claude",
        fingerprint: "pi-claude/workaround",
        kind: "workaround",
        component: "pi-claude",
        summary: "Scratch path changed",
        expected: "One path",
        actual: "A new path each turn",
        impact: "slowed",
      },
    });
    expect(classifier.calls[0]?.context.state).toStrictEqual({
      component: "pi-claude",
      kind: "workaround",
      error: "A new path each turn",
    });
  });

  test("compares a new fingerprint with open groups of the same owner and stores the answer", async () => {
    await seed([
      signal({ n: 1, session: "a", fingerprint: "read: older" }),
      signal({ n: 2, session: "b", owner: "pi-web", fingerprint: "webfetch: other" }),
    ]);
    const classifier = fakeClassifier(answerWith(0.95));
    const record = asSignal(signal({ n: 3, session: "c", fingerprint: "read: newer" }));
    const outcome = await classifyRecord({ registry: classifier.registry, ledger, record });
    expect(outcome).toStrictEqual(ClassifyOutcome.classified({ calls: 2, failed: 0 }));
    await expect(stored("same_cause")).resolves.toMatchObject([
      { owner: "pi-claude", a: "read: newer", b: "read: older", sameCause: 0.95 },
    ]);

    await classifyRecord({ registry: classifier.registry, ledger, record });
    expect(classifier.calls).toHaveLength(2);
  });

  test(`compares with at most ${MAX_MERGE_COMPARISONS} groups`, async () => {
    await seed(
      Array.from({ length: MAX_MERGE_COMPARISONS + 3 }, (_, index) =>
        signal({ n: index + 1, session: "a", fingerprint: `read: case ${index}` }),
      ),
    );
    const classifier = fakeClassifier(answerWith(0.1));
    await classifyRecord({
      registry: classifier.registry,
      ledger,
      record: asSignal(signal({ n: 99, session: "b", fingerprint: "read: new" })),
    });
    expect(classifier.calls).toHaveLength(MAX_MERGE_COMPARISONS + 1);
  });

  test("does not compare a record an outside service caused", async () => {
    await seed([
      signal({ n: 1, session: "a", fingerprint: "read: older" }),
      verdictEvent(2, "read: newer", { harnessPath: 0.1, pathExisted: 0.1, outsideService: 0.95 }),
    ]);
    const classifier = fakeClassifier(answerWith(0.95));
    const record = asSignal(signal({ n: 3, session: "b", fingerprint: "read: newer" }));
    await expect(
      classifyRecord({ registry: classifier.registry, ledger, record }),
    ).resolves.toStrictEqual(ClassifyOutcome.classified({ calls: 0, failed: 0 }));
  });

  test("counts failed calls and stores nothing for them", async () => {
    await seed([signal({ n: 1, session: "a", fingerprint: "read: older" })]);
    const classifier = fakeClassifier(() => "error");
    const record = asSignal(signal({ n: 2, session: "b", fingerprint: "read: newer" }));
    await expect(
      classifyRecord({ registry: classifier.registry, ledger, record }),
    ).resolves.toStrictEqual(ClassifyOutcome.classified({ calls: 2, failed: 2 }));
    await expect(stored("verdict")).resolves.toStrictEqual([]);
    await expect(stored("same_cause")).resolves.toStrictEqual([]);
  });

  test("ignores an answer that is missing a question", async () => {
    const classifier = fakeClassifier(() => ({ harnessPath: 0.9 }));
    await classifyRecord({
      registry: classifier.registry,
      ledger,
      record: asSignal(signal({ n: 1, session: "a" })),
    });
    await expect(stored("verdict")).resolves.toStrictEqual([]);
  });

  test("is unavailable without credentials", async () => {
    const classifier = fakeClassifier(answerWith(0.1), false);
    await expect(
      classifyRecord({
        registry: classifier.registry,
        ledger,
        record: asSignal(signal({ n: 1, session: "a" })),
      }),
    ).resolves.toStrictEqual(ClassifyOutcome.unavailable());
    expect(classifier.calls).toStrictEqual([]);
  });

  test("is unavailable without a catalog entry", async () => {
    const classifier = fakeClassifier(answerWith(0.1));
    const registry = { ...classifier.registry, getModelOfType: () => undefined };
    await expect(
      classifyRecord({ registry, ledger, record: asSignal(signal({ n: 1, session: "a" })) }),
    ).resolves.toStrictEqual(ClassifyOutcome.unavailable());
    expect(classifier.calls).toStrictEqual([]);
  });

  test.each([
    ["a batch-ordered read", signal({ n: 1, session: "a", cause: "parallel-batch" })],
    [
      "an unattributed failure without a Pi path",
      signal({ n: 1, session: "a", owner: "unattributed" }),
    ],
  ])("skips %s", async (_name, event) => {
    const classifier = fakeClassifier(answerWith(0.1));
    await expect(
      classifyRecord({ registry: classifier.registry, ledger, record: asSignal(event) }),
    ).resolves.toStrictEqual(ClassifyOutcome.skipped());
    expect(classifier.calls).toStrictEqual([]);
  });

  test("classifies an unattributed failure that names a Pi path", async () => {
    const classifier = fakeClassifier(answerWith(0.1));

    const record = asSignal(
      signal({ n: 1, session: "a", owner: "unattributed", evidence: "pi-path" }),
    );

    await expect(
      classifyRecord({ registry: classifier.registry, ledger, record }),
    ).resolves.toStrictEqual(ClassifyOutcome.classified({ calls: 1, failed: 0 }));
  });
});
