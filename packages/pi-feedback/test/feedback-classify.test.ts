import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerFeedback } from "../feedback.ts";
import { JEV_MODEL } from "../jev.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import { deriveGroups } from "../queue.ts";
import { fakeClock } from "./events.ts";
import { fakeClassifier } from "./fake-classifier.ts";
import type { FakeAnswer } from "./fake-classifier.ts";
import { fakePi } from "./fake-pi.ts";

const PACKAGES = "/repo/packages";
const scores = { harnessPath: 0.2, pathExisted: 0.3, outsideService: 0.05 };

function answer(context: ClassifierContext) {
  return "sameCause" in context.questions ? { sameCause: 0.9 } : scores;
}

describe("harness feedback classification", () => {
  let root: string;
  let ledger: string;
  let tasks: Array<Promise<void>>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-classify-ext-"));
    ledger = ledgerPath(root);
    tasks = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function setup(classify: FakeAnswer, configured = true) {
    const classifier = fakeClassifier(classify, configured);
    const pi = fakePi(PACKAGES, "/home/u/.pi/agent", classifier.registry);
    registerFeedback(pi.pi, {
      ledger,
      packagesDir: PACKAGES,
      ownPackages: ["pi-claude", "pi-web"],
      agentDir: "/home/u/.pi/agent",
      home: "/home/u",
      piVersion: "1.6.0",
      clock: fakeClock(),
      schedule: (task) => {
        tasks.push(task());
      },
    });

    return { pi, classifier };
  }

  async function settled() {
    await Promise.all(tasks);
    const { events } = await readLedger(ledger);

    return events;
  }

  test("classifies a failed call with the arguments from its batch", async () => {
    const { pi, classifier } = setup(answer);
    pi.batch([{ id: "w1", name: "webfetch", args: { url: "https://example.invalid/a" } }]);
    await pi.end("webfetch", true, "Request failed (500).", "w1");
    const events = await settled();
    expect(events).toMatchObject([
      { type: "signal", owner: "pi-web" },
      { type: "verdict", model: JEV_MODEL, ...scores },
    ]);
    expect(classifier.calls[0]?.context.state).toMatchObject({
      tool: "webfetch",
      input: '{"url":"https://example.invalid/a"}',
    });
  });

  test("classifies a report after recording it", async () => {
    const { pi } = setup(answer);
    await pi.call({
      kind: "workaround",
      component: "pi-claude",
      summary: "Scratch path changed between turns",
      expected: "One scratch path per session",
      actual: "ENOENT on a path from an earlier turn",
      impact: "slowed",
    });
    const events = await settled();
    expect(events.map((event) => event.type)).toStrictEqual(["report", "verdict"]);
  });

  test("leaves unattributed failures without a Pi path unclassified", async () => {
    const { pi, classifier } = setup(answer);
    await pi.end("bash", true, "make: *** [all] Error 2");
    await settled();
    expect(classifier.calls).toStrictEqual([]);
  });

  test("counts failed and thrown classifier calls in /feedback", async () => {
    const { pi } = setup(() => "error");
    await pi.end("webfetch", true, "Request failed (500).");
    await settled();
    await pi.command("on");
    expect(pi.notifications.at(-1)?.message).toContain("1 classifier calls failed.");
  });

  test("counts a classifier that throws", async () => {
    const { pi } = setup(() => {
      throw new Error("boom");
    });

    await pi.end("webfetch", true, "Request failed (500).");
    await settled();
    await pi.command("on");
    expect(pi.notifications.at(-1)?.message).toContain("1 classifier calls failed.");
  });

  const vagueReport = {
    kind: "tool_error",
    component: "the search tool",
    summary: "Web search fails every time",
    expected: "A list of results",
    actual: "All search providers failed",
    impact: "slowed",
  } as const;

  test("moves a vague report to the package Jev names with confidence", async () => {
    const { pi, classifier } = setup(() => ({
      owner: { choice: "pi-web", probabilities: { "pi-web": 0.96, "pi-core": 0.04 } },
    }));

    await pi.call(vagueReport);
    const events = await settled();
    expect(events).toMatchObject([
      { type: "report", owner: "unattributed" },
      { type: "owner", owner: "pi-web", confidence: 0.96 },
    ]);
    expect(classifier.calls).toHaveLength(1);
    expect(deriveGroups(events).map((group) => group.owner)).toStrictEqual(["pi-web"]);
  });

  test("records a vague report as unattributed without a TypeSafe key", async () => {
    const { pi, classifier } = setup(answer, false);
    const result = await pi.call(vagueReport);
    expect(result.details).toMatchObject({ status: "recorded", owner: "unattributed" });
    const events = await settled();
    expect(events.map((event) => event.type)).toStrictEqual(["report"]);
    expect(classifier.calls).toStrictEqual([]);
  });

  test("returns before a slow classifier answers", async () => {
    const { pi, classifier } = setup(() => "hang");
    const result = await pi.call(vagueReport);
    expect(result.details).toMatchObject({ status: "recorded", owner: "unattributed" });
    await expect.poll(() => classifier.calls.length).toBe(1);
    expect(classifier.calls[0]?.signal.aborted).toBe(false);
  });
});
