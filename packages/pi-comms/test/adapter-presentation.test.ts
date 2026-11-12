import assert from "node:assert/strict";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { attentionStatus, diagnostics, toolPresentation } from "../adapter/presentation.js";
import { registerTools } from "../adapter/tools.js";
import { createState } from "../state/core.js";

const peer = {
  machineId: "alpha",
  sessionId: "019a1234-5678-7abc-8def-0123456789ab",
  runtimeNonce: "a".repeat(32),
};
const other = {
  machineId: "beta",
  sessionId: "019a1234-5678-7abc-8def-fedcba987654",
  runtimeNonce: "b".repeat(32),
};
const message = {
  id: "c".repeat(32),
  kind: "request" as const,
  content: "Please review this change",
  format: "text" as const,
};
const binding = { messageId: message.id, sender: peer, recipient: other, scopeId: "team" };
const admitted = { tag: "admitted", binding, correlation: "none" };
const denied = { tag: "not_admitted", binding, code: "forbidden" };
const unknown = { tag: "unknown", binding, code: "unavailable" };
const record = {
  category: "work" as const,
  title: "Review",
  summary: "Review is in progress",
  format: "text" as const,
  preparation: "authored" as const,
  status: "in_progress" as const,
  work: { kind: "request" as const, origin: peer, requestId: message.id },
};
const state = createState({
  peer,
  scopeIds: ["team"],
  clock: () => 0,
  authorize: () => true,
  offer: () => true,
});
const published = state.publish({ scopeId: "team", key: "review", record });
assert.equal(published.tag, "ok");
const publication = published.tag === "ok" ? published.value : undefined;
const theme = { fg: (_token: string, value: string) => value };
function result(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: { value } };
}
function render(
  name: string,
  slot: "call" | "result",
  args: unknown,
  payload: unknown,
  expanded = false,
  width = 100,
  extra: Record<string, unknown> = {},
): string[] {
  const renderer = toolPresentation(name);
  const context = {
    args,
    state: {},
    argsComplete: true,
    expanded,
    isError: false,
    keyHint: (_key: string, description: string) => `ctrl+o ${description}`,
    ...extra,
  };
  const fn = slot === "call" ? renderer.renderCall : renderer.renderResult;
  assert(typeof fn === "function");
  const component: unknown = Reflect.apply(
    fn,
    undefined,
    slot === "call"
      ? [args, theme, context]
      : [payload, { expanded, isPartial: extra.isPartial === true }, theme, context],
  );
  assert(component instanceof Text);
  return component.render(width);
}
function stripStyle(value: string): string {
  return value.replaceAll(new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "gu"), "");
}
function compact(lines: string[]): string {
  return stripStyle(lines.join("")).replaceAll(/\s+/gu, "");
}
const cases = [
  {
    name: "session_peers",
    args: { watch: true },
    value: { peers: [{ peer: other, label: "Reviewer", scopeIds: ["team"] }], revision: 1 },
    call: "Discover peers · watch",
    summary: "1 peer",
  },
  {
    name: "session_send",
    args: { to: other, scopeId: "team", message },
    value: { outcome: admitted, note: "Admission is not model reading" },
    call: "→ beta/…ba987654@bbbbbb · request · Please review",
    summary: "Added to peer inbox",
  },
  {
    name: "session_take",
    args: { limit: 4 },
    value: {
      messages: [
        {
          provenance: {
            sender: peer,
            recipient: other,
            scopeId: "team",
            messageId: message.id,
            correlation: "none",
          },
          message,
        },
      ],
      note: "No work completion claim",
    },
    call: "← inbox",
    summary: "← alpha/…456789ab@aaaaaa · request · Please review",
  },
  {
    name: "session_state",
    args: { action: "put", scopeId: "team", key: "review", record },
    value: published,
    call: "Publish",
    summary: "Published · review r1 · in_progress · Review",
  },
  {
    name: "session_state",
    args: { action: "get", publisher: peer, scopeId: "team", key: "review" },
    value: state.read({ caller: other, scopeId: "team", key: "review" }),
    call: "get",
    summary: "Review is in progress",
  },
  {
    name: "session_state",
    args: { action: "list", publisher: peer, scopeId: "team" },
    value: state.list({ caller: other, scopeId: "team" }),
    call: "list",
    summary: "1 publication",
  },
  {
    name: "session_state",
    args: { action: "remove", scopeId: "team", key: "absent" },
    value: state.remove({ scopeId: "team", key: "absent" }),
    call: "remove",
    summary: "No publication removed",
  },
  {
    name: "session_interest",
    args: { action: "add", publisher: peer, scopeId: "team", work: record.work },
    value: state.interest.add({ subscriber: other, scopeId: "team", work: record.work }),
    call: "add interest",
    summary: "Interest active",
  },
  {
    name: "session_interest",
    args: { action: "remove", publisher: peer, scopeId: "team", work: record.work },
    value: state.interest.remove({ subscriber: other, scopeId: "team", work: record.work }),
    call: "remove interest",
    summary: "Interest inactive",
  },
  {
    name: "session_report",
    args: { scopeId: "team", key: "review", record, notify: "selected", recipients: [other] },
    value: { tag: "ok", value: { publication, pushes: [{ recipient: other, outcome: admitted }] } },
    call: "Publish report",
    summary: "1 push: 1 added to peer inbox",
  },
];

