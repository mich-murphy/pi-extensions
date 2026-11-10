import assert from "node:assert/strict";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Hegel } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { propertySettings, propertyTimeout } from "../../../test-support/hegel-settings";
import { decodeConfiguration, permits, visibleText } from "../adapter/config.js";
import { toolPresentation } from "../adapter/presentation.js";

const settings = propertySettings(200);
const toolNames = [
  "session_peers",
  "session_send",
  "session_take",
  "session_state",
  "session_interest",
  "session_report",
] as const;
const fieldNames = [
  "message",
  "to",
  "content",
  "kind",
  "outcome",
  "tag",
  "code",
  "peers",
  "peer",
  "publication",
  "status",
  "title",
  "summary",
  "messages",
  "record",
  "key",
  "work",
  "action",
  "publisher",
  "sessionId",
  "machineId",
  "runtimeNonce",
  "items",
  "pushes",
  "recipient",
  "value",
  "revision",
  "limit",
  "category",
  "notify",
  "scopeId",
  "scopeIds",
  "provenance",
  "sender",
  "binding",
];
const hostile = [
  "\u001b]52;c;unsafe\u0007",
  "\u001b]0;title\u001b\\",
  "\u001b[31mred\u001b[0m",
  "\u009b31m",
  "\u0085\u009d",
  "‮evil⁩",
  "界😀é\n\t",
  "long ".repeat(60),
];

