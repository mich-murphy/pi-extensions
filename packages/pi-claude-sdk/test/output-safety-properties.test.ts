import assert from "node:assert/strict";
import { Database, Hegel } from "@hegeldev/hegel";
import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { inspectBashCommand, sanitizeBashContent, sanitizeContextMessages } from "../output-safety";
import type { SuspiciousOutputKind } from "../output-safety";

const settings = { testCases: 200, seed: 12_345n, database: Database.disabled };
const PROSE = "hello, world.\n";
const B64_CHARS = "ABCxyz019+/".split("");
const IMAGE = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
const NOTICE_LIMIT = 500;

type Block = { type: "text"; text: string } | typeof IMAGE;
type Case = { readonly text: string; readonly expected: SuspiciousOutputKind | undefined };
type Messages = Parameters<typeof sanitizeContextMessages>[0];
type Message = Messages[number];

function prose(length: number): string {
  return PROSE.repeat(Math.ceil(length / PROSE.length)).slice(0, length);
}

function drawNear(tc: TestCase, near: number, low: number, high: number): number {
  return tc.draw(
    gs.oneOf(
      gs.integers({ minValue: near - 6, maxValue: near + 6 }),
      gs.integers({ minValue: low, maxValue: high }),
    ),
  );
}

// Spec: >= 4096 chars, >= 8 control chars and a control ratio of at least 0.002.
function drawBinaryCase(tc: TestCase): Case {
  const length = drawNear(tc, 4096, 3900, 10_000);
  const controls = tc.draw(gs.integers({ minValue: 0, maxValue: 24 }));
  const text = "\0".repeat(controls) + prose(length - controls);
  const flagged = length >= 4096 && controls >= 8 && controls * 500 >= length;
  return { text, expected: flagged ? "binary" : undefined };
}

// Spec: >= 8192 base64-alphabet chars, whitespace below 5% of the text, nothing else.
function drawBase64Case(tc: TestCase): Case {
  const run = drawNear(tc, 8192, 1000, 12_000);
  const pad = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
  const spaces = tc.draw(gs.integers({ minValue: 0, maxValue: 900 }));
  const space = tc.draw(gs.sampledFrom([" ", "\n", "\t"]));
  const noise = tc.draw(gs.booleans());
  const chunk = tc.draw(gs.arrays(gs.sampledFrom(B64_CHARS), { minSize: 1, maxSize: 9 })).join("");
  let body = chunk.repeat(Math.ceil(run / chunk.length)).slice(0, run - pad);
  if (noise) {
    body = `${body.slice(0, 100)}!${body.slice(100)}`;
  }
  const text = body + "=".repeat(pad) + space.repeat(spaces);
  const flagged = !noise && run >= 8192 && run >= 19 * spaces;
  return { text, expected: flagged ? "base64" : undefined };
}

function drawCase(tc: TestCase): Case {
  return tc.draw(gs.booleans()) ? drawBinaryCase(tc) : drawBase64Case(tc);
}

function toBlocks(tc: TestCase, text: string, split: boolean): Block[] {
  if (!split) {
    return [{ type: "text", text }];
  }
  const lines = text.split("\n");
  const size = tc.draw(gs.integers({ minValue: 1, maxValue: 60 }));
  const blocks: Block[] = [];
  for (let index = 0; index < lines.length; index += size) {
    blocks.push({ type: "text", text: lines.slice(index, index + size).join("\n") }, IMAGE);
  }
  return blocks;
}

function noticeOf(content: readonly Block[]): string {
  assert.equal(content.length, 1);
  const [block] = content;
  assert.equal(block?.type, "text");
  return block?.type === "text" ? block.text : "";
}

function assertVerdict(blocks: readonly Block[], found: Case): void {
  const result = sanitizeBashContent(blocks);
  assert.equal(result.detected, found.expected);
  if (found.expected === undefined) {
    assert.deepEqual(result.content, blocks);
    return;
  }
  const notice = noticeOf(result.content);
  assert.ok(notice.length < NOTICE_LIMIT);
  assert.ok(notice.includes(found.expected === "binary" ? "Binary-like" : "Base64-like"));
  assert.ok(notice.includes(`${found.text.length.toLocaleString("en-US")} characters`));
  assert.equal(sanitizeBashContent(result.content).detected, undefined);
}

function assertSanitizes(tc: TestCase): void {
  const found = drawCase(tc);
  const whole = toBlocks(tc, found.text, false);
  const split = toBlocks(tc, found.text, true);
  assertVerdict(whole, found);
  assertVerdict(split, found);
  assert.deepEqual(
    sanitizeBashContent(whole).content,
    found.expected === undefined ? whole : sanitizeBashContent(split).content,
  );
}

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value;
}

