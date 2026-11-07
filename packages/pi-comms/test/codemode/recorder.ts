/** Deterministic scripted "model" policy. Same task, same final answer for both arms.
 *  Direct arm batches every independent call of a round into ONE assistant response (parallel tool calls).
 *  Codemode arm issues one script. No provider is involved; this is scheduling, not model quality.
 *  The final answers are derived from the tool results actually received, never from the expected JSON. */
import type { ToolCall } from "@earendil-works/pi-ai";
import { SCOPE } from "./corpus.js";

export type Call = { name: string; arguments: ToolCall["arguments"] };
export type Step = { kind: "calls"; calls: Call[] } | { kind: "text"; text: string };
type Message = { role: string; content?: unknown };
type Peer = { machineId: string; sessionId: string; runtimeNonce: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function list(value: unknown): unknown[] {
  const out: unknown[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      out.push(item);
    }
  }
  return out;
}
function toPeer(value: unknown): Peer {
  return {
    machineId: str(field(value, "machineId")),
    sessionId: str(field(value, "sessionId")),
    runtimeNonce: str(field(value, "runtimeNonce")),
  };
}
function parse(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}
function texts(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return list(message.content)
    .map((block) => str(field(block, "text")))
    .join("\n");
}
/** Tool results produced after the most recent assistant message. */
function latestResults(messages: Message[]): string[] {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf("assistant");
  return messages
    .slice(lastAssistant + 1)
    .filter((m) => m.role === "toolResult")
    .map((m) => texts(m));
}
const assistantTurns = (messages: Message[]) =>
  messages.filter((m) => m.role === "assistant").length;
function ticketOf(content: string): string {
  return content.split("\n")[0]?.slice("TICKET: ".length) ?? "";
}
function okValue(raw: string): unknown {
  const outcome = parse(raw);
  return field(outcome, "tag") === "ok" ? field(outcome, "value") : undefined;
}
function getCall(peer: Peer, revision: number): Call {
  return {
    name: "session_state",
    arguments: {
      action: "get",
      publisher: peer,
      scopeId: SCOPE,
      key: "handoff",
      expectedRevision: revision,
    },
  };
}

const AGGREGATE_SCRIPT = `
const peers = JSON.parse(await tools.session_peers({ scopeIds: ["${SCOPE}"] })).peers;
const lists = await Promise.allSettled(peers.map((p) => tools.session_state({ action: "list", publisher: p.peer, scopeId: "${SCOPE}" })));
const picks = [];
lists.forEach((r, i) => {
  if (r.status !== "fulfilled") { return; }
  const o = JSON.parse(r.value);
  if (o.tag !== "ok") { return; }
  for (const item of o.value.items) { if (item.key === "handoff" && item.revision >= 2) { picks.push({ peer: peers[i].peer, revision: item.revision }); } }
});
const gets = await Promise.allSettled(picks.map((x) => tools.session_state({ action: "get", publisher: x.peer, scopeId: "${SCOPE}", key: "handoff", expectedRevision: x.revision })));
const selected = [];
gets.forEach((r, i) => {
  if (r.status !== "fulfilled") { return; }
  const o = JSON.parse(r.value);
  if (o.tag !== "ok") { return; }
  const p = o.value.publication;
  selected.push({ publisher: picks[i].peer.sessionId, key: p.key, revision: p.revision, ticket: p.content.split("\\n")[0].slice("TICKET: ".length) });
});
selected.sort((a, b) => a.publisher.localeCompare(b.publisher));
return JSON.stringify({ selected });`;

function singleReadArguments(prompt: string): Call["arguments"] {
  const revision = Number(/revision (?<revision>\d+)/u.exec(prompt)?.groups?.revision);
  const raw = /exact publisher: (?<peer>\{.*?\})\./u.exec(prompt)?.groups?.peer ?? "{}";
  return {
    action: "get",
    publisher: toPeer(parse(raw)),
    scopeId: SCOPE,
    key: "handoff",
    expectedRevision: revision,
  };
}
const singleScript = (args: Call["arguments"]) =>
  `const o = JSON.parse(await tools.session_state(${JSON.stringify(args)}));
return JSON.stringify({ ticket: o.value.publication.content.split("\\n")[0].slice("TICKET: ".length) });`;

function codemodeAnswer(result: string): string {
  return /^\{.*\}$/mu.exec(result)?.[0] ?? result;
}

function codemodeStep(scenario: string, turns: number, prompt: string, results: string[]): Step {
  if (turns === 0) {
    const code =
      scenario === "single_read" ? singleScript(singleReadArguments(prompt)) : AGGREGATE_SCRIPT;
    return { kind: "calls", calls: [{ name: "codemode", arguments: { code } }] };
  }
  return { kind: "text", text: codemodeAnswer(results[0] ?? "") };
}

function listCalls(results: string[]): Call[] {
  const peers = list(field(parse(results[0] ?? ""), "peers"));
  return peers.map((p) => ({
    name: "session_state",
    arguments: { action: "list", publisher: toPeer(field(p, "peer")), scopeId: SCOPE },
  }));
}
function isSelectedItem(item: unknown): boolean {
  const revision = field(item, "revision");
  return field(item, "key") === "handoff" && typeof revision === "number" && revision >= 2;
}
function readCalls(results: string[]): Call[] {
  return results.flatMap((raw) => {
    const value = okValue(raw);
    return list(field(value, "items"))
      .filter((item) => isSelectedItem(item))
      .map((item) => getCall(toPeer(field(value, "publisher")), Number(field(item, "revision"))));
  });
}
function selectedEntry(raw: string) {
  const value = okValue(raw);
  const publication = field(value, "publication");
  return publication === undefined
    ? []
    : [
        {
          publisher: str(field(field(value, "publisher"), "sessionId")),
          key: str(field(publication, "key")),
          revision: Number(field(publication, "revision")),
          ticket: ticketOf(str(field(publication, "content"))),
        },
      ];
}
function selectedAnswer(results: string[]): string {
  const selected = results.flatMap((raw) => selectedEntry(raw));
  return JSON.stringify({
    selected: selected.toSorted((a, b) => a.publisher.localeCompare(b.publisher)),
  });
}
function directAggregateStep(turns: number, results: string[]): Step {
  if (turns === 0) {
    return { kind: "calls", calls: [{ name: "session_peers", arguments: { scopeIds: [SCOPE] } }] };
  }
  if (turns === 1) {
    return { kind: "calls", calls: listCalls(results) };
  }
  if (turns === 2) {
    return { kind: "calls", calls: readCalls(results) };
  }
  return { kind: "text", text: selectedAnswer(results) };
}

export function plan(
  scenario: string,
  arm: "direct" | "codemode",
  messages: { role: string; content?: unknown }[],
): Step {
  const turns = assistantTurns(messages);
  const prompt = texts(messages.find((m) => m.role === "user") ?? { role: "user" });
  const results = latestResults(messages);
  if (arm === "codemode") {
    return codemodeStep(scenario, turns, prompt, results);
  }
  if (scenario === "single_read") {
    if (turns === 0) {
      return {
        kind: "calls",
        calls: [{ name: "session_state", arguments: singleReadArguments(prompt) }],
      };
    }
    const publication = field(okValue(results[0] ?? ""), "publication");
    return {
      kind: "text",
      text: JSON.stringify({ ticket: ticketOf(str(field(publication, "content"))) }),
    };
  }
  return directAggregateStep(turns, results);
}
