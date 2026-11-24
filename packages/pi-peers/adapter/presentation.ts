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
    case "peers_send": {
      const message = fields(args.message);
      return `→ ${identity(args.to)} · ${preview(message.kind)} · ${preview(message.content)}`;
    }
    case "peers_take": {
      return `← inbox · up to ${preview(args.limit, "4")} messages`;
    }
    default: {
      return `Discover peers${args.watch === true ? " · watch" : ""}`;
    }
  }
}
function resultSummary(name: string, raw: unknown): string[] {
  const result = fields(raw);
  if (result.tag === "error") {
    return [
      `Failed · ${preview(result.code)}${result.resource === undefined ? "" : ` · ${preview(result.resource)}`}`,
    ];
  }
  if (name === "peers_send") {
    return [delivery(result.outcome)];
  }
  const value = result.tag === "ok" ? fields(result.value) : result;
  switch (name) {
    case "peers_take": {
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
    case "peers_list": {
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
    default: {
      return ["Result unavailable"];
    }
  }
}

function component(content: string, expanded: boolean, primary = ""): Text {
  const output = new Text(content, 0, 0);
  const render = output.render.bind(output);
  output.render = (width) => {
    if (width < 1) {
      return [];
    }
    const lines = render(width).map((line) => truncateToWidth(line, width, ""));
    if (expanded) {
      return lines;
    }
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
        : resultSummary(name, raw);
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
      if (summary.some((line) => line.startsWith("UNKNOWN") || line.startsWith("Not added"))) {
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
        summary.slice(0, 1).join("\n"),
      );
    },
  };
}

const ACTIVATION_PENDING_DETAILS: readonly string[] = [
  "Saved but not active yet. Passive reconnect never restarts a gateway; nothing is resent.",
  "/peers setup, then Activate saved configuration, restarts it once.",
  "Existing sessions may still use old trust.",
];
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
    ...(status.status === "activation_pending" || status.status === "activation_unconfirmed"
      ? ACTIVATION_PENDING_DETAILS
      : []),
    `Exact runtime: machine=${visibleText(text(peer.machineId))} session=${visibleText(text(peer.sessionId))} nonce=${visibleText(text(peer.runtimeNonce))}`,
    `Scopes: ${
      items(status.scopes)
        .slice(0, 4)
        .map((scope) => preview(scope))
        .join(", ") || "none"
    } · watch=${status.watching === true ? "active" : "off"}`,
    `Inbox: ${text(status.inboxMessages, "0")} messages / ${text(status.inboxBytes, "0")} bytes · receipts=${text(status.receipts, "0")} · operations=${text(status.operations, "0")} · relations=${text(status.relations, "0")}`,
    `Wake notice: ${preview(status.notice)} · inbox admission does not imply reading or work completion.`,
  ].join("\n");
}

