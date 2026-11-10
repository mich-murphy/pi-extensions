import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { visibleText } from "./config.js";

const UNCERTAIN =
  "UNKNOWN — Delivery uncertain; may already be in peer inbox. Do not resend as new.";
type Fields = Record<string, unknown>;
function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null;
}
function fields(value: unknown): Fields {
  return isFields(value) ? value : {};
}
function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown, fallback = "…"): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}
function preview(value: unknown, fallback = "…"): string {
  return truncateToWidth(visibleText(text(value, fallback)).replaceAll(/\s+/gu, " "), 96);
}
function identity(value: unknown): string {
  const peer = fields(value);
  const session = visibleText(text(peer.sessionId)).replaceAll(/\s+/gu, " ");
  const short = session.length > 12 ? `…${session.slice(-8)}` : session;
  return `${preview(peer.machineId)}/${short}@${preview(peer.runtimeNonce).slice(-6)}`;
}
function publication(value: unknown): string {
  const record = fields(value);
  return `${preview(record.key)} r${text(record.revision)} · ${preview(record.status ?? record.category)} · ${preview(record.title)}`;
}
function listing(values: unknown[], render: (value: unknown) => string): string[] {
  return [
    ...values.slice(0, 3).map((value) => render(value)),
    ...(values.length > 3 ? [`… ${values.length - 3} more (expand)`] : []),
  ];
}
function delivery(value: unknown): string {
  const outcome = fields(value);
  if (outcome.tag === "unknown") {
    return UNCERTAIN;
  }
  if (outcome.tag === "admitted") {
    return "Added to peer inbox";
  }
  if (outcome.tag === "not_admitted") {
    return `Not added to peer inbox · ${preview(outcome.code)}`;
  }
  return `Outcome unavailable · ${preview(outcome.code ?? outcome.tag)}`;
}
function callSummary(name: string, args: Fields): string {
  switch (name) {
    case "session_send": {
      const message = fields(args.message);
      return `→ ${identity(args.to)} · ${preview(message.kind)} · ${preview(message.content)}`;
    }
    case "session_take": {
      return `← inbox · up to ${preview(args.limit, "4")} messages`;
    }
    case "session_peers": {
      return `Discover peers${args.watch === true ? " · watch" : ""}`;
    }
    case "session_state": {
      return stateCall(args);
    }
    case "session_interest": {
      return `${preview(args.action)} interest · ${identity(args.publisher)} · ${workLabel(args.work)}`;
    }
    default: {
      return `Publish report · ${preview(fields(args.record).status)} · ${preview(fields(args.record).title)} · ${preview(args.notify)}`;
    }
  }
}
function stateCall(args: Fields): string {
  const action = preview(args.action);
  if (args.action === "list") {
    return `list · ${identity(args.publisher)}`;
  }
  if (args.action === "get") {
    return `get · ${identity(args.publisher)} · ${preview(args.key)}`;
  }
  if (args.action === "remove") {
    return `remove · ${preview(args.key)}`;
  }
  if (args.action === "put") {
    return `Publish · ${preview(args.key)} · ${preview(fields(args.record).title)}`;
  }
  return action;
}
function workLabel(value: unknown): string {
  const work = fields(value);
  return work.kind === "publication"
    ? `publication ${preview(work.key)}`
    : `request …${preview(work.requestId).slice(-8)}`;
}
function reportSummary(value: Fields): string[] {
  if (value.publication === undefined || !Array.isArray(value.pushes)) {
    return ["Report result unavailable"];
  }
  const pushes = items(value.pushes);
  const count = (tag: string) =>
    pushes.filter((push) => fields(fields(push).outcome).tag === tag).length;
  const admitted = count("admitted");
  const unknown = count("unknown");
  const denied = count("not_admitted");
  const other = pushes.length - admitted - unknown - denied;
  if (pushes.length === 0) {
    return [`Published; no peer notifications · ${publication(value.publication)}`];
  }
  const counts = [
    ...(admitted > 0 ? [`${admitted} added to peer inbox`] : []),
    ...(denied > 0 ? [`${denied} not admitted`] : []),
    ...(unknown > 0 ? [`${unknown} UNKNOWN`] : []),
    ...(other > 0 ? [`${other} other failures`] : []),
  ].join("; ");
  return [
    ...(unknown > 0 ? [UNCERTAIN] : []),
    ...(denied + unknown + other > 0
      ? ["Partial/mixed outcomes; publication is not rolled back."]
      : []),
    `${pushes.length} ${pushes.length === 1 ? "push" : "pushes"}: ${counts}`,
    `Published · ${publication(value.publication)}`,
    ...listing(pushes, (push) => {
      const entry = fields(push);
      return `→ ${identity(entry.recipient)} · ${fields(entry.outcome).tag === "unknown" ? "uncertain" : delivery(entry.outcome)}`;
    }),
  ];
}
function stateSummary(result: Fields, value: Fields, args: Fields): string[] {
  if (result.tag !== "ok") {
    return ["Publication result unavailable"];
  }
  if (args.action === "list") {
    const records = items(value.items);
    return [
      `${records.length} ${records.length === 1 ? "publication" : "publications"}`,
      ...listing(records, publication),
    ];
  }
  if (args.action === "remove") {
    return [value.removed === true ? "Publication removed" : "No publication removed"];
  }
  return [
    `${args.action === "put" ? "Published" : "Publication"} · ${publication(value.publication ?? value)}`,
    preview(fields(value.publication ?? value).summary),
  ];
}
function interestSummary(value: Fields, args: Fields): string[] {
  if (typeof value.active !== "boolean") {
    return ["Interest result unavailable"];
  }
  return [
    `Interest ${value.active ? "active" : "inactive"} · ${identity(value.publisher ?? args.publisher)}${fields(value.current).status === undefined ? "" : ` · ${preview(fields(value.current).status)}`}`,
  ];
}
function resultSummary(name: string, raw: unknown, args: Fields): string[] {
  const result = fields(raw);
  if (result.tag === "error") {
    return [
      `Failed · ${preview(result.code)}${result.resource === undefined ? "" : ` · ${preview(result.resource)}`}`,
    ];
  }
  if (name === "session_send") {
    return [delivery(result.outcome)];
  }
  const value = result.tag === "ok" ? fields(result.value) : result;
  switch (name) {
    case "session_take": {
      if (!Array.isArray(value.messages)) {
        return ["Inbox result unavailable"];
      }
      const messages = items(value.messages);
      return [
        `${messages.length} ${messages.length === 1 ? "message" : "messages"} taken`,
        ...listing(messages, (entry) => {
          const envelope = fields(entry);
          const message = fields(envelope.message);
          return `← ${identity(fields(envelope.provenance).sender)} · ${preview(message.kind)} · ${preview(message.content)}`;
        }),
      ];
    }
    case "session_peers": {
      if (!Array.isArray(value.peers)) {
        return ["Discovery result unavailable"];
      }
      const peers = items(value.peers);
      return [
        `${peers.length} ${peers.length === 1 ? "peer" : "peers"} · presence only`,
        ...listing(peers, (entry) => {
          const descriptor = fields(entry);
          return `${identity(descriptor.peer)}${descriptor.label === undefined ? "" : ` · label (authored): ${preview(descriptor.label)}`}`;
        }),
      ];
    }
    case "session_state": {
      return stateSummary(result, value, args);
    }
    case "session_interest": {
      return interestSummary(value, args);
    }
    case "session_report": {
      return reportSummary(value);
    }
    default: {
      return ["Result unavailable"];
    }
  }
}

