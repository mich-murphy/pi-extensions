import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ClassifyOutcome, classifyRecord } from "../classify.ts";
import { JEV_MODEL, JEV_MODEL_ID, ownerQuestion } from "../jev.ts";
import { appendEvent, ledgerPath, readLedger } from "../ledger.ts";
import type { LedgerEvent, RecordEvent } from "../ledger.ts";
import { fakeClock, ownerEvent, report } from "./events.ts";
import { fakeClassifier } from "./fake-classifier.ts";
import type { FakeAnswer } from "./fake-classifier.ts";

const VAGUE = "the search tool/tool_error";
const OWN = ["pi-claude", "pi-web"];

const webAnswer: FakeAnswer = () => ({
  owner: { choice: "pi-web", probabilities: { "pi-web": 0.95, "pi-core": 0.05 } },
});

function asRecord(event: LedgerEvent): RecordEvent {
  if (event.type !== "report" && event.type !== "signal") {
    throw new Error("test setup: not a record");
  }

  return event;
}

const vague = asRecord(report({ n: 1, session: "a", owner: "unattributed", fingerprint: VAGUE }));

describe("classifyRecord owner question", () => {
  let root: string;
  let ledger: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-owner-"));
    ledger = ledgerPath(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function stored(): Promise<ReadonlyArray<LedgerEvent>> {
    const { events } = await readLedger(ledger);

    return events.filter((event) => event.type === "owner");
  }

  test("asks once per fingerprint which of our packages owns a vague report", async () => {
    const classifier = fakeClassifier(webAnswer);
    const job = { registry: classifier.registry, ledger, record: vague, ownPackages: OWN };

    await expect(classifyRecord(job)).resolves.toStrictEqual(
      ClassifyOutcome.classified({ calls: 1, failed: 0 }),
    );
    await expect(stored()).resolves.toMatchObject([
      { fingerprint: VAGUE, owner: "pi-web", probability: 0.95, model: JEV_MODEL },
    ]);

    const [call] = classifier.calls;
    expect(call?.model).toBe(JEV_MODEL_ID);
    expect(call?.context.state).toStrictEqual({
      kind: "workaround",
      component: "pi-claude",
      summary: "Scratch path changed between turns",
      expected: "One scratch path per session",
      actual: "A new path each turn",
    });
    const question = ownerQuestion(OWN);
    assert.ok(question !== undefined);
    expect(call?.context.questions).toStrictEqual(question);
    expect(Object.keys(question.owner.criteria)).toStrictEqual([
      "pi-claude",
      "pi-web",
      "pi-core",
      "other",
    ]);

    await classifyRecord(job);
    expect(classifier.calls).toHaveLength(1);
  });

  test("does not ask again when another machine already answered", async () => {
    const classifier = fakeClassifier(webAnswer);
    const { id: _id, at: _at, ...draft } = ownerEvent(1, VAGUE, "pi-peers", 0.5);
    await appendEvent(ledger, draft, fakeClock());
    await classifyRecord({
      registry: classifier.registry,
      ledger,
      record: vague,
      ownPackages: OWN,
    });
    expect(classifier.calls).toStrictEqual([]);
  });

  test("skips a vague report when no package of ours is loaded", async () => {
    const classifier = fakeClassifier(webAnswer);
    await expect(
      classifyRecord({ registry: classifier.registry, ledger, record: vague, ownPackages: [] }),
    ).resolves.toStrictEqual(ClassifyOutcome.skipped());
    expect(classifier.calls).toStrictEqual([]);
  });

  test("is unavailable without a TypeSafe key and sends nothing", async () => {
    const classifier = fakeClassifier(webAnswer, false);
    await expect(
      classifyRecord({ registry: classifier.registry, ledger, record: vague, ownPackages: OWN }),
    ).resolves.toStrictEqual(ClassifyOutcome.unavailable());
    expect(classifier.calls).toStrictEqual([]);
    await expect(stored()).resolves.toStrictEqual([]);
  });

  test("gives up on a call that outlasts the timeout and aborts it", async () => {
    const classifier = fakeClassifier(() => "hang");
    await expect(
      classifyRecord({
        registry: classifier.registry,
        ledger,
        record: vague,
        ownPackages: OWN,
        timeoutMs: 10,
      }),
    ).resolves.toStrictEqual(ClassifyOutcome.classified({ calls: 1, failed: 1 }));
    expect(classifier.calls[0]?.signal.aborted).toBe(true);
    await expect(stored()).resolves.toStrictEqual([]);
  });

  test.each<[string, FakeAnswer]>([
    ["an error", () => "error"],
    [
      "a throw",
      () => {
        throw new Error("boom");
      },
    ],
    ["a bool answer", () => ({ owner: 0.9 })],
  ])("counts %s as failed or stores nothing", async (_name, answer) => {
    const classifier = fakeClassifier(answer);

    const outcome = await classifyRecord({
      registry: classifier.registry,
      ledger,
      record: vague,
      ownPackages: OWN,
    });

    expect(outcome._tag).toBe("classified");
    await expect(stored()).resolves.toStrictEqual([]);
  });
  test("counts a classifier that throws before returning a promise", async () => {
    const classifier = fakeClassifier(webAnswer);
    const registry = {
      ...classifier.registry,
      classify: () => {
        throw new Error("sync");
      },
    };

    await expect(
      classifyRecord({ registry, ledger, record: vague, ownPackages: OWN }),
    ).resolves.toStrictEqual(ClassifyOutcome.classified({ calls: 1, failed: 1 }));
    await expect(stored()).resolves.toStrictEqual([]);
  });

  test("sends the home directory as ~", async () => {
    const classifier = fakeClassifier(webAnswer);
    const record = {
      ...vague,
      summary: "Read of /home/dev/notes.md failed",
      actual: "ENOENT /home/dev/a and /home/developer/b and /home/dev",
    };

    await classifyRecord({
      registry: classifier.registry,
      ledger,
      record,
      ownPackages: OWN,
      home: "/home/dev",
    });

    expect(classifier.calls[0]?.context.state).toMatchObject({
      summary: "Read of ~/notes.md failed",
      actual: "ENOENT ~/a and /home/developer/b and ~",
    });
  });

  test("describes every package in this repository", () => {
    const packages = readdirSync(fileURLToPath(new URL("../../", import.meta.url))).filter((name) =>
      name.startsWith("pi-"),
    );
    const question = ownerQuestion(packages);
    assert.ok(question !== undefined);

    expect(Object.keys(question.owner.criteria).toSorted()).toStrictEqual(
      [...packages, "other", "pi-core"].toSorted(),
    );
  });
});
