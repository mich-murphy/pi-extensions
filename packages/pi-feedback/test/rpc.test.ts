import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FEEDBACK_NOTE_TYPE, FEEDBACK_TOOL } from "../feedback.ts";
import { JEV_MODEL, JEV_MODEL_ID } from "../jev.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import type { LedgerEvent } from "../ledger.ts";
import { deriveGroups } from "../queue.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const PI_PACKAGE = join(REPOSITORY, "node_modules/@earendil-works/pi-coding-agent");
const EXTENSION = join(REPOSITORY, "packages/pi-feedback/index.ts");
const FIXTURE = fileURLToPath(new URL("fixtures/scripted-model.ts", import.meta.url));
const TIMEOUT = 60_000;

const Manifest = Schema.Struct({ bin: Schema.Struct({ pi: Schema.String }) });

const ClassifierRequest = Schema.Struct({
  model: Schema.String,
  state: Schema.Unknown,
  questions: Schema.Record(Schema.String, Schema.Struct({ type: Schema.String })),
});

type ClassifierRequest = typeof ClassifierRequest.Type;

function cliPath(): string {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    readFileSync(join(PI_PACKAGE, "package.json"), "utf8"),
  );

  return join(PI_PACKAGE, manifest.bin.pi);
}

const SCORES = new Map(Object.entries({ harnessPath: 0.2, outsideService: 0.05, sameCause: 0.1 }));

const decodeAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }));

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  requests: Array<ClassifierRequest>,
): Promise<void> {
  const parsed = Schema.decodeUnknownSync(Schema.fromJsonString(ClassifierRequest))(
    await text(request),
  );

  requests.push(parsed);

  const answers = Object.fromEntries(
    Object.keys(parsed.questions).map((id) => [id, { type: "noul", noul: SCORES.get(id) ?? 0 }]),
  );

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ answers }));
}

function stubTypeSafe(requests: Array<ClassifierRequest>): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void answer(request, response, requests);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  return Option.getOrUndefined(decodeAddress(server.address()))?.port ?? 0;
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
  const requests: Array<ClassifierRequest> = [];
  const server = stubTypeSafe(requests);
  let root: string;
  let agentDir: string;
  let ledger: string;
  let scratch: string;
  let missingSession: string;
  let client: RpcClient;

  beforeAll(async () => {
    const port = await listen(server);
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-feedback-rpc-")));
    agentDir = join(root, "agent");
    scratch = join(root, "scratch", "batch");
    missingSession = join(agentDir, "sessions", "missing.jsonl");
    ledger = ledgerPath(agentDir);
    const cwd = join(root, "project");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(agentDir, "sessions"), { recursive: true });
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({ typesafe: { type: "api_key", key: "synthetic-not-a-secret" } }),
    );
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: { typesafe: { baseUrl: `http://127.0.0.1:${port}/v1/` } } }),
    );
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
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    "records, attributes and classifies a session's friction",
    async () => {
      await client.promptAndWait("Go", undefined, TIMEOUT);
      const events = await ledgerUntil(ledger, (read) => ofType(read, "verdict").length >= 1);

      expect(ofType(events, "signal")).toMatchObject([
        { tool: "read", owner: "unattributed", cause: "parallel-batch" },
        { tool: "read", owner: "unattributed", evidence: "pi-path", pathExisted: false },
      ]);
      expect(ofType(events, "report")).toMatchObject([
        { owner: "pi-claude", component: "pi-claude", kind: "workaround" },
      ]);
      const verdicts = ofType(events, "verdict");
      expect(verdicts.map((verdict) => verdict.model)).toStrictEqual([JEV_MODEL]);
      expect(verdicts).toMatchObject([
        { fingerprint: "pi-claude/workaround", harnessPath: 0.2, outsideService: 0.05 },
      ]);
      expect(ofType(events, "same_cause")).toStrictEqual([]);

      expect(requests.map((request) => request.model)).toStrictEqual([JEV_MODEL_ID]);
      expect(requests.flatMap((request) => Object.values(request.questions))).toMatchObject(
        Array.from({ length: 2 }, () => ({ type: "noul" })),
      );

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
