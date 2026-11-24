import { describe, expect, test } from "vitest";
import { MessageAliases } from "../adapter/aliases.js";
import { Handles, sessionHandle, TakenIndex } from "../adapter/handles.js";
import { UnsureSends } from "../adapter/retries.js";
import { registerTools } from "../adapter/tools.js";
import { defaults } from "../state/shared.js";

const self = { machineId: "alpha", sessionId: "me", runtimeNonce: "a".repeat(32) };
const beta = { machineId: "beta", sessionId: "them", runtimeNonce: "b".repeat(32) };
const restarted = { ...beta, runtimeNonce: "c".repeat(32) };
type Incoming = {
  from: typeof beta;
  to: typeof self;
  scopeId: string;
  message: Record<string, unknown> & { id: string };
};
type Sent = { to: unknown; scopeId: string; message: Record<string, unknown> };
type Result = {
  content: { text: string }[];
  details: { value: Record<string, unknown> };
  structuredContent?: unknown;
  isError?: boolean;
};

function fixture(initial: { peer: typeof beta; label: string }[], maxWaitSeconds?: number) {
  let roster = initial.map((entry) => ({ ...entry, scopeIds: ["team"] }));
  const waits: number[] = [];
  let waited = "timed_out";
  let clock = 0;
  const outcomes: string[] = [];
  const sent: Sent[] = [];
  const inbox: Incoming[] = [];
  const taken = new TakenIndex();
  const session = {
    peer: self,
    config: {
      machineId: "alpha",
      scopeIds: ["team"],
      policies: [{ machineId: "beta", scopeId: "team", permissions: ["discover", "push"] }],
      ...(maxWaitSeconds === undefined ? {} : { maxWaitSeconds }),
    },
    waitForMessage: async (seconds: number) => {
      waits.push(seconds);
      return waited;
    },
    handles: new Handles(),
    taken,
    unsure: new UnsureSends(() => clock),
    aliases: new MessageAliases(),
    client: {
      isClosed: () => false,
      recoverForTool: async () => undefined,
      effectiveScopes: () => new Set(["team"]),
      discover: async () => ({
        forOp: "discover",
        outcome: { tag: "ok", value: { peers: roster, watching: false } },
      }),
    },
    send: async (to: unknown, scopeId: string, message: Record<string, unknown>) => {
      sent.push({ to, scopeId, message });
      const tag = outcomes.shift() ?? "admitted";
      return tag === "admitted"
        ? { tag, binding: {}, correlation: "none" }
        : { tag, binding: {}, code: "unavailable" };
    },
    take: () => {
      const messages = inbox.splice(0);
      for (const delivery of messages) {
        taken.record(delivery.message.id, { peer: delivery.from, scopeId: delivery.scopeId });
      }
      return { messages };
    },
  };
  const tools = new Map<string, (args: unknown) => Promise<Result>>();
  Reflect.apply(registerTools, undefined, [
    {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<Result> }) => {
        tools.set(tool.name, async (args) => tool.execute("id", args, undefined));
      },
    },
    () => session,
  ]);
  const call = async (name: string, args: unknown = {}): Promise<Result> => {
    const tool = tools.get(name);
    if (tool === undefined) {
      throw new Error(name);
    }
    return tool(args);
  };
  return {
    call,
    sent,
    inbox,
    waits,
    outcomes,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    setWaited: (next: string) => {
      waited = next;
    },
    setRoster: (next: { peer: typeof beta; label: string }[]) => {
      roster = next.map((entry) => ({ ...entry, scopeIds: ["team"] }));
    },
  };
}
async function listedFixture() {
  const fx = fixture([{ peer: beta, label: "Beta" }]);
  await fx.call("peers_list");
  return fx;
}
function textOf(result: Result): string {
  return result.content[0]?.text ?? "";
}
const handle = sessionHandle("beta", "them");
const mine = sessionHandle("alpha", "me");

describe("peers_list", () => {
  test("self is decided by PeerRef, never by a label that claims it", async () => {
    const fx = fixture([
      { peer: self, label: "Pi · repo" },
      { peer: beta, label: "Pi (you)" },
    ]);
    const result = await fx.call("peers_list");
    expect(result.structuredContent).toStrictEqual({
      ok: true,
      peers: [
        { handle: mine, label: "Pi · repo", self: true, restarted: false },
        { handle, label: "Pi (you)", self: false, restarted: false },
      ],
    });
    expect(result.content[0]?.text).toBe(`${mine} (you) · Pi · repo\n${handle} · Pi (you)`);
  });
  test("a restarted session is marked in prose and structured output", async () => {
    const fx = fixture([{ peer: beta, label: "Pi" }]);
    await fx.call("peers_list");
    fx.setRoster([{ peer: restarted, label: "Pi" }]);
    const result = await fx.call("peers_list");
    expect(result.structuredContent).toMatchObject({ peers: [{ handle, restarted: true }] });
    expect(result.content[0]?.text).toBe(
      `${handle} (restarted: unread inbox and receipts reset) · Pi`,
    );
  });
  test("an empty listing says so", async () => {
    const empty = await fixture([]).call("peers_list");
    expect(textOf(empty)).toBe("No other sessions are listed.");
  });
});

