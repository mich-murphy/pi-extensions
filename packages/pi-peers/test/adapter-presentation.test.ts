import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { integers } from "@hegeldev/hegel/generators";
import type { Schema } from "effect";
import { describe, expect, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { diagnostics, footerStatus, toolPresentation } from "../adapter/presentation.js";
import type { RenderContext, RenderPayload } from "../adapter/presentation.js";
import { registerTools } from "../adapter/tools.js";
import { toolRecorder } from "./adapter-tool-fixture.js";

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

type RenderOptions = { argsComplete?: boolean; isError?: boolean; isPartial?: boolean };

const theme = { fg: (_token: string, value: string) => value };

function result(value: Schema.Json | undefined): RenderPayload {
  return {
    content: [{ type: "text", text: JSON.stringify(value) ?? "" }],
    details: value === undefined ? {} : { value },
  };
}

function render(
  name: string,
  slot: "call" | "result",
  args: Schema.Json | undefined,
  payload: RenderPayload | undefined,
  expanded = false,
  width = 100,
  extra: RenderOptions = {},
): ReadonlyArray<string> {
  const renderer = toolPresentation(name);

  const context: RenderContext = {
    args,
    expanded,
    isError: false,
    keyHint: (_key: string, description: string) => `ctrl+o ${description}`,
    ...extra,
  };

  const component =
    slot === "call"
      ? renderer.renderCall(args, theme, context)
      : renderer.renderResult(
          payload,
          { expanded, isPartial: extra.isPartial === true },
          theme,
          context,
        );

  return component.render(width);
}

function stripStyle(value: string): string {
  return value.replaceAll(new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "gu"), "");
}

function compact(lines: ReadonlyArray<string>): string {
  return stripStyle(lines.join("")).replaceAll(/\s+/gu, "");
}

const taken = {
  from: "s-91c0",
  sender: peer,
  scopeId: "team",
  messageId: message.id,
  kind: "request",
  format: "text",
  content: message.content,
};

type RenderCase = {
  name: string;
  args: Schema.JsonObject;
  value: Schema.JsonObject;
  call: string;
  summary: string;
};

const cases: Array<RenderCase> = [
  {
    name: "peers_list",
    args: { scope: "team" },
    value: {
      peers: [
        {
          peer: other,
          scopeId: "team",
          label: "Reviewer",
          self: false,
          restarted: false,
          handle: "s-4f2a",
        },
      ],
    },
    call: "List peers · scope team",
    summary: "1 peer",
  },
  {
    name: "peers_send",
    args: { to: "s-4f2a", kind: "request", content: message.content },
    value: { to: "s-4f2a", outcome: admitted, note: "Admission is not model reading" },
    call: "→ s-4f2a · request · Please review",
    summary: "Added to peer inbox",
  },
  {
    name: "peers_take",
    args: { limit: 4 },
    value: { messages: [taken] },
    call: "← inbox",
    summary: "← s-91c0 · request · Please review",
  },
];