/** Plain Text deliberately avoids Markdown links, images, or authored ANSI interpretation. */
function component(content: string, expanded: boolean, primary = ""): Text {
  const output = new Text(content, 0, 0);
  const render = output.render.bind(output);
  output.render = (width) => {
    if (width < 1) {
      return [];
    }
    // Text can emit a double-width grapheme in a one-cell viewport; clamp with Pi's helper.
    const lines = render(width).map((line) => truncateToWidth(line, width, ""));
    if (expanded) {
      return lines;
    }
    // Fixed-size primary outcomes may wrap at very narrow widths, but must never be clipped.
    const budget = Math.max(12, new Text(primary, 0, 0).render(width).length + 1);
    return lines.length <= budget
      ? lines
      : [...lines.slice(0, budget - 1), truncateToWidth("… expand for details", width)];
  };
  return output;
}
function full(value: unknown): string {
  return visibleText(JSON.stringify(value, null, 2) ?? "No payload");
}
function hasHiddenPreview(summary: string[], raw: unknown, args: Fields): boolean {
  const result = fields(raw);
  const value = result.tag === "ok" ? fields(result.value) : result;
  const previews = [
    fields(args.message).content,
    fields(value.publication ?? value).summary,
    ...items(value.messages).map((entry) => fields(fields(entry).message).content),
  ];
  return (
    summary.some((line) => line.includes("more (expand)")) ||
    previews.some((entry) => typeof entry === "string" && visibleWidth(visibleText(entry)) > 96)
  );
}
export function toolPresentation(name: string): ToolRenderers {
  return {
    renderCall(args, theme, context) {
      const summary = `${name} ${callSummary(name, fields(args))}`;
      return component(
        theme.fg("toolTitle", summary) + (context.expanded ? `\n${full(args)}` : ""),
        context.expanded,
      );
    },
    renderResult(result, options, theme, context) {
      const raw = fields(fields(result).details).value;
      const summary = options.isPartial
        ? ["In progress · outcome not final"]
        : resultSummary(name, raw, fields(context.args));
      if (context.isError) {
        summary.unshift("Failed · tool execution error");
      }
      if (raw === undefined && !options.isPartial) {
        summary.splice(
          context.isError ? 1 : 0,
          summary.length,
          "Result unavailable",
          ...items(fields(result).content).flatMap((part) =>
            fields(part).type === "text" ? [preview(fields(part).text)] : [],
          ),
        );
      }
      let color: "error" | "warning" | "toolOutput" = "toolOutput";
      if (
        summary.some(
          (line) =>
            line.startsWith("UNKNOWN") ||
            line.startsWith("Not added") ||
            line.startsWith("Partial/mixed"),
        )
      ) {
        color = "warning";
      }
      if (context.isError || fields(raw).tag === "error") {
        color = "error";
      }
      const hint = hasHiddenPreview(summary, raw, fields(context.args))
        ? `\n${theme.fg("dim", context.keyHint("app.tools.expand", "for details"))}`
        : "";
      return component(
        theme.fg(color, summary.join("\n")) +
          (options.expanded ? `\n${full(raw === undefined ? result : raw)}` : hint),
        options.expanded,
        summary.slice(0, name === "session_report" ? 3 : 1).join("\n"),
      );
    },
  };
}