describe("peers_send", () => {
  test("binds the exact runtime last listed for the handle, with the listed scope", async () => {
    const fx = fixture([{ peer: beta, label: "Pi" }]);
    await fx.call("peers_list");
    fx.setRoster([{ peer: restarted, label: "Pi" }]);
    const result = await fx.call("peers_send", { to: handle, kind: "update", content: "hi" });
    expect(fx.sent[0]).toMatchObject({
      to: beta,
      scopeId: "team",
      message: { format: "markdown" },
    });
    expect(result.content[0]?.text).toMatch(
      new RegExp(
        String.raw`^Delivered to their inbox; not yet read, accepted or done\.\nid m-[0-9a-f]{4}$`,
        "u",
      ),
    );
    await fx.call("peers_list");
    await fx.call("peers_send", { to: handle, kind: "update", content: "again" });
    expect(fx.sent[1]?.to).toStrictEqual(restarted);
  });
  test("an unknown handle is an error that points at peers_list", async () => {
    const result = await fixture([]).call("peers_send", {
      to: "s-ffff",
      kind: "update",
      content: "x",
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "Unknown handle; call peers_list." }],
    });
  });
  test.each([
    [{ kind: "reply" }, "A reply needs replyTo"],
    [{ kind: "request", status: "completed" }, "A request cannot carry a status"],
  ])("wire rules are checked before sending: %j", async (extra, note) => {
    const fx = fixture([{ peer: beta, label: "Pi" }]);
    await fx.call("peers_list");
    const result = await fx.call("peers_send", { to: handle, content: "x", ...extra });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(note);
    expect(fx.sent).toHaveLength(0);
  });
  test("limits dropped from the schema are still enforced in code", async () => {
    const fx = await listedFixture();
    const large = await fx.call("peers_send", {
      to: handle,
      kind: "update",
      content: "é".repeat(12_289),
    });
    expect(large).toMatchObject({
      isError: true,
      details: { value: { code: "delivery_too_large" } },
    });
    const scoped = await fx.call("peers_send", {
      to: handle,
      kind: "update",
      content: "x",
      scope: "bad scope",
    });
    expect(scoped).toMatchObject({ isError: true, details: { value: { code: "invalid_input" } } });
    expect(fx.sent).toHaveLength(0);
  });
  test("replyTo accepts the short id shown by peers_take", async () => {
    const fx = await listedFixture();
    fx.inbox.push({
      from: beta,
      to: self,
      scopeId: "team",
      message: { id: "5a5a".padEnd(32, "0"), kind: "request", content: "q", format: "text" },
    });
    expect(textOf(await fx.call("peers_take"))).toContain("id m-5a5a");
    await fx.call("peers_send", { to: handle, kind: "reply", content: "a", replyTo: "m-5a5a" });
    expect(fx.sent[0]?.message.replyTo).toStrictEqual({
      sender: beta,
      messageId: "5a5a".padEnd(32, "0"),
    });
  });
  test("replyTo resolves sender and scope from taken messages; unknown ids are refused", async () => {
    const fx = fixture([{ peer: beta, label: "Pi" }]);
    await fx.call("peers_list");
    const unknown = await fx.call("peers_send", {
      to: handle,
      kind: "reply",
      content: "x",
      replyTo: "d".repeat(32),
    });
    expect(unknown.content[0]?.text).toBe(
      "replyTo does not match a message you took; check its id.",
    );
    fx.inbox.push({
      from: beta,
      to: self,
      scopeId: "team",
      message: { id: "e".repeat(32), kind: "request", content: "do it", format: "text" },
    });
    await fx.call("peers_take");
    await fx.call("peers_send", {
      to: handle,
      kind: "reply",
      content: "done",
      replyTo: "e".repeat(32),
    });
    expect(fx.sent[0]?.message.replyTo).toStrictEqual({ sender: beta, messageId: "e".repeat(32) });
    fx.setRoster([{ peer: restarted, label: "Pi" }]);
    await fx.call("peers_list");
    const stale = await fx.call("peers_send", {
      to: handle,
      kind: "reply",
      content: "late",
      replyTo: "e".repeat(32),
    });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]?.text).toContain("has restarted");
    expect(fx.sent).toHaveLength(1);
  });
});

