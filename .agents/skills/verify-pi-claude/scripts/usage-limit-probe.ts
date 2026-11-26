/* oxlint-disable no-await-in-loop -- sequential session turns */
/* oxlint-disable typescript/no-misused-promises -- deliberately rejecting listener verifies real Pi event-bus isolation */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AbortError, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type registerClaudeProvider from "../../../../packages/pi-claude/index";
import { USAGE_LIMIT_CHANNEL } from "../../../../packages/shared/usage-limit";

const { values } = parseArgs({
  options: { package: { type: "string" }, work: { type: "string" } },
});

assert(values.package !== undefined && values.work !== undefined);

const work = path.resolve(values.work);

assert(/^\/(?:private\/)?tmp\/pi-claude-state-/u.test(work));

assert.equal(process.env.HOME, path.join(work, "home"));

assert.equal(process.env.PI_OFFLINE, "1");

const agentDir = process.env.PI_CODING_AGENT_DIR;

assert(agentDir !== undefined);

const seconds = 1_792_548_000;

type FixtureRateLimit = string | { status: string; resetsAt?: number | string };

const rate = (info: FixtureRateLimit) => ({ type: "rate_limit_event", rate_limit_info: info });
const rejected = rate({ status: "rejected", resetsAt: seconds });

const result = (fields = {}) => ({
  type: "result",
  is_error: false,
  stop_reason: "end_turn",
  ...fields,
});

const limit = result({ is_error: true, terminal_reason: "blocking_limit" });

const cases = [
  { name: "rejected-seconds", messages: [rejected, limit], notice: seconds * 1000 },
  { name: "no-reset-next-turn", messages: [limit] },
  {
    name: "api-rate-limit",
    messages: [
      rejected,
      { type: "assistant", message: { usage: {} }, error: "rate_limit" },
      result({ is_error: true }),
    ],
    notice: seconds * 1000,
  },
  { name: "success", messages: [rejected, result()], success: true },
  {
    name: "non-limit",
    messages: [rejected, result({ is_error: true, terminal_reason: "prompt_too_long" })],
  },
  {
    name: "authentication-override",
    messages: [
      rejected,
      { type: "assistant", message: { usage: {} }, error: "authentication_failed" },
      limit,
    ],
  },
  { name: "warning", messages: [rate({ status: "allowed_warning", resetsAt: seconds }), limit] },
  { name: "allowed", messages: [rate({ status: "allowed", resetsAt: seconds }), limit] },
  { name: "missing-reset", messages: [rate({ status: "rejected" }), limit] },
  { name: "malformed", messages: [rate("invalid"), limit] },
  ...[0, -1, Number.NaN, Infinity, "1792548000", 8_640_000_000_001].map((resetsAt, i) => ({
    name: `invalid-reset-${i}`,
    messages: [rate({ status: "rejected", resetsAt }), limit],
  })),
  {
    name: "latest-rejection",
    messages: [rejected, rate({ status: "rejected", resetsAt: seconds + 1 }), limit],
    notice: (seconds + 1) * 1000,
  },
  ...[
    rate({ status: "allowed_warning", resetsAt: seconds }),
    rate({ status: "allowed", resetsAt: seconds }),
    rate({ status: "unknown", resetsAt: seconds }),
    rate("invalid"),
  ].map((update, i) => ({
    name: `superseding-update-clears-${i}`,
    messages: [rejected, update, limit],
  })),
  { name: "missing-rejection-clears", messages: [rejected, rate({ status: "rejected" }), limit] },
  {
    name: "invalid-rejection-clears",
    messages: [rejected, rate({ status: "rejected", resetsAt: -1 }), limit],
  },
  { name: "throwing-listener", messages: [rejected, limit], notice: seconds * 1000 },
  { name: "rejecting-listener", messages: [rejected, limit], notice: seconds * 1000 },
];

let current: (typeof cases)[number] | undefined;
let queries = 0;

globalThis.piUsageLimitBoundary = {
  sdk: { AbortError, createSdkMcpServer, tool },
  async *query() {
    assert(current, "unexpected query (metadata/background request)");
    queries++;
    yield* current.messages;
  },
};

const jiti = createJiti(import.meta.url, {
  alias: {
    "@anthropic-ai/claude-agent-sdk": fileURLToPath(
      new URL("./usage-limit-sdk-boundary.ts", import.meta.url),
    ),
  },
  moduleCache: false,
});

const production = await jiti.import<{ default: typeof registerClaudeProvider }>(
  path.join(values.package, "index.ts"),
);

const settings = SettingsManager.inMemory({
  retry: { enabled: false },
  compaction: { enabled: false },
  cacheWarming: "off",
});

let notices: Array<unknown> = [];
let order: Array<string> = [];
let isolatedErrors = 0;
const unexpectedErrors: Array<unknown> = [];

const loader = new DefaultResourceLoader({
  cwd: work,
  agentDir,
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: [
    production.default,
    (pi) => {
      pi.events.on(USAGE_LIMIT_CHANNEL, () => {
        if (current?.name === "throwing-listener") {
          throw new Error("offline-observer-sentinel");
        }
      });
      pi.events.on(USAGE_LIMIT_CHANNEL, async () => {
        if (current?.name === "rejecting-listener") {
          throw new Error("offline-observer-sentinel");
        }
      });
    },
    (pi) => {
      pi.events.on(USAGE_LIMIT_CHANNEL, (data) => {
        notices.push(data);
        order.push("notice");
      });
      pi.on("message_end", (event) => {
        if (event.message.role === "assistant") {
          order.push(`assistant-${event.message.stopReason}`);
        }
      });
    },
  ],
});

const reports: Array<unknown> = [];
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(work, "auth.json"),
    modelsPath: path.join(work, "models.json"),
  });

  ({ session } = await createAgentSession({
    cwd: work,
    agentDir,
    resourceLoader: loader,
    modelRuntime,
    settingsManager: settings,
    noTools: "all",
    sessionManager: SessionManager.inMemory(work),
    thinkingLevel: "off",
  }));
  session.extensionRunner.onError((error) => {
    if (
      error.event === `events:${USAGE_LIMIT_CHANNEL}` &&
      error.error === "offline-observer-sentinel"
    ) {
      isolatedErrors++;
    } else {
      unexpectedErrors.push(error);
    }
  });
  const available = await modelRuntime.getAvailable();
  const model = available.find((m) => m.provider === "claude");
  assert(model, "production extension provider not available");
  await session.setModel(model);

  for (const entry of cases) {
    current = entry;
    notices = [];
    order = [];
    const before = queries;
    await session.prompt("OFFLINE usage-limit fixture; no provider request.");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.equal(queries - before, 1, entry.name);
    assert.deepEqual(
      notices,
      entry.notice === undefined ? [] : [{ provider: "claude", resetsAt: entry.notice }],
      entry.name,
    );
    const expected = entry.success === true ? "assistant-stop" : "assistant-error";
    assert.deepEqual(
      order,
      entry.notice === undefined ? [expected] : ["notice", expected],
      entry.name,
    );
    reports.push({ case: entry.name, status: "passed", notices, order, queries: queries - before });
  }

  assert.deepEqual(unexpectedErrors, []);
  assert.equal(isolatedErrors, 2);
  process.stdout.write(
    `${JSON.stringify({ status: "passed", proof: "OFFLINE synthetic SDK messages; real production registration/parser/runner/bridge and pinned Pi session/event bus", queries, isolatedErrors, reports }, null, 2)}\n`,
  );
} finally {
  session?.dispose();
  globalThis.piUsageLimitBoundary = undefined;
}