export function attentionStatus(value: unknown): string | undefined {
  const status = text(fields(value).status, "disconnected");
  if (status === "connected") {
    return undefined;
  }
  return status === "unavailable" ? "Peers unavailable" : `Peers unavailable · ${preview(status)}`;
}

/** Explicit command only: exact identities, bounded accounting, no transcript or payload export. */
export function diagnostics(value: unknown, diagnostic: string): string {
  if (value === undefined) {
    const reason =
      diagnostic === "enabled" ? "runtime unavailable" : diagnostic.replace(/^not enabled\s*/u, "");
    return `Session communication: not enabled${reason.length > 0 ? ` · ${visibleText(reason)}` : ""}`;
  }
  const status = fields(value);
  const peer = fields(status.peer);
  return [
    `Session communication: ${status.enabled === true ? "enabled" : "not enabled"} · ${preview(status.status)}`,
    `Exact runtime: machine=${visibleText(text(peer.machineId))} session=${visibleText(text(peer.sessionId))} nonce=${visibleText(text(peer.runtimeNonce))}`,
    `Scopes: ${
      items(status.scopes)
        .slice(0, 4)
        .map((scope) => preview(scope))
        .join(", ") || "none"
    } · watch=${status.watching === true ? "active" : "off"}`,
    `Inbox: ${text(status.inboxMessages, "0")} messages / ${text(status.inboxBytes, "0")} bytes · receipts=${text(status.receipts, "0")} · operations=${text(status.operations, "0")}`,
    `Publications: ${text(status.publications, "0")} / ${text(status.publicationBytes, "0")} bytes · revision=${text(status.revision, "0")} · interests=${text(status.interests, "0")} · relations=${text(status.relations, "0")}`,
    `Wake notice: ${preview(status.notice)} · inbox admission does not imply reading or work completion.`,
  ].join("\n");
}