const takeCall = (args: Schema.JsonObject) => render("peers_take", "call", args, undefined);

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
  test("an undefined property does not hide the defined call and result fields", () => {
    const callArgs: Schema.JsonObject = { to: "s-4f2a", kind: "request" };
    const args = Object.defineProperty(callArgs, "content", { value: undefined, enumerable: true });
    const shown: Schema.JsonObject = { outcome: admitted };
    const payload = result(
      Object.defineProperty(shown, "note", { value: undefined, enumerable: true }),
    );

    expect(render("peers_send", "call", args, payload).join("\n")).toContain(
      "→ s-4f2a · request · …",
    );
    expect(render("peers_send", "result", args, payload).join("\n")).toContain(
      "Added to peer inbox",
    );
  });

  test("all three public registrations hook up both renderers without changing unavailable model output", async () => {
    const fixture = toolRecorder();
    registerTools(fixture, () => undefined);
    expect(fixture.tools).toHaveLength(3);

    for (const tool of fixture.tools) {
      expect(tool.renderCall).toBe(true);
      expect(tool.renderResult).toBe(true);

      const value = {
        tag: "error",
        code: "unavailable",
        note: "Peers is not set up or not running in this session. Ask the user to run `/peers status`.",
      };

      const expected = {
        content: [{ type: "text", text: value.note }],
        details: { value },
        isError: true,
      };

      const structured = new Map([
        ["peers_list", { structuredContent: { ok: false, code: "unavailable", note: value.note } }],
      ]);

      await expect(fixture.run(tool.name, {})).resolves.toStrictEqual({
        ...expected,
        ...structured.get(tool.name),
      });
    }
  });
  test.each([1, 4, 12, 30, 80])("primary uncertainty warnings survive width %i", (width) => {
    const send = render(
      "peers_send",
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

    for (const line of send) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
  test.each(cases)(
    "$name $call: incomplete arguments, partial, absent and error results are defensive",
    (entry) => {
      expect(
        render(entry.name, "call", undefined, undefined, false, 40, { argsComplete: false }).join(
          "\n",
        ),
      ).toContain(entry.name);

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
  test("denials, empty lists and nonstandard results never claim delivery", () => {
    expect(render("peers_send", "result", {}, result({ outcome: denied })).join("\n")).toContain(
      "Not added to peer inbox · forbidden",
    );
    expect(render("peers_send", "result", {}, result({})).join("\n")).toContain(
      "Outcome unavailable",
    );

    for (const name of ["peers_list", "peers_take", "unknown"]) {
      expect(render(name, "result", {}, result({})).join("\n")).toContain("unavailable");
    }
  });
  test("peers_take call summary is inert for any limit value", () => {
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
  test("large batches are counted but previews stay small; authored labels never replace handles or markers", () => {
    const peers = Array.from({ length: 64 }, () => ({
      handle: "s-4f2a",
      label: "alpha/admin (you)",
      self: false,
      restarted: false,
    }));

    const output = render("peers_list", "result", {}, result({ peers })).join("\n");
    expect(output).toContain("64 peers");
    expect(output).toContain("61 more");
    expect(output).toContain("s-4f2a · label (authored): alpha/admin (you)");
    expect(
      render(
        "peers_list",
        "result",
        {},
        result({ peers: [{ handle: "s-2", machine: "dev-01", label: "api" }] }),
      ).join("\n"),
    ).toContain("s-2 · dev-01 · label (authored): api");
    expect(output).not.toContain("s-4f2a (you)");

    const marked = render(
      "peers_list",
      "result",
      {},
      result({ peers: [{ handle: "s-1", machine: "laptop", self: true, restarted: true }] }),
    ).join("\n");

    expect(marked).toContain("s-1 (you) (restarted) · laptop");
    expect(marked).not.toContain("label");
  });
  test("expanded output includes full body, sender runtime, IDs and scope", () => {
    const payload = result(cases[2]?.value);
    const rendered = render("peers_take", "result", {}, payload, true, 1000).join("\n");

    for (const value of [
      peer.sessionId,
      peer.runtimeNonce,
      message.id,
      message.content,
      '"scopeId": "team"',
      '"from": "s-91c0"',
    ]) {
      expect(rendered).toContain(value);
    }

    expect(
      render("peers_send", "result", {}, result({ outcome: admitted }), true, 1000).join("\n"),
    ).toContain('"binding"');
  });
  test("send calls show the handle and send results do not echo bodies", () => {
    const args = { to: "s-4f2a/2", kind: "request", content: message.content };
    expect(render("peers_send", "call", args, undefined).join("\n")).toContain("→ s-4f2a/2");
    expect(
      render("peers_send", "result", args, result({ outcome: admitted }))
        .join("\n")
        .trim(),
    ).toBe("Added to peer inbox");
  });
  test("expanded payloads have one structured body copy; fallback errors still expose content", () => {
    const payload = result(cases[2]?.value);
    const before = JSON.stringify(payload);
    const output = render("peers_take", "result", {}, payload, true, 1000).join("\n");
    expect(output.split(`"content": "${message.content}"`)).toHaveLength(2);
    expect(output).not.toContain('"details"');
    expect(JSON.stringify(payload)).toBe(before);
    expect(
      render(
        "peers_send",
        "result",
        {},
        { content: [{ type: "text", text: "Connection failed" }] },
        true,
        1000,
      ).join("\n"),
    ).toContain('"content"');
  });
  test("long lists and long previews keep the expansion hint", () => {
    const peers = Array.from({ length: 4 }, () => ({ handle: "s-4f2a" }));
    expect(render("peers_list", "result", {}, result({ peers })).join("\n")).toContain(
      "ctrl+o for details",
    );
    expect(
      render(
        "peers_send",
        "result",
        { content: "long ".repeat(100) },
        result({ outcome: admitted }),
      ).join("\n"),
    ).toContain("ctrl+o for details");
  });
  test(
    "Hegel: generated controls, Unicode and multiline bodies are inert, cell-bounded and nonmutating",
    { timeout: propertyTimeout(60_000) },
    () => {
      assertHegel(propertySettings(200, 456n), (tc) => {
        const code = tc.draw(integers({ minValue: 0, maxValue: 159 }), "control");
        const width = tc.draw(integers({ minValue: 1, maxValue: 100 }), "width");
        const repeats = tc.draw(integers({ minValue: 1, maxValue: 50 }), "length");

        const body =
          `${String.fromCodePoint(code)}\u001b]52;c;unsafe\u0007\n\t界😀é ![x](https://invalid.invalid) `.repeat(
            repeats,
          );

        const args = { to: "s-4f2a", kind: "request", content: body };
        const payload = result({ outcome: admitted, note: body });
        const before = JSON.stringify({ args, payload });
        const rendered: Array<ReadonlyArray<string>> = [];

        for (const expanded of [false, true]) {
          for (const slot of ["call", "result"] as const) {
            const lines = render("peers_send", slot, args, payload, expanded, width);
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
    { count: 0, peerLabel: "peers", messageLabel: "messages" },
    { count: 1, peerLabel: "peer", messageLabel: "message" },
    { count: 2, peerLabel: "peers", messageLabel: "messages" },
  ])("count $count uses English singular/plural labels", ({ count, peerLabel, messageLabel }) => {
    const peers = Array.from({ length: count }, () => ({ handle: "s-4f2a" }));
    expect(render("peers_list", "result", {}, result({ peers })).join("\n")).toContain(
      `${count} ${peerLabel} ·`,
    );
    const messages = Array.from({ length: count }, () => taken);
    expect(render("peers_take", "result", {}, result({ messages })).join("\n")).toContain(
      `${count} ${messageLabel} taken`,
    );
  });
  test.each([
    ["activation_pending", "peers ! activation pending"],
    ["activation_unconfirmed", "peers ! activation pending"],
  ])(
    "%s has a plain footer; diagnostics explain passive versus explicit activation",
    (status, footer) => {
      expect(footerStatus({ status }, true)).toBe(footer);
      const detail = diagnostics({ enabled: true, status }, "enabled");
      expect(detail).toContain("Passive reconnect never restarts a gateway");
      expect(detail).toContain("/peers setup, then Activate saved configuration");
      expect(detail).toContain("Existing sessions may still use old trust");
    },
  );
  test("footer uses contract strings; explicit diagnostics retain exact identity and accounting", () => {
    expect(footerStatus({ status: "connected" }, true)).toBe("peers ✓");
    expect(footerStatus({ status: "unavailable" }, true)).toBe("peers ✕ offline");
    expect(footerStatus({ status: "disconnected" }, true)).toBe("peers ✕ offline");
    expect(footerStatus({ status: "unavailable\u001b[31m" }, true)).toBe("peers ✕ offline");
    expect(diagnostics(undefined, "not enabled")).toBe("Session communication: not enabled");
    expect(diagnostics(undefined, "enabled")).toBe(
      "Session communication: not enabled · runtime unavailable",
    );
    expect(diagnostics(undefined, "not enabled (no user-agent pi-peers.json)")).toBe(
      "Session communication: not enabled · (no user-agent pi-peers.json)",
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
        relations: 1,
        notice: "degraded_unobserved",
      },
      "unused",
    );

    expect(status).toContain(`session=${peer.sessionId} nonce=${peer.runtimeNonce}`);
    expect(status).toContain(
      "Inbox: 2 messages / 128 bytes · receipts=3 · operations=1 · relations=1",
    );
    expect(status).not.toContain("Publications");
    expect(status).toContain("watch=active");
    expect(status).toContain("degraded_unobserved");
    expect(status).not.toContain('{"');
    expect(diagnostics({}, "unused")).toContain("Scopes: none · watch=off");
  });
});
