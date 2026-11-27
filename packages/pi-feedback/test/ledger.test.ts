import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendEvent, FIELD_LIMIT, ledgerPath, parseLedger, readLedger } from "../ledger.ts";
import type { EventDraft } from "../ledger.ts";
import { REDACTED } from "../redact.ts";
import { fakeClock, signal } from "./events.ts";

const draft: EventDraft = {
  type: "signal",
  session: "session-a",
  owner: "pi-claude",
  fingerprint: "read: ENOENT",
  tool: "read",
  error: "ENOENT: no such file",
};

describe("ledger", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-feedback-ledger-"));
    file = ledgerPath(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("lives under the agent directory", () => {
    expect(ledgerPath("/agent")).toBe("/agent/harness-feedback/ledger.jsonl");
  });

  test("appends one stamped line per event", async () => {
    const clock = fakeClock();
    const first = await appendEvent(file, draft, clock);
    const second = await appendEvent(file, { ...draft, session: "session-b" }, clock);
    expect(parseLedger(readFileSync(file, "utf8"))).toStrictEqual({
      events: [first, second],
      skipped: 0,
    });
    expect(first.id).not.toBe(second.id);
  });

  test("keeps the ledger private", async () => {
    await appendEvent(file, draft, fakeClock());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  });

  test("redacts and clips text before writing", async () => {
    const secret = `sk-ant-${"a".repeat(32)}`;

    const event = await appendEvent(
      file,
      { ...draft, error: `${secret} ${"x".repeat(FIELD_LIMIT * 2)}` },
      fakeClock(),
    );

    const written = readFileSync(file, "utf8");
    expect(written).not.toContain(secret);
    expect(written).toContain(REDACTED);
    expect(parseLedger(written).events).toStrictEqual([event]);
    expect(event).toHaveProperty(
      "error",
      expect.stringMatching(new RegExp(`^.{${FIELD_LIMIT}}$`, "su")),
    );
  });

  test("rejects an event the schema refuses and writes nothing", async () => {
    await expect(appendEvent(file, { ...draft, owner: "Pi Core" }, fakeClock())).rejects.toThrow(
      TypeError,
    );
    await expect(readLedger(file)).resolves.toStrictEqual({ events: [], skipped: 0 });
  });

  test("reads a missing ledger as empty", async () => {
    await expect(readLedger(join(root, "absent.jsonl"))).resolves.toStrictEqual({
      events: [],
      skipped: 0,
    });
  });

  test("skips lines it cannot read and counts them", () => {
    const good = signal({ n: 1, session: "s" });

    const text = ["{not json", JSON.stringify(good), "", JSON.stringify({ type: "other" })].join(
      "\n",
    );

    expect(parseLedger(text)).toStrictEqual({ events: [good], skipped: 2 });
  });

  test("reads a verdict written with the old path-existed score", () => {
    const old = {
      type: "verdict",
      id: "00000000-0000-4000-8000-000000000001",
      at: "2026-11-25T00:00:00.000Z",
      fingerprint: "bash: ls",
      model: "typesafe/jev-1.14.0",
      harnessPath: 0.9,
      pathExisted: 0.9,
      outsideService: 0.02,
    };

    expect(parseLedger(JSON.stringify(old))).toStrictEqual({
      events: [
        {
          type: "verdict",
          id: old.id,
          at: old.at,
          fingerprint: old.fingerprint,
          model: old.model,
          harnessPath: 0.9,
          outsideService: 0.02,
        },
      ],
      skipped: 0,
    });
  });

  test("skips JSON lines that are not ledger events", () => {
    const good = signal({ n: 1, session: "s" });
    const text = ["null", "[1]", '"text"', "{}", JSON.stringify(good)].join("\n");
    expect(parseLedger(text)).toStrictEqual({ events: [good], skipped: 4 });
  });

  test("keeps line and paragraph separators inside strings", async () => {
    await appendEvent(file, { ...draft, error: "a b c" }, fakeClock());
    const { events } = await readLedger(file);
    expect(events[0]).toMatchObject({ error: "a b c" });
  });

  test("reports other read failures", async () => {
    writeFileSync(join(root, "dir-marker"), "");
    await expect(readLedger(root)).rejects.toThrow(/EISDIR/u);
  });
});