describe("peers_take", () => {
  test("prose has a header per message and assigns handles to unlisted senders", async () => {
    const fx = fixture([]);
    const empty = await fx.call("peers_take");
    expect(empty.content[0]?.text).toBe("No messages.");
    fx.inbox.push(
      {
        from: beta,
        to: self,
        scopeId: "team",
        message: { id: "1".repeat(32), kind: "request", content: "first", format: "text" },
      },
      {
        from: beta,
        to: self,
        scopeId: "team",
        message: {
          id: "2".repeat(32),
          kind: "reply",
          content: "second",
          format: "text",
          status: "completed",
          replyTo: { sender: self, messageId: "3".repeat(32) },
        },
      },
    );
    const result = await fx.call("peers_take");
    expect(result.content[0]?.text).toBe(
      [
        `from ${handle} · request · id m-1111`,
        "first",
        "",
        `from ${handle} · reply · id m-2222 · reply to m-3333 · status completed`,
        "second",
      ].join("\n"),
    );
    const sent = await fx.call("peers_send", { to: handle, kind: "update", content: "ok" });
    expect(sent.isError).toBeUndefined();
    expect(fx.sent[0]?.to).toStrictEqual(beta);
  });
});
describe("peers_take waitSeconds", () => {
  test("waits only when asked, capped by maxWaitSeconds, and says how long it waited", async () => {
    const fx = fixture([], 60);
    await expect(fx.call("peers_take")).resolves.toMatchObject({
      content: [{ text: "No messages." }],
    });
    expect(fx.waits).toStrictEqual([]);
    const result = await fx.call("peers_take", { waitSeconds: 300 });
    expect(fx.waits).toStrictEqual([60]);
    expect(textOf(result)).toBe("No messages arrived within 60 seconds.");
    expect(result.isError).toBeUndefined();
  });
  test.each([
    ["busy", "overloaded", /already waiting/u],
    ["disconnected", "unavailable", /no message can arrive/u],
    ["cancelled", "cancelled", /cancelled/u],
  ])("a %s wait is an error with its own note", async (waited, code, note) => {
    const fx = fixture([]);
    fx.setWaited(waited);
    const result = await fx.call("peers_take", { waitSeconds: 30 });
    expect(result.isError).toBe(true);
    expect(result.details.value).toMatchObject({ code });
    expect(textOf(result)).toMatch(note);
  });
  test("a wait that ends with a message returns it", async () => {
    const fx = fixture([]);
    fx.setWaited("message");
    fx.inbox.push({
      from: beta,
      to: self,
      scopeId: "team",
      message: { id: "1".repeat(32), kind: "update", content: "done", format: "text" },
    });
    const result = await fx.call("peers_take", { waitSeconds: 30 });
    expect(textOf(result)).toBe(`from ${handle} · update · id m-1111\ndone`);
  });
});
describe("peers_send retryOf", () => {
  const args = { to: handle, kind: "update", content: "hello" };
  test("resends an unsure message with the same id and bytes to the same runtime", async () => {
    const fx = await listedFixture();
    fx.outcomes.push("unknown");
    const first = await fx.call("peers_send", args);
    expect(textOf(first)).toMatch(/retryOf/u);
    const original = fx.sent[0];
    const retried = await fx.call("peers_send", { ...args, retryOf: original?.message.id });
    expect(retried.isError).toBeUndefined();
    expect(fx.sent).toHaveLength(2);
    expect(fx.sent[1]).toStrictEqual(original);
    expect(textOf(first)).toMatch(/\nid m-[0-9a-f]{4}$/u);
    const again = await fx.call("peers_send", { ...args, retryOf: original?.message.id });
    expect(again.isError).toBe(true);
    expect(fx.sent).toHaveLength(2);
  });
  test("retryOf accepts the short id from the send result", async () => {
    const fx = await listedFixture();
    fx.outcomes.push("unknown");
    const first = await fx.call("peers_send", args);
    const short = /id (?<alias>m-[0-9a-f]+)$/u.exec(textOf(first))?.groups?.alias;
    const retried = await fx.call("peers_send", { ...args, retryOf: short });
    expect(retried.isError).toBeUndefined();
    expect(fx.sent[1]).toStrictEqual(fx.sent[0]);
  });
  test("an unsure retry can be retried again, and a changed message is refused", async () => {
    const fx = await listedFixture();
    fx.outcomes.push("unknown", "unknown");
    await fx.call("peers_send", args);
    const id = fx.sent[0]?.message.id;
    await fx.call("peers_send", { ...args, retryOf: id });
    const changed = await fx.call("peers_send", { ...args, content: "other", retryOf: id });
    expect(changed.isError).toBe(true);
    expect(textOf(changed)).toMatch(/unchanged/u);
    await fx.call("peers_send", { ...args, retryOf: id });
    expect(fx.sent).toHaveLength(3);
  });
  test("refuses ids that were delivered, never sent, or are past the window", async () => {
    const fx = await listedFixture();
    await fx.call("peers_send", args);
    const delivered = await fx.call("peers_send", { ...args, retryOf: fx.sent[0]?.message.id });
    expect(delivered.isError).toBe(true);
    const unseen = await fx.call("peers_send", { ...args, retryOf: "f".repeat(32) });
    expect(textOf(unseen)).toMatch(/Nothing was sent/u);
    fx.outcomes.push("unknown");
    await fx.call("peers_send", args);
    fx.advance(defaults.receiptTtlMs);
    const late = await fx.call("peers_send", { ...args, retryOf: fx.sent[1]?.message.id });
    expect(late.isError).toBe(true);
    expect(textOf(late)).toMatch(/Nothing was sent/u);
    expect(fx.sent).toHaveLength(2);
  });
});
