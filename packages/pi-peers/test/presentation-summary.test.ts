import assert from "node:assert/strict";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
import {
  assertHegel,
  propertySettings,
  propertyTimeout,
} from "../../../test-support/hegel-settings";
import { footerStatus, statusSummary, statusText } from "../adapter/presentation.js";

const peer = { machineId: "dev-01", sessionId: "s".repeat(36), runtimeNonce: "a".repeat(32) };
const internal =
  /nonce|generation|receipt|operation|relation|guarded|registration|\bCAS\b|ledger|floor|projection/iu;
const controlCodes = new Set([
  ...Array.from({ length: 9 }, (_, code) => code),
  ...Array.from({ length: 21 }, (_, index) => index + 11),
  ...Array.from({ length: 33 }, (_, index) => index + 127),
  8234,
  8235,
  8236,
  8237,
  8238,
  8294,
  8295,
  8296,
  8297,
]);
function hasControl(value: string): boolean {
  for (const character of value) {
    if (controlCodes.has(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}
const hostile = gs.oneOf(
  gs.text({ maxSize: 40 }),
  gs.sampledFrom(["\u001b[31mx", "\u009b1m", "‮evil", "nonce", "generation", "ledger"]),
);
function drawStatus(tc: TestCase): { value: unknown; authored: string[] } {
  const status = tc.draw(
    gs.sampledFrom(["connected", "activation_pending", "activation_unconfirmed", "x"]),
    "status",
  );
  const machine = tc.draw(gs.sampledFrom(["dev-01", "alpha", "\u001b]0;t\u0007"]), "machine");
  const scope = tc.draw(hostile, "scope");
  const enabled = tc.draw(gs.booleans(), "enabled");
  const present = tc.draw(gs.booleans(), "present");
  const value = present
    ? { enabled, status, peer: { ...peer, machineId: machine }, scopes: [scope] }
    : undefined;
  return { value, authored: [scope, machine] };
}
function assertPlain(text: string, authored: string[]): void {
  assert.equal(hasControl(text), false, `control character in ${JSON.stringify(text)}`);
  let own = text;
  for (const part of authored.filter((entry) => entry !== "")) {
    own = own.replaceAll(part, "");
  }
  assert.equal(internal.test(own), false, `internal term in ${JSON.stringify(own)}`);
}
function primary(status: unknown, diagnostic: string): string {
  const summary = statusSummary(status, diagnostic);
  return [summary.headline, ...summary.rows.flat(), summary.next ?? ""].join("\n");
}

function links(...states: [string, string][]) {
  return states.map(([machineId, state]) => ({ machineId, state, since: 0 }));
}
describe("plain-language status summary", () => {
  test("remote link state appears as one row per machine with its next try", () => {
    const summary = statusSummary(
      {
        enabled: true,
        status: "connected",
        peer,
        scopes: ["local"],
        links: [
          { machineId: "laptop", state: "up", since: Date.UTC(2026, 0, 1, 9, 0, 0) },
          {
            machineId: "dev-01",
            state: "down",
            since: Date.UTC(2026, 0, 1, 10, 0, 0),
            nextProbe: Date.UTC(2026, 0, 1, 10, 0, 30),
          },
          { machineId: "x", state: "weird", since: 1 },
        ],
      },
      "enabled",
    );
    expect(summary.rows).toContainEqual(["Link to laptop", "Up (since 09:00:00 UTC)"]);
    expect(summary.rows).toContainEqual([
      "Link to dev-01",
      "Down — sends to it fail at once; the gateway keeps retrying (since 10:00:00 UTC, next try 10:00:30 UTC)",
    ]);
    expect(summary.rows.map(([label]) => label)).not.toContain("Link to x");
  });
  test("connected names the machine and scope and keeps identifiers technical", () => {
    const summary = statusSummary(
      { enabled: true, status: "connected", peer, scopes: ["local"], inboxMessages: 2 },
      "enabled",
    );
    expect(summary.state).toBe("connected");
    expect(summary.headline).toBe("Connected as dev-01 · scope local");
    expect(summary.rows.map(([label]) => label)).toStrictEqual([
      "Machine",
      "Scopes",
      "Peers seen",
      "Inbox",
    ]);
    expect(summary.rows).toContainEqual(["Peers seen", "Unknown — not watching"]);
    expect(summary.next).toBe("Open another Pi session to collaborate.");
    const text = statusText(summary);
    expect(text).toContain("Inbox: 2 messages waiting");
    expect(text).toContain("Technical details:");
    expect(text.indexOf("Technical details:")).toBeLessThan(text.indexOf(peer.runtimeNonce));
  });
  test.each([
    [undefined, "not enabled (no user-agent pi-peers.json)", "off"],
    [undefined, "participation disabled", "off"],
    [undefined, "enabled", "unavailable"],
    [undefined, "configuration or startup failed. Check …", "failed"],
    [{ enabled: true, status: "activation_pending" }, "enabled", "pending"],
    [{ enabled: true, status: "activation_unconfirmed" }, "enabled", "pending"],
    [{ enabled: true, status: "disconnected" }, "enabled", "unavailable"],
  ])("%j / %s is %s with a next step", (status, diagnostic, state) => {
    const summary = statusSummary(status, diagnostic);
    expect(summary.state).toBe(state);
    expect(summary.next).toBeDefined();
    expect(primary(status, diagnostic)).not.toMatch(internal);
  });
  test.each([
    [undefined, "not enabled (no user-agent pi-peers.json)"],
    [undefined, "participation disabled"],
    [{ enabled: false }, "enabled"],
    [{ enabled: true, status: "activation_pending" }, "enabled"],
    [{ enabled: true, status: "activation_unconfirmed" }, "enabled"],
  ])("%j / %s: the menu says Choose Setup, notify says /peers setup", (status, diagnostic) => {
    const menu = statusSummary(status, diagnostic, { inMenu: true }).next;
    const notify = statusSummary(status, diagnostic).next;
    expect(menu).toMatch(/[Cc]hoose Setup/u);
    expect(menu).not.toMatch(/\/peers setup|Open \/peers/u);
    expect(notify).toMatch(/[Rr]un \/peers setup/u);
  });
  test("statusText omits the technical section when empty", () => {
    expect(statusText({ state: "off", headline: "Off", rows: [], technical: [] })).toBe("Off");
  });
  test("footer uses exactly the contract strings", () => {
    expect(footerStatus({ status: "connected" }, false)).toBeUndefined();
    expect(footerStatus({ status: "connected" }, true)).toBe("peers ✓");
    expect(footerStatus({ status: "activation_pending" }, true)).toBe("peers ! activation pending");
    expect(footerStatus({ status: "activation_unconfirmed" }, true)).toBe(
      "peers ! activation pending",
    );
    expect(footerStatus({ status: "disconnected" }, true)).toBe("peers ✕ offline");
    expect(footerStatus(undefined, true)).toBe("peers ✕ setup failed");
  });
  test("footer shows unread mail before a wait, and only while connected", () => {
    expect(footerStatus({ status: "connected", inboxMessages: 2 }, true)).toBe("peers ● 2");
    expect(footerStatus({ status: "connected", inboxMessages: 2, waiting: true }, true)).toBe(
      "peers ● 2",
    );
    expect(footerStatus({ status: "connected", waiting: true }, true)).toBe("peers ✓ waiting…");
    expect(footerStatus({ status: "connected", inboxMessages: -1 }, true)).toBe("peers ✓");
    expect(footerStatus({ status: "disconnected", inboxMessages: 3 }, true)).toBe(
      "peers ✕ offline",
    );
  });
  test("footer warns about remote links that are not up, and only those", () => {
    expect(footerStatus({ status: "connected", links: links(["dev-01", "up"]) }, true)).toBe(
      "peers ✓",
    );
    expect(footerStatus({ status: "connected", links: links(["dev-01", "probing"]) }, true)).toBe(
      "peers ✓ ! dev-01 down",
    );
    expect(
      footerStatus(
        { status: "connected", inboxMessages: 1, links: links(["a", "down"], ["b", "down"]) },
        true,
      ),
    ).toBe("peers ● 1 ! 2 links down");
    expect(
      footerStatus({ status: "connected", links: links(["dev-01\u001b[31m", "down"]) }, true),
    ).not.toContain("\u001b");
  });
  test("footer colours each part with a theme token", () => {
    const theme = { fg: (tone: string, part: string) => `<${tone}>${part}` };
    expect(footerStatus({ status: "connected", inboxMessages: 1 }, true, theme)).toBe(
      "<dim>peers <accent>● 1",
    );
    expect(footerStatus({ status: "connected" }, true, theme)).toBe("<dim>peers <success>✓");
    expect(footerStatus(undefined, true, theme)).toBe("<dim>peers <error>✕ setup failed");
  });
  test(
    "arbitrary status objects never leak internal terms or control characters into primary text",
    () => {
      assertHegel(propertySettings(200), (tc) => {
        const { value, authored } = drawStatus(tc);
        const diagnostic = tc.draw(hostile, "diagnostic");
        assertPlain(primary(value, diagnostic), [...authored, diagnostic]);
      });
    },
    propertyTimeout(20_000),
  );
});
