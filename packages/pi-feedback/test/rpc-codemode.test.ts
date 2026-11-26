import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ledgerPath, readLedger } from "../ledger.ts";
import type { LedgerEvent } from "../ledger.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const PI_PACKAGE = join(REPOSITORY, "node_modules/@earendil-works/pi-coding-agent");
const EXTENSION = join(REPOSITORY, "packages/pi-feedback/index.ts");
const FIXTURE = fileURLToPath(new URL("fixtures/scripted-model.ts", import.meta.url));
const TIMEOUT = 60_000;

const Manifest = Schema.Struct({ bin: Schema.Struct({ pi: Schema.String }) });

const ToolEvent = Schema.Struct({
  type: Schema.Literals(["tool_execution_start", "tool_execution_end"]),
  toolCallId: Schema.String,
  toolName: Schema.String,
  parentToolCallId: Schema.optionalKey(Schema.String),
  isError: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
});

type ToolEvent = typeof ToolEvent.Type;

const decodeToolEvent = Schema.decodeUnknownOption(ToolEvent);

function cliPath(): string {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    readFileSync(join(PI_PACKAGE, "package.json"), "utf8"),
  );

  return join(PI_PACKAGE, manifest.bin.pi);
}

const REPORT = {
  kind: "tool_error",
  component: "pi-feedback",
  summary: "Synthetic codemode report",
  expected: "A structured result",
  actual: "Nothing yet",
  impact: "slowed",
};

function scriptReading(missing: string, caught: boolean): string {
  const read = `await tools.read({ path: ${JSON.stringify(missing)} });`;

  return caught
    ? `try { ${read} } catch {}\nconst result = await tools.harness_feedback(${JSON.stringify(REPORT)});\nreturn JSON.stringify(result);`
    : read;
}

function textOf(event: ToolEvent | undefined): string {
  return (event?.result?.content ?? []).map((part) => part.text ?? "").join("\n");
}

const decodeOutput = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ status: Schema.String, group: Schema.String, owner: Schema.String }),
  ),
);

function structuredResult(event: ToolEvent | undefined) {
  return decodeOutput(/\{.*"status".*\}/u.exec(textOf(event))?.[0] ?? "{}");
}

function recorded(events: ReadonlyArray<LedgerEvent>) {
  return {
    signals: events.flatMap((event) => (event.type === "signal" ? [event.tool] : [])),
    reports: events.flatMap((event) => (event.type === "report" ? [event.component] : [])),
  };
}

function scriptEnds(events: ReadonlyArray<ToolEvent>): Array<ToolEvent> {
  return events.filter(
    (event) => event.type === "tool_execution_end" && event.toolName === "codemode",
  );
}

function sequence(events: ReadonlyArray<ToolEvent>): Array<string> {
  return events.map((event) => `${event.type}:${event.toolName}:${event.parentToolCallId ?? "-"}`);
}

describe("pi-feedback with codemode in a real Pi over RPC", () => {
  const seen: Array<ToolEvent> = [];
  let root: string;
  let ledger: string;
  let client: RpcClient;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-feedback-codemode-")));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const missing = join(cwd, "missing.txt");
    ledger = ledgerPath(agentDir);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const script = join(root, "script.json");

    writeFileSync(
      script,
      JSON.stringify([
        [{ name: "codemode", arguments: { code: scriptReading(missing, true) } }],
        [{ name: "codemode", arguments: { code: scriptReading(missing, false) } }],
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
        "-e",
        "builtin:codemode",
        "--tools",
        "+codemode",
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

    client.onEvent((event) => {
      const decoded = decodeToolEvent(event);

      if (decoded._tag === "Some") {
        seen.push(decoded.value);
      }
    });
  }, TIMEOUT);

  afterAll(async () => {
    await client.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test(
    "records each failed nested call once and gives the script a structured result",
    async () => {
      await client.promptAndWait("Go", undefined, TIMEOUT);
      const { events } = await readLedger(ledger);

      expect(recorded(events)).toStrictEqual({
        signals: ["read", "read"],
        reports: ["pi-feedback"],
      });

      const parents = scriptEnds(seen);
      expect(parents.map((event) => event.isError)).toStrictEqual([false, true]);
      expect(structuredResult(parents[0])).toMatchObject({
        status: "recorded",
        owner: "pi-feedback",
      });

      expect(sequence(seen)).toStrictEqual([
        "tool_execution_start:codemode:-",
        "tool_execution_start:read:call-0-0",
        "tool_execution_end:read:call-0-0",
        "tool_execution_start:harness_feedback:call-0-0",
        "tool_execution_end:harness_feedback:call-0-0",
        "tool_execution_end:codemode:-",
        "tool_execution_start:codemode:-",
        "tool_execution_start:read:call-1-0",
        "tool_execution_end:read:call-1-0",
        "tool_execution_end:codemode:-",
      ]);
    },
    TIMEOUT,
  );
});
