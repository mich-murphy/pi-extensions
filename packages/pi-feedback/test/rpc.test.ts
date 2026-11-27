import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FEEDBACK_NOTE_TYPE, FEEDBACK_TOOL } from "../feedback.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import type { LedgerEvent } from "../ledger.ts";
import { deriveGroups } from "../queue.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const PI_PACKAGE = join(REPOSITORY, "node_modules/@earendil-works/pi-coding-agent");
const EXTENSION = join(REPOSITORY, "packages/pi-feedback/index.ts");
const FIXTURE = fileURLToPath(new URL("fixtures/scripted-model.ts", import.meta.url));
const TIMEOUT = 60_000;

const Manifest = Schema.Struct({ bin: Schema.Struct({ pi: Schema.String }) });

function cliPath(): string {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    readFileSync(join(PI_PACKAGE, "package.json"), "utf8"),
  );

  return join(PI_PACKAGE, manifest.bin.pi);
}

async function ledgerUntil(
  file: string,
  done: (events: ReadonlyArray<LedgerEvent>) => boolean,
): Promise<ReadonlyArray<LedgerEvent>> {
  const deadline = Date.now() + TIMEOUT / 2;
  let events: ReadonlyArray<LedgerEvent> = [];

  while (Date.now() < deadline) {
    ({ events } = await readLedger(file));

    if (done(events)) {
      return events;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  return events;
}

function ofType<T extends LedgerEvent["type"]>(
  events: ReadonlyArray<LedgerEvent>,
  type: T,
): Array<Extract<LedgerEvent, { readonly type: T }>> {
  return events.filter(
    (event): event is Extract<LedgerEvent, { readonly type: T }> => event.type === type,
  );
}

describe("pi-feedback in a real Pi over RPC", () => {
  let root: string;
  let agentDir: string;
  let ledger: string;
  let scratch: string;
  let missingSession: string;
  let client: RpcClient;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-feedback-rpc-")));
    agentDir = join(root, "agent");
    scratch = join(root, "scratch", "batch");
    missingSession = join(agentDir, "sessions", "missing.jsonl");
    ledger = ledgerPath(agentDir);
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    const script = join(root, "script.json");
    writeFileSync(
      script,
      JSON.stringify([
        [
          {
            name: "bash",
            arguments: { command: `sleep 1; mkdir -p ${scratch}; touch ${scratch}/a.png` },
          },
          { name: "read", arguments: { path: `${scratch}/a.png` } },
        ],
        [
          {
            name: FEEDBACK_TOOL,
            arguments: {
              kind: "workaround",
              component: "pi-claude",
              summary: "Scratch path changed between turns",
              expected: "One scratch path per session",
              actual: "ENOENT on a path from an earlier turn",
              impact: "slowed",
            },
          },
        ],
        [{ name: "read", arguments: { path: missingSession } }],
        [],
        [{ name: "read", arguments: { path: missingSession } }],
        [],
      ]),
    );
    client = new RpcClient({
      cliPath: cliPath(),
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_FEEDBACK_SCRIPT: script },
      args: [
        "--no-extensions",
        "-e",
        EXTENSION,
        "-e",
        FIXTURE,
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--no-approve",
        "--offline",
        "--no-session",
        "--model",
        "feedback-e2e/scripted",
      ],
    });
    await client.start();
  }, TIMEOUT);

  afterAll(async () => {
    await client.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    "records and attributes a session's friction",
    async () => {
      await client.promptAndWait("Go", undefined, TIMEOUT);
      const events = await ledgerUntil(ledger, (read) => ofType(read, "signal").length >= 2);

      expect(ofType(events, "signal")).toMatchObject([
        { tool: "read", owner: "unattributed", cause: "parallel-batch" },
        { tool: "read", owner: "unattributed", evidence: "pi-path", pathExisted: false },
      ]);
      expect(ofType(events, "report")).toMatchObject([
        { owner: "pi-claude", component: "pi-claude", kind: "workaround" },
      ]);
      const { entries } = await client.getEntries();
      expect(JSON.stringify(entries)).toContain(FEEDBACK_NOTE_TYPE);

      const groups = deriveGroups(events);
      expect(groups.filter((group) => group.excluded > 0)).toMatchObject([
        { owner: "unattributed", records: 1, excluded: 1, sessions: 1 },
      ]);
      expect(groups.filter((group) => group.piCore)).toStrictEqual([]);
      expect(groups.filter((group) => group.ready)).toStrictEqual([]);
    },
    TIMEOUT,
  );

  test(
    "/feedback off stops recording",
    async () => {
      const before = await readLedger(ledger);
      await client.prompt("/feedback off");
      await client.promptAndWait("Again", undefined, TIMEOUT);
      const after = await readLedger(ledger);
      expect(after.events).toHaveLength(before.events.length);
    },
    TIMEOUT,
  );
});