function forge(value: object): Message {
  const copy: unknown = structuredClone(value);
  assert.ok(isMessage(copy));
  return copy;
}

const BAD = `${"\0".repeat(20)}${prose(5000)}`;
const stamp = { toolCallId: "t", isError: false, timestamp: 0 };
const BAD_BLOCKS: Block[] = [{ type: "text", text: BAD }];
const SAFE_BLOCKS: Block[] = [{ type: "text", text: prose(5000) }, IMAGE];
const MESSAGE_KINDS: readonly { readonly make: () => Message; readonly flagged: boolean }[] = [
  { make: () => forge({ role: "user", content: "hi", timestamp: 0 }), flagged: false },
  {
    make: () => forge({ role: "toolResult", toolName: "read", content: BAD_BLOCKS, ...stamp }),
    flagged: false,
  },
  {
    make: () => forge({ role: "toolResult", toolName: "bash", content: BAD, ...stamp }),
    flagged: false,
  },
  {
    make: () => forge({ role: "toolResult", toolName: "bash", content: SAFE_BLOCKS, ...stamp }),
    flagged: false,
  },
  {
    make: () => forge({ role: "toolResult", toolName: "bash", content: BAD_BLOCKS, ...stamp }),
    flagged: true,
  },
];

function assertFlaggedReplaced(before: Message | undefined, after: Message | undefined): void {
  assert.notEqual(after, before);
  assert.deepEqual({ ...after, content: 0 }, { ...before, content: 0 });
  const content = after?.role === "toolResult" ? after.content : [];
  assert.ok(noticeOf(content).includes("Binary-like"));
}

function assertContext(tc: TestCase): void {
  const kinds = tc.draw(gs.arrays(gs.integers({ minValue: 0, maxValue: 4 }), { maxSize: 8 }));
  const input = kinds.map((kind) => MESSAGE_KINDS[kind]?.make() ?? forge({}));
  const output = sanitizeContextMessages(input);
  assert.equal(output.length, input.length);
  for (const [index, kind] of kinds.entries()) {
    if (MESSAGE_KINDS[kind]?.flagged === true) {
      assertFlaggedReplaced(input[index], output[index]);
    } else {
      assert.equal(output[index], input[index]);
    }
  }
}

const SEPARATORS = [";", "&&", "|", "\n", " ; ", "\n\n", "||"];
const SUBSTITUTIONS = [
  "$(which x)",
  "$(command\t-v z)",
  "`command  -v q`",
  "$(  which\ty)",
  "$( command -v  node)",
  "`which a b`",
  "` command -v y`",
];
const GAPS = ["", " ", " -n ", " 2>/dev/null ", ' "', " '"];

function assertCatDetection(tc: TestCase): void {
  const gap = tc.draw(gs.sampledFrom(GAPS));
  const sub = tc.draw(gs.sampledFrom(SUBSTITUTIONS));
  const sep = tc.draw(gs.sampledFrom(SEPARATORS));
  const head = tc.draw(gs.sampledFrom(["", "echo hi; ", "x "]));
  const separated = `${head}cat${gap}${sep}${gap}${sub}`;
  assert.equal(inspectBashCommand(separated), undefined);
  const direct = `${head}cat ${gap}${sub}`;
  assert.equal(inspectBashCommand(direct)?.includes('file "$(which COMMAND)"'), true);
}

function assertNeverThrows(tc: TestCase): void {
  const text = tc.draw(gs.text({ maxSize: 200 }));
  const mixed = tc.draw(gs.arrays(gs.sampledFrom(["cat ", "$(", "`", "which", ")", ";", "\n"])));
  for (const command of [text, mixed.join("")]) {
    const verdict = inspectBashCommand(command);
    assert.ok(verdict === undefined || typeof verdict === "string");
  }
}

describe("output safety properties", () => {
  test("sanitizeBashContent quarantines exactly the documented thresholds", () => {
    new Hegel((tc) => {
      assertSanitizes(tc);
    })
      .databaseKey("pi-claude-sdk/output-safety-sanitize")
      .settings(settings)
      .runSync();
  });

  test("sanitizeContextMessages replaces only flagged bash results", () => {
    new Hegel((tc) => {
      assertContext(tc);
    })
      .databaseKey("pi-claude-sdk/output-safety-context")
      .settings(settings)
      .runSync();
  });

  test("inspectBashCommand blocks adjacent cat substitutions and allows separators", () => {
    new Hegel((tc) => {
      assertCatDetection(tc);
    })
      .databaseKey("pi-claude-sdk/output-safety-cat")
      .settings(settings)
      .runSync();
  });

  test("inspectBashCommand never throws", () => {
    new Hegel((tc) => {
      assertNeverThrows(tc);
    })
      .databaseKey("pi-claude-sdk/output-safety-throw")
      .settings(settings)
      .runSync();
  });
});