// Independent oracle: U+202A-202E and U+2066-2069 as an explicit decimal list, not a range.
const bidiCodes = [8234, 8235, 8236, 8237, 8238, 8294, 8295, 8296, 8297];
const bidiControl = new RegExp(
  `[${bidiCodes.map((code) => `\\u${code.toString(16)}`).join("")}]`,
  "u",
);
function isVisibleTextEscaped(code: number): boolean {
  return (
    code <= 8 ||
    (code >= 11 && code <= 31) ||
    (code >= 127 && code <= 159) ||
    bidiCodes.includes(code)
  );
}
function controlSequence(code: number, kind: number): string {
  const character = String.fromCodePoint(code);
  const sequences = [
    character,
    `\u001b]0;${character}\u0007`,
    `\u001b]52;c;${character}\u001b\\`,
    `\u001b[31;1m${character}`,
    `\u009b31m${character}`,
  ];
  return sequences[kind] ?? character;
}
const escapeOrC1 = new RegExp(`[${String.fromCodePoint(27)}\\u0080-\\u009f]`, "u");
// pi-tui truncation appends SGR resets; only non-SGR escapes count as leaks in rendered lines.
const sgr = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "gu");
function hasEscapeOrC1(value: string): boolean {
  return escapeOrC1.test(value);
}
function assertVisibleTextTable(code: number): void {
  const character = String.fromCodePoint(code);
  const output = visibleText(character);
  if (isVisibleTextEscaped(code)) {
    assert.equal(output, `\\u${code.toString(16).padStart(4, "0")}`);
  } else {
    assert.equal(output, character);
  }
  assert.equal(hasEscapeOrC1(output), false);
  assert.equal(bidiControl.test(output), false);
}
function assertVisibleTextSequence(code: number, kind: number, prefix: string): void {
  const sequence = controlSequence(code, kind);
  const output = visibleText(sequence);
  assert.equal(hasEscapeOrC1(output), false);
  assert.equal(output, Array.from(sequence, (part) => visibleText(part)).join(""));
  assert.equal(visibleText(prefix + sequence), visibleText(prefix) + output);
}
// Every third drawn code is replaced by a bidi control so they are drawn often.
function pickCode(drawn: number, bidi: number): number {
  return drawn % 3 === 0 ? bidi : drawn;
}
function assertVisibleTextBidi(code: number, prefix: string): void {
  const output = visibleText(`${prefix}${String.fromCodePoint(code)}${prefix}`);
  assert.equal(bidiControl.test(output), false);
  assert.equal(output.includes(`\\u${code.toString(16)}`), true);
}
const controlCodes = [...Array.from({ length: 32 }, (_, code) => code), 127, 128, 155, 159];
function baseConfiguration(allowed: boolean): Record<string, unknown> {
  return {
    machineId: "alpha",
    socketPath: "/tmp/gateway.sock",
    scopeIds: ["team"],
    label: "test",
    policies: [{ machineId: "beta", scopeId: "team", permissions: allowed ? ["push"] : [] }],
  };
}
function injectControl(allowed: boolean, field: number, injected: string): unknown {
  const config = baseConfiguration(allowed);
  const policy = { machineId: "beta", scopeId: "team", permissions: ["push"] };
  const variants: Record<string, unknown>[] = [
    { label: `test${injected}` },
    { socketPath: `/tmp/${injected}.sock` },
    { scopeIds: [`team${injected}`] },
    { policies: [{ ...policy, machineId: `beta${injected}` }] },
    { policies: [{ ...policy, scopeId: `team${injected}` }] },
  ];
  return { ...config, ...variants[field] };
}
function assertPermissionDecision(allowed: boolean, code: number, kind: number): void {
  const injected = controlSequence(code, kind);
  const config = decodeConfiguration(baseConfiguration(allowed));
  assert.equal(permits(config, "beta", "team", "push"), allowed);
  assert.equal(permits(config, "beta", "team", "read"), false);
  assert.equal(permits(config, "beta", "other", "push"), false);
  assert.equal(permits(config, "gamma", "team", "push"), false);
  assert.equal(permits(config, `beta${injected}`, "team", "push"), false);
  assert.equal(permits(config, "beta", `team${injected}`, "push"), false);
  assert.equal(permits(config, `beta${injected}`, `team${injected}`, "push"), false);
}
function assertControlNamesRejected(allowed: boolean, code: number, kind: number, field: number) {
  const injected = controlSequence(code, kind);
  assert.throws(() => decodeConfiguration(injectControl(allowed, field, injected)));
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const jsonLeaf = gs.oneOf<Json>(
  gs.just(null),
  gs.booleans(),
  gs.integers({ minValue: -5, maxValue: 5000 }),
  gs.text({ maxSize: 40 }),
  gs.sampledFrom(hostile),
);
const jsonValue = gs.recursive<Json>(
  jsonLeaf,
  (children) =>
    gs.oneOf<Json>(
      gs.arrays(children, { maxSize: 5 }),
      gs
        .arrays(gs.tuples(gs.sampledFrom(fieldNames), children), { maxSize: 6 })
        .map((entries) => Object.fromEntries(entries)),
    ),
  { maxDepth: 5, maxLeaves: 40 },
);
// Hostile text placed in the exact fields the renderers preview, so sanitizing is exercised.
const hostileShape = gs.sampledFrom(hostile).map((text): Json => ({
  to: { machineId: text, sessionId: text, runtimeNonce: text },
  publisher: { machineId: text, sessionId: text, runtimeNonce: text },
  message: { kind: text, content: text },
  record: { status: text, title: text },
  action: text,
  key: text,
  code: text,
  tag: text,
}));
const argsValue = gs.oneOf<Json>(jsonValue, hostileShape);
function renderLines(
  name: string,
  slot: "call" | "result",
  args: unknown,
  payload: unknown,
  options: { expanded: boolean; isError: boolean; width: number },
): string[] {
  const theme = { fg: (_token: string, value: string) => value };
  const context = {
    args,
    state: {},
    argsComplete: true,
    expanded: options.expanded,
    isError: options.isError,
    keyHint: (_key: string, description: string) => `ctrl+o ${description}`,
  };
  const renderer = toolPresentation(name);
  const render = slot === "call" ? renderer.renderCall : renderer.renderResult;
  assert(typeof render === "function");
  const component: unknown = Reflect.apply(
    render,
    undefined,
    slot === "call"
      ? [args, theme, context]
      : [payload, { expanded: options.expanded, isPartial: false }, theme, context],
  );
  assert(component instanceof Text);
  return component.render(options.width);
}
function assertRenderedBounds(
  name: string,
  args: Json,
  value: Json,
  width: number,
  isError: boolean,
): void {
  const payload = {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: { value },
  };
  for (const expanded of [false, true]) {
    for (const slot of ["call", "result"] as const) {
      const lines = renderLines(name, slot, args, payload, { expanded, isError, width });
      for (const line of lines) {
        assert(visibleWidth(line) <= width, `${name}/${slot} exceeds ${width}: ${line}`);
        assert(
          !hasEscapeOrC1(line.replaceAll(sgr, "")),
          `${name}/${slot} leaked ESC/C1: ${JSON.stringify(line)}`,
        );
        assert(!bidiControl.test(line), `${name}/${slot} leaked bidi: ${JSON.stringify(line)}`);
      }
    }
  }
}

describe("Hegel adapter policy and rendering properties", () => {
  test("permission decisions are exact whatever control content names carry", () => {
    new Hegel((tc) => {
      const allowed = tc.draw(gs.booleans(), "allowed");
      const code = tc.draw(gs.sampledFrom(controlCodes), "control");
      const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }), "sequence");
      const field = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }), "field");
      assertPermissionDecision(allowed, code, kind);
      assertControlNamesRejected(allowed, code, kind, field);
    })
      .settings(settings)
      .runSync();
  });
  test("visibleText escapes controls per table and never emits ESC or C1", () => {
    new Hegel((tc) => {
      const drawn = tc.draw(gs.integers({ minValue: 0, maxValue: 12_287 }), "code");
      const bidi = tc.draw(gs.sampledFrom(bidiCodes), "bidi");
      const code = pickCode(drawn, bidi);
      const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }), "sequence");
      const prefix = tc.draw(gs.text({ maxSize: 12 }), "prefix");
      assertVisibleTextTable(code);
      assertVisibleTextSequence(code % 160, kind, prefix);
      assertVisibleTextBidi(bidi, prefix);
    })
      .settings(settings)
      .runSync();
  });
  // Each case lays out four renderings of arbitrary JSON through Pi's text layout: 0.4 s quiet and 0.8 s
  // under 8 busy processes.
  test(
    "every tool renderer stays within width and free of ESC/C1 for arbitrary JSON",
    { timeout: propertyTimeout(30_000) },
    () => {
      new Hegel((tc) => {
        const name = tc.draw(gs.sampledFrom(toolNames), "tool");
        const args = tc.draw(argsValue, "args");
        const value = tc.draw(argsValue, "result");
        const width = tc.draw(gs.integers({ minValue: 10, maxValue: 200 }), "width");
        const isError = tc.draw(gs.booleans(), "isError");
        assertRenderedBounds(name, args, value, width, isError);
      })
        .settings(settings)
        .runSync();
    },
  );
});

// Embedding, override and isolate controls reorder text in bidi-aware terminals. LRM/RLM/ALM are
// deliberately left alone: they are zero-width marks that cannot reorder across a run on their own.
describe("visibleText bidi controls", () => {
  test.each(bidiCodes)("escapes code point %i and keeps surrounding text", (code) => {
    const escaped = `\\u${code.toString(16)}`;
    assert.equal(visibleText(`a${String.fromCodePoint(code)}b`), `a${escaped}b`);
  });
});