export type StatusState = "off" | "connected" | "pending" | "unavailable" | "failed";
export type StatusSummary = {
  readonly state: StatusState;
  readonly headline: string;
  readonly rows: [label: string, value: string][];
  readonly next?: string;
  readonly technical: string[];
};
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function plain(value: unknown, limit = 64): string {
  const flat = visibleText(text(value, "")).replaceAll(/\s+/gu, " ").trim();
  const characters = Array.from(graphemes.segment(flat), (part) => part.segment);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : flat;
}
function tally(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function plural(amount: number, one: string, many: string): string {
  return `${amount} ${amount === 1 ? one : many}`;
}
function runtimeTechnical(status: Fields): string[] {
  const peer = fields(status.peer);
  const notice = text(status.notice, "none");
  return [
    `Runtime status: ${plain(status.status, 96) || "unknown"}`,
    `Exact runtime: machine=${plain(peer.machineId, 96)} session=${plain(peer.sessionId, 96)} nonce=${plain(peer.runtimeNonce, 96)}`,
    `Inbox: ${tally(status.inboxMessages)} messages / ${tally(status.inboxBytes)} bytes · receipts=${tally(status.receipts)} · operations=${tally(status.operations)} · relations=${tally(status.relations)}`,
    `Wake notice: ${plain(notice, 96)} · inbox admission does not imply reading or work completion.`,
  ];
}
export type PresentationOptions = { readonly inMenu?: boolean };
function setupStep(options: PresentationOptions, purpose: string): string {
  return options.inMenu === true ? `Choose Setup ${purpose}.` : `Run /peers setup ${purpose}.`;
}
function offline(diagnostic: string, options: PresentationOptions): StatusSummary {
  const technical = [`Diagnostic: ${plain(diagnostic, 400) || "none"}`];
  if (diagnostic === "enabled") {
    return {
      state: "unavailable",
      headline: "Peers is unavailable in this session",
      rows: [],
      next: "Run /peers reconnect. If that fails, run /peers doctor.",
      technical,
    };
  }
  if (diagnostic.includes("failed")) {
    return {
      state: "failed",
      headline: "Peers could not start in this session",
      rows: [],
      next: "Run /peers doctor to see what to fix, then /peers reconnect.",
      technical,
    };
  }
  if (diagnostic === "participation disabled") {
    return {
      state: "off",
      headline: "Peers is turned off",
      rows: [],
      next: setupStep(options, "to turn it back on"),
      technical,
    };
  }
  return {
    state: "off",
    headline: "Peers is not set up",
    rows: [],
    next: setupStep(options, "to connect this session to others"),
    technical,
  };
}
export function statusSummary(
  status: unknown,
  diagnostic: string,
  options: PresentationOptions = {},
): StatusSummary {
  if (!isFields(status)) {
    return offline(diagnostic, options);
  }
  const technical = runtimeTechnical(status);
  if (status.enabled === false) {
    return {
      state: "off",
      headline: "Peers is turned off",
      rows: [],
      next: setupStep(options, "to turn it back on"),
      technical,
    };
  }
  const machine = plain(fields(status.peer).machineId) || "this machine";
  const scopes = items(status.scopes)
    .slice(0, 4)
    .map((scope) => plain(scope))
    .filter((scope) => scope.length > 0);
  const inbox = tally(status.inboxMessages);
  const rows: [string, string][] = [
    ["Machine", machine],
    ["Scopes", scopes.join(", ") || "none"],
    [
      "Peers seen",
      status.watching === true ? "Watching for other sessions" : "Unknown — not watching",
    ],
    ["Inbox", inbox === 0 ? "Empty" : `${plural(inbox, "message", "messages")} waiting`],
  ];
  return liveSummary(
    text(status.status, "disconnected"),
    { machine, scopes, rows, technical },
    options,
  );
}
type LiveFacts = {
  readonly machine: string;
  readonly scopes: readonly string[];
  readonly rows: [string, string][];
  readonly technical: string[];
};
function liveSummary(code: string, facts: LiveFacts, options: PresentationOptions): StatusSummary {
  if (code === "connected") {
    return connectedSummary(facts);
  }
  if (code === "activation_pending" || code === "activation_unconfirmed") {
    return pendingSummary(code === "activation_pending", facts, options);
  }
  return {
    state: "unavailable",
    headline: "Peers is unavailable right now",
    rows: facts.rows,
    next: "Run /peers reconnect. If it keeps failing, run /peers doctor.",
    technical: facts.technical,
  };
}
function connectedSummary({ machine, scopes, rows, technical }: LiveFacts): StatusSummary {
  const scopeText =
    scopes.length === 0
      ? ""
      : ` · ${scopes.length === 1 ? "scope" : "scopes"} ${scopes.join(", ")}`;
  return {
    state: "connected",
    headline: `Connected as ${machine}${scopeText}`,
    rows,
    next: "Open another Pi session to collaborate.",
    technical,
  };
}
function pendingSummary(
  waiting: boolean,
  { rows, technical }: LiveFacts,
  options: PresentationOptions,
): StatusSummary {
  return {
    state: "pending",
    headline: waiting
      ? "Settings saved · waiting for the gateway to restart"
      : "Settings saved · not yet confirmed by the gateway",
    rows,
    next: waiting
      ? setupStep(options, "and then Activate saved configuration")
      : `Run /peers reconnect. If it still waits, ${setupStep(options, "to activate").replace(/^./u, (first) => first.toLowerCase())}`,
    technical: [...technical, ...ACTIVATION_PENDING_DETAILS],
  };
}
export function statusText(summary: StatusSummary): string {
  return [
    summary.headline,
    ...summary.rows.map(([label, value]) => `${label}: ${value}`),
    ...(summary.next === undefined ? [] : [`Next: ${summary.next}`]),
    ...(summary.technical.length === 0
      ? []
      : ["Technical details:", ...summary.technical.map((line) => `  ${line}`)]),
  ].join("\n");
}
export function footerStatus(status: unknown, configured: boolean): string | undefined {
  if (!configured) {
    return undefined;
  }
  if (!isFields(status)) {
    return "Peers: setup failed";
  }
  const code = fields(status).status;
  if (code === "connected") {
    return "Peers: connected";
  }
  return code === "activation_pending" || code === "activation_unconfirmed"
    ? "Peers: activation pending"
    : "Peers: unavailable";
}