const takeCall = (args: unknown) => render("session_take", "call", args, undefined);

describe("presentation-only session tool rendering", () => {
  test.each(cases)(
    "$name $call: compact and expanded actual result shapes remain immutable",
    (entry) => {
      const payload = result(entry.value);
      const before = JSON.stringify({ args: entry.args, payload });
      const call = render(entry.name, "call", entry.args, payload).join("\n");
      const collapsed = render(entry.name, "result", entry.args, payload).join("\n");
      expect(call).toContain(entry.call);
      expect(collapsed).toContain(entry.summary);
      expect(call + collapsed).not.toContain(peer.runtimeNonce);
      expect(call + collapsed).not.toContain(other.sessionId);
      expect(collapsed).not.toContain("ctrl+o for details");
      const expandedCall = render(entry.name, "call", entry.args, payload, true).join("\n");
      const expanded = render(entry.name, "result", entry.args, payload, true).join("\n");
      expect(expandedCall).toContain('"');
      expect(expanded).not.toContain('"details"');
      expect(compact([expanded])).toContain(JSON.stringify(entry.value).replaceAll(/\s+/gu, ""));
      expect(JSON.stringify({ args: entry.args, payload })).toBe(before);
    },
  );
  test.each(cases)(
    "$name started calls do not retain a preparing label when argsComplete remains false",
    (entry) => {
      expect(
        render(entry.name, "call", entry.args, undefined, false, 100, {
          argsComplete: false,
          executionStarted: true,
        }).join("\n"),
      ).not.toContain("preparing");
    },
  );
  test.each(cases)(
    "$name restored completed calls make no phase claim when public activity flags are absent",
    (entry) => {
      const output = render(entry.name, "call", entry.args, result(entry.value), false, 100, {
        argsComplete: false,
        executionStarted: false,
        isPartial: false,
      }).join("\n");
      expect(output).toContain(entry.call);
      expect(output).not.toContain("preparing");
    },
  );
  test("all six public registrations hook up both renderers without changing unavailable model output", async () => {
    const tools: {
      name: string;
      renderCall?: unknown;
      renderResult?: unknown;
      execute: (...args: unknown[]) => Promise<unknown>;
    }[] = [];
    Reflect.apply(registerTools, undefined, [
      { registerTool: (tool: (typeof tools)[number]) => tools.push(tool) },
      () => undefined,
    ]);
    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(typeof tool.renderCall).toBe("function");
      expect(typeof tool.renderResult).toBe("function");
      const value = {
        tag: "error",
        code: "unavailable",
        note: "Session communication is not enabled or configured. Use /session-communication status.",
      };
      await expect(tool.execute("id", {})).resolves.toStrictEqual(result(value));
    }
  });
  test.each([1, 4, 12, 30, 80])(
    "primary uncertainty and mixed-report warnings survive width %i",
    (width) => {
      const send = render(
        "session_send",
        "result",
        cases[1]?.args,
        result({ outcome: unknown }),
        false,
        width,
      );
      const normalized = compact(send);
      expect(normalized).toContain("UNKNOWN");
      expect(normalized).toContain("Donotresendasnew.");
      expect(normalized).not.toContain("Added to peer inbox");
      const report = render(
        "session_report",
        "result",
        cases.at(-1)?.args,
        result({
          tag: "ok",
          value: {
            publication,
            pushes: [
              { recipient: other, outcome: admitted },
              { recipient: other, outcome: denied },
              { recipient: other, outcome: unknown },
              { recipient: other, outcome: { tag: "error", code: "overloaded" } },
            ],
          },
        }),
        false,
        width,
      );
      const reportText = compact(report);
      expect(reportText).toContain("Donotresendasnew.");
      expect(reportText).toContain("publicationisnotrolledback.");
      expect(reportText).toContain(
        "4pushes:1addedtopeerinbox;1notadmitted;1UNKNOWN;1otherfailures",
      );
      for (const line of [...send, ...report]) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );
  test.each(cases)(
    "$name incomplete arguments, partial, absent and error results are defensive",
    (entry) => {
      expect(
        render(entry.name, "call", undefined, undefined, false, 40, { argsComplete: false }).join(
          "\n",
        ),
      ).not.toContain("preparing");
      const partial = render(entry.name, "result", undefined, result(entry.value), false, 80, {
        isPartial: true,
      }).join("\n");
      expect(partial).toContain("In progress · outcome not final");
      expect(partial).not.toContain("Published");
      expect(render(entry.name, "result", undefined, undefined).join("\n")).toContain(
        "Result unavailable",
      );
      expect(
        render(
          entry.name,
          "result",
          undefined,
          result({ tag: "error", code: "forbidden", resource: "operations" }),
        ).join("\n"),
      ).toContain("Failed · forbidden · operations");
      expect(
        render(
          entry.name,
          "result",
          undefined,
          { content: [{ type: "text", text: "Connection failed" }] },
          false,
          80,
          { isError: true },
        ).join("\n"),
      ).toContain("Connection failed");
    },
  );
  test("denials, removed publications, terminal interests, empty lists and nonstandard results never claim delivery", () => {
    expect(render("session_send", "result", {}, result({ outcome: denied })).join("\n")).toContain(
      "Not added to peer inbox · forbidden",
    );
    expect(render("session_send", "result", {}, result({})).join("\n")).toContain(
      "Outcome unavailable",
    );
    expect(
      render(
        "session_state",
        "result",
        { action: "remove" },
        result({ tag: "ok", value: { removed: true } }),
      ).join("\n"),
    ).toContain("Publication removed");
    expect(
      render(
        "session_interest",
        "result",
        {},
        result({
          tag: "ok",
          value: { publisher: peer, active: false, current: { status: "completed" } },
        }),
      ).join("\n"),
    ).toContain("completed");
    for (const name of [
      "session_state",
      "session_interest",
      "session_peers",
      "session_take",
      "session_report",
      "unknown",
    ]) {
      expect(render(name, "result", {}, result({})).join("\n")).toContain("unavailable");
    }
    expect(
      render(
        "session_report",
        "result",
        {},
        result({ tag: "ok", value: { publication, pushes: [] } }),
      ).join("\n"),
    ).toContain("Published; no peer notifications");
  });
  test("session_take call summary is inert for any limit value", () => {
    expect(takeCall({}).join("\n")).toContain("up to 4 messages");
    expect(takeCall({ limit: 7 }).join("\n")).toContain("up to 7 messages");
    for (const limit of ["\u001b[2J", "\u001b]52;c;x\u0007", "\u0080", "5\u009b31m", "a\nb"]) {
      const lines = takeCall({ limit });
      expect(lines.join("")).toContain("up to ");
      for (const line of lines) {
        expect(line).not.toMatch(/\p{Cc}/u);
      }
    }
    expect(takeCall({ limit: "a\u001b[2Jb" }).join("\n")).toContain(
      String.raw`up to a\u001b[2Jb messages`,
    );
  });
  test("large batches are counted but previews stay small; authored labels never replace authenticated identity", () => {
    const peers = Array.from({ length: 64 }, () => ({
      peer: other,
      label: "alpha/admin",
      scopeIds: ["team"],
    }));
    const output = render("session_peers", "result", {}, result({ peers })).join("\n");
    expect(output).toContain("64 peers");
    expect(output).toContain("61 more");
    expect(output).toContain("beta/…ba987654@bbbbbb · label (authored): alpha/admin");
    expect(
      render("session_peers", "result", {}, result({ peers: [{ peer: other }] })).join("\n"),
    ).not.toContain("label");
  });
  test("expanded output includes full body, provenance, IDs, scope, correlation, receipts and notes", () => {
    const payload = result(cases[2]?.value);
    const rendered = render("session_take", "result", {}, payload, true, 1000).join("\n");
    for (const value of [
      peer.sessionId,
      peer.runtimeNonce,
      message.id,
      message.content,
      '"scopeId": "team"',
      '"correlation": "none"',
      "No work completion claim",
    ]) {
      expect(rendered).toContain(value);
    }
    expect(
      render("session_send", "result", {}, result({ outcome: admitted }), true, 1000).join("\n"),
    ).toContain('"binding"');
  });
  test("same-session runtime reloads have distinct compact identities and send results do not echo bodies", () => {
    const oldRuntime = { ...other, runtimeNonce: "e".repeat(32) };
    const call = render("session_send", "call", { to: other, message }, undefined).join("\n");
    const stale = render("session_send", "call", { to: oldRuntime, message }, undefined).join("\n");
    expect(call).toContain("beta/…ba987654@bbbbbb");
    expect(stale).toContain("beta/…ba987654@eeeeee");
    expect(stale).not.toBe(call);
    expect(
      render("session_send", "result", { to: other, message }, result({ outcome: admitted }))
        .join("\n")
        .trim(),
    ).toBe("Added to peer inbox");
  });
  test.each([
    { action: "list", publisher: other },
    { action: "get", publisher: other, key: "review" },
    { action: "remove", key: "review" },
  ])("state $action calls omit irrelevant placeholders", (args) => {
    const output = render("session_state", "call", args, undefined).join("\n");
    expect(output).not.toContain(" · …");
    expect(output).not.toContain(" · undefined");
  });
  test("interest calls name publication or short request work", () => {
    expect(
      render(
        "session_interest",
        "call",
        {
          action: "add",
          publisher: other,
          work: { kind: "publication", key: "review", publisher: other },
        },
        undefined,
      ).join("\n"),
    ).toContain("publication review");
    expect(
      render(
        "session_interest",
        "call",
        { action: "remove", publisher: other, work: record.work },
        undefined,
      ).join("\n"),
    ).toContain("request …cccccccc");
  });
  test("expanded payloads have one structured body copy; fallback errors still expose content", () => {
    const payload = result(cases[2]?.value);
    const before = JSON.stringify(payload);
    const output = render("session_take", "result", {}, payload, true, 1000).join("\n");
    expect(output.split(`"content": "${message.content}"`)).toHaveLength(2);
    expect(output).not.toContain('"details"');
    expect(output).not.toContain(String.raw`\"provenance\"`);
    expect(output).toContain('"provenance"');
    expect(output).toContain("No work completion claim");
    expect(JSON.stringify(payload)).toBe(before);
    expect(
      render(
        "session_send",
        "result",
        {},
        { content: [{ type: "text", text: "Connection failed" }] },
        true,
        1000,
      ).join("\n"),
    ).toContain('"content"');
  });
  test("reports omit zero counts, repeat uncertainty only once, and keep optional expansion hints", () => {
    const successful = render(
      "session_report",
      "result",
      {},
      result({
        tag: "ok",
        value: { publication, pushes: [{ recipient: other, outcome: admitted }] },
      }),
    ).join("\n");
    expect(successful).not.toContain("0 not admitted");
    expect(successful).not.toContain("0 UNKNOWN");
    expect(successful).not.toContain("other failures");
    expect(successful).not.toContain("ctrl+o");
    const uncertain = render(
      "session_report",
      "result",
      {},
      result({
        tag: "ok",
        value: {
          publication,
          pushes: [
            { recipient: other, outcome: unknown },
            { recipient: peer, outcome: unknown },
          ],
        },
      }),
      false,
      1000,
    ).join("\n");
    expect(uncertain.split("Delivery uncertain;")).toHaveLength(2);
    expect(uncertain.split(" · uncertain")).toHaveLength(3);
    expect(uncertain).toContain("2 UNKNOWN");
    const peers = Array.from({ length: 4 }, () => ({ peer: other }));
    expect(render("session_peers", "result", {}, result({ peers })).join("\n")).toContain(
      "ctrl+o for details",
    );
    expect(
      render(
        "session_send",
        "result",
        { message: { ...message, content: "long ".repeat(100) } },
        result({ outcome: admitted }),
      ).join("\n"),
    ).toContain("ctrl+o for details");
  });
  // Each case renders four large multiline strings through Pi's text layout, about 1 ms apiece. The
  // test measured 1.8 s under 8 busy processes, so it keeps a 60 s timeout.
  test(
    "Hegel: generated controls, Unicode and multiline bodies are inert, cell-bounded and nonmutating",
    { timeout: propertyTimeout(60_000) },
    () => {
      assertHegel(propertySettings(200, 456n), (tc) => {
        const code = tc.draw(gs.integers({ minValue: 0, maxValue: 159 }), "control");
        const width = tc.draw(gs.integers({ minValue: 1, maxValue: 100 }), "width");
        const repeats = tc.draw(gs.integers({ minValue: 1, maxValue: 50 }), "length");
        const body =
          `${String.fromCodePoint(code)}\u001b]52;c;unsafe\u0007\n\t界😀é ![x](https://invalid.invalid) `.repeat(
            repeats,
          );
        const args = { to: other, message: { ...message, content: body } };
        const payload = result({ outcome: admitted, note: body });
        const before = JSON.stringify({ args, payload });
        // In render order: collapsed call, collapsed result, expanded call, expanded result.
        const rendered: string[][] = [];
        for (const expanded of [false, true]) {
          for (const slot of ["call", "result"] as const) {
            const lines = render("session_send", slot, args, payload, expanded, width);
            rendered.push(lines);
            for (const line of lines) {
              assert(visibleWidth(line) <= width);
              assert(!stripStyle(line).includes("\u001b"));
              assert(!line.includes("\u009b"));
            }
          }
        }
        const [collapsedCall = [], collapsedResult = []] = rendered;
        assert(collapsedCall.length <= 12);
        assert(collapsedResult.length <= 24);
        assert.equal(JSON.stringify({ args, payload }), before);
      });
    },
  );
  test.each([
    { count: 0, peerLabel: "peers", messageLabel: "messages", publicationLabel: "publications" },
    { count: 1, peerLabel: "peer", messageLabel: "message", publicationLabel: "publication" },
    { count: 2, peerLabel: "peers", messageLabel: "messages", publicationLabel: "publications" },
  ])(
    "count $count uses English singular/plural labels",
    ({ count, peerLabel, messageLabel, publicationLabel }) => {
      const peers = Array.from({ length: count }, () => ({ peer: other }));
      expect(render("session_peers", "result", {}, result({ peers })).join("\n")).toContain(
        `${count} ${peerLabel} ·`,
      );
      const messages = Array.from({ length: count }, () => ({
        provenance: { sender: peer },
        message,
      }));
      expect(render("session_take", "result", {}, result({ messages })).join("\n")).toContain(
        `${count} ${messageLabel} taken`,
      );
      const publications = Array.from({ length: count }, () => publication);
      expect(
        render(
          "session_state",
          "result",
          { action: "list" },
          result({ tag: "ok", value: { items: publications } }),
        ).join("\n"),
      ).toContain(`${count} ${publicationLabel}`);
    },
  );
  test.each([
    { count: 1, label: "push" },
    { count: 2, label: "pushes" },
  ])("report count $count uses push/pushes", ({ count, label }) => {
    const pushes = Array.from({ length: count }, () => ({ recipient: other, outcome: admitted }));
    expect(
      render(
        "session_report",
        "result",
        {},
        result({ tag: "ok", value: { publication, pushes } }),
      ).join("\n"),
    ).toContain(`${count} ${label}:`);
  });
  test.each([
    ["activation_pending", "Activation pending"],
    ["activation_unconfirmed", "Managed activation unconfirmed"],
  ])("%s is distinct and explains passive versus explicit activation", (status, footer) => {
    expect(attentionStatus({ status })).toContain(footer);
    const detail = diagnostics({ enabled: true, status }, "enabled");
    expect(detail).toContain("Passive reconnect never restarts a gateway");
    expect(detail).toContain("Activate saved configuration");
    expect(detail).toContain("Existing sessions may still use old trust");
  });
  test("footer is absent when healthy; explicit diagnostics retain exact identity and accounting", () => {
    expect(attentionStatus({ status: "connected" })).toBeUndefined();
    expect(attentionStatus({ status: "unavailable" })).toBe("Peers unavailable");
    expect(attentionStatus({ status: "disconnected" })).toBe("Peers unavailable · disconnected");
    expect(attentionStatus({ status: "unavailable\u001b[31m" })).not.toContain("\u001b");
    expect(attentionStatus(undefined)).toContain("disconnected");
    expect(diagnostics(undefined, "not enabled")).toBe("Session communication: not enabled");
    expect(diagnostics(undefined, "enabled")).toBe(
      "Session communication: not enabled · runtime unavailable",
    );
    expect(diagnostics(undefined, "not enabled (no user-agent session-communication.json)")).toBe(
      "Session communication: not enabled · (no user-agent session-communication.json)",
    );
    expect(diagnostics(undefined, "configuration or startup failed")).toBe(
      "Session communication: not enabled · configuration or startup failed",
    );
    const status = diagnostics(
      {
        enabled: true,
        status: "connected",
        peer,
        scopes: ["team"],
        watching: true,
        inboxMessages: 2,
        inboxBytes: 128,
        receipts: 3,
        operations: 1,
        publications: 4,
        publicationBytes: 32,
        revision: 8,
        interests: 2,
        relations: 1,
        notice: "degraded_unobserved",
      },
      "unused",
    );
    expect(status).toContain(`session=${peer.sessionId} nonce=${peer.runtimeNonce}`);
    expect(status).toContain("Inbox: 2 messages / 128 bytes · receipts=3 · operations=1");
    expect(status).toContain("Publications: 4 / 32 bytes · revision=8 · interests=2 · relations=1");
    expect(status).toContain("watch=active");
    expect(status).toContain("degraded_unobserved");
    expect(status).not.toContain('{"');
    expect(diagnostics({}, "unused")).toContain("Scopes: none · watch=off");
  });
});
