import type {
  AgentToolResult,
  KeybindingHints,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Option, Schema } from "effect";
import type { PeerRef } from "../protocol/schema.js";
import { visibleText } from "./config.js";
import type { LinkState } from "./links.js";

const UNCERTAIN =
  "UNKNOWN — Delivery uncertain; may already be in peer inbox. Do not resend as new.";

const decodePayload = Schema.decodeUnknownOption(Schema.Json);
const isFields = Schema.is(Schema.JsonObject);
const isItems = Schema.is(Schema.Array(Schema.Json));
const isString = Schema.is(Schema.String);
const isText = Schema.is(Schema.Union([Schema.String, Schema.Number]));

function fields(value: Schema.Json | undefined): Schema.JsonObject {
  return isFields(value) ? value : {};
}

function items(value: Schema.Json | undefined): ReadonlyArray<Schema.Json> {
  return isItems(value) ? value : [];
}

function text(value: Schema.Json | undefined, fallback = "…"): string {
  return isText(value) ? String(value) : fallback;
}

function preview(value: Schema.Json | undefined, fallback = "…"): string {
  return truncateToWidth(visibleText(text(value, fallback)).replaceAll(/\s+/gu, " "), 96);
}

function listing(
  values: ReadonlyArray<Schema.Json>,
  render: (value: Schema.Json) => string,
): Array<string> {
  return [
    ...values.slice(0, 3).map((value) => render(value)),
    ...(values.length > 3 ? [`… ${values.length - 3} more (expand)`] : []),
  ];
}

function delivery(value: Schema.Json | undefined): string {
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

function callSummary(name: string, args: Schema.JsonObject): string {
  switch (name) {
    case "peers_send": {
      return `→ ${preview(args.to)} · ${preview(args.kind)} · ${preview(args.content)}`;
    }

    case "peers_take": {
      return `← inbox · up to ${preview(args.limit, "4")} messages`;
    }

    default: {
      return `List peers${args.scope === undefined ? "" : ` · scope ${preview(args.scope)}`}`;
    }
  }
}

function resultSummary(name: string, raw: Schema.Json | undefined): Array<string> {
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
          const taken = fields(entry);

          return `← ${preview(taken.from)} · ${preview(taken.kind)} · ${preview(taken.content)}`;
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
          const listed = fields(entry);
          const marks = `${listed.self === true ? " (you)" : ""}${listed.restarted === true ? " (restarted)" : ""}`;

          return `${preview(listed.handle)}${marks}${listed.label === undefined ? "" : ` · label (authored): ${preview(listed.label)}`}`;
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

function full(value: Schema.Json | RenderPayload | undefined): string {
  return visibleText(JSON.stringify(value, null, 2) ?? "No payload");
}

function hasHiddenPreview(
  summary: Array<string>,
  raw: Schema.Json | undefined,
  args: Schema.JsonObject,
): boolean {
  const result = fields(raw);
  const value = result.tag === "ok" ? fields(result.value) : result;
  const previews = [args.content, ...items(value.messages).map((entry) => fields(entry).content)];

  return (
    summary.some((line) => line.includes("more (expand)")) ||
    previews.some((entry) => isString(entry) && visibleWidth(visibleText(entry)) > 96)
  );
}

export type RenderPayload = Partial<
  Pick<AgentToolResult<{ value?: Schema.Json }>, "details" | "content">
>;

export type RenderContext = Pick<KeybindingHints, "keyHint"> & {
  readonly args: Schema.Json | undefined;
  readonly expanded: boolean;
  readonly isError: boolean;
};

export function toolPresentation(name: string) {
  return {
    renderCall(args: Schema.Json | undefined, theme: Pick<Theme, "fg">, context: RenderContext) {
      const payload = Option.getOrUndefined(decodePayload(args));
      const summary = `${name} ${callSummary(name, fields(payload))}`;

      return component(
        theme.fg("toolTitle", summary) + (context.expanded ? `\n${full(payload)}` : ""),
        context.expanded,
      );
    },
    renderResult(
      result: RenderPayload | undefined,
      options: ToolRenderResultOptions,
      theme: Pick<Theme, "fg">,
      context: RenderContext,
    ) {
      const raw = Option.getOrUndefined(decodePayload(result?.details?.value));

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
          ...(result?.content ?? []).flatMap((part) =>
            part.type === "text" ? [preview(part.text)] : [],
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

      const hint = hasHiddenPreview(
        summary,
        raw,
        fields(Option.getOrUndefined(decodePayload(context.args))),
      )
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

const ACTIVATION_PENDING_DETAILS: ReadonlyArray<string> = [
  "Saved but not active yet. Passive reconnect never restarts a gateway; nothing is resent.",
  "/peers setup, then Activate saved configuration, restarts it once.",
  "Existing sessions may still use old trust.",
];

export type StatusSnapshot = {
  readonly enabled?: boolean;
  readonly status?: string;
  readonly peer?: PeerRef;
  readonly scopes?: ReadonlyArray<string>;
  readonly watching?: boolean;
  readonly inboxMessages?: number;
  readonly inboxBytes?: number;
  readonly receipts?: number;
  readonly operations?: number;
  readonly relations?: number;
  readonly notice?: string;
  readonly waiting?: boolean;
  readonly links?: ReadonlyArray<LinkState>;
};

export function diagnostics(status: StatusSnapshot | undefined, diagnostic: string): string {
  if (status === undefined) {
    const reason =
      diagnostic === "enabled" ? "runtime unavailable" : diagnostic.replace(/^not enabled\s*/u, "");

    return `Session communication: not enabled${reason.length > 0 ? ` · ${visibleText(reason)}` : ""}`;
  }

  const { peer } = status;

  return [
    `Session communication: ${status.enabled === true ? "enabled" : "not enabled"} · ${preview(status.status)}`,
    ...(status.status === "activation_pending" || status.status === "activation_unconfirmed"
      ? ACTIVATION_PENDING_DETAILS
      : []),
    `Exact runtime: machine=${visibleText(text(peer?.machineId))} session=${visibleText(text(peer?.sessionId))} nonce=${visibleText(text(peer?.runtimeNonce))}`,
    `Scopes: ${
      (status.scopes ?? [])
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
  readonly rows: Array<[label: string, value: string]>;
  readonly next?: string;
  readonly technical: Array<string>;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function plain(value: string | undefined, limit = 64): string {
  const flat = visibleText(text(value, "")).replaceAll(/\s+/gu, " ").trim();
  const characters = Array.from(graphemes.segment(flat), (part) => part.segment);

  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : flat;
}

function tally(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function plural(amount: number, one: string, many: string): string {
  return `${amount} ${amount === 1 ? one : many}`;
}

function runtimeTechnical(status: StatusSnapshot): Array<string> {
  const { peer } = status;
  const notice = text(status.notice, "none");

  return [
    `Runtime status: ${plain(status.status, 96) || "unknown"}`,
    `Exact runtime: machine=${plain(peer?.machineId, 96)} session=${plain(peer?.sessionId, 96)} nonce=${plain(peer?.runtimeNonce, 96)}`,
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
  status: StatusSnapshot | undefined,
  diagnostic: string,
  options: PresentationOptions = {},
): StatusSummary {
  if (status === undefined) {
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

  const machine = plain(status.peer?.machineId) || "this machine";

  const scopes = (status.scopes ?? [])
    .slice(0, 4)
    .map((scope) => plain(scope))
    .filter((scope) => scope.length > 0);

  const inbox = tally(status.inboxMessages);

  const rows: Array<[string, string]> = [
    ["Machine", machine],
    ["Scopes", scopes.join(", ") || "none"],
    [
      "Peers seen",
      status.watching === true ? "Watching for other sessions" : "Unknown — not watching",
    ],
    ["Inbox", inbox === 0 ? "Empty" : `${plural(inbox, "message", "messages")} waiting`],
    ...linkRows(status.links),
  ];

  return liveSummary(
    text(status.status, "disconnected"),
    { machine, scopes, rows, technical },
    options,
  );
}

const LINK_WORDS: Record<LinkState["state"], string> = {
  up: "Up",
  down: "Down — sends to it fail at once; the gateway keeps retrying",
  probing: "Reconnecting",
};

function clock(value: number | undefined): string {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? new Date(value).toISOString().slice(11, 19)
    : "";
}

function linkRows(value: ReadonlyArray<LinkState> = []): Array<[string, string]> {
  return value.flatMap((link) => {
    const machine = plain(link.machineId, 32);
    const word = LINK_WORDS[link.state];

    if (machine.length === 0) {
      return [];
    }

    const since = clock(link.since);
    const next = clock(link.nextProbe);

    const detail = [
      ...(since.length > 0 ? [`since ${since} UTC`] : []),
      ...(next.length > 0 ? [`next try ${next} UTC`] : []),
    ];

    const row: [string, string] = [
      `Link to ${machine}`,
      detail.length === 0 ? word : `${word} (${detail.join(", ")})`,
    ];

    return [row];
  });
}

type LiveFacts = {
  readonly machine: string;
  readonly scopes: ReadonlyArray<string>;
  readonly rows: Array<[string, string]>;
  readonly technical: Array<string>;
};

function liveSummary(code: string, facts: LiveFacts, options: PresentationOptions): StatusSummary {
  if (code === "connected") {
    return connectedSummary(facts);
  }

  if (code === "activation_pending" || code === "activation_unconfirmed") {
    return pendingSummary(code === "activation_pending", facts, options);
  }

  if (code === "gateway_outdated") {
    return {
      state: "unavailable",
      headline: "The running gateway is an older version",
      rows: facts.rows,
      next: setupStep(options, "to restart it"),
      technical: facts.technical,
    };
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

export type FooterTone = "dim" | "success" | "accent" | "muted" | "warning" | "error";

export type FooterTheme = { fg: (color: FooterTone, text: string) => string };

export type FooterState =
  | "connected"
  | "waiting"
  | "setting_up"
  | "activation_pending"
  | "offline"
  | "setup_failed";

const FOOTER_PARTS: Record<FooterState, ReadonlyArray<readonly [FooterTone, string]>> = {
  connected: [["success", "✓"]],
  waiting: [
    ["success", "✓"],
    ["muted", " waiting…"],
  ],
  setting_up: [["muted", "⋯ setting up"]],
  activation_pending: [["warning", "! activation pending"]],
  offline: [["warning", "✕ offline"]],
  setup_failed: [["error", "✕ setup failed"]],
};

function styled(parts: ReadonlyArray<readonly [FooterTone, string]>, theme?: FooterTheme): string {
  return [["dim", "peers "] as const, ...parts]
    .map(([tone, part]) => (theme === undefined ? part : theme.fg(tone, part)))
    .join("");
}

export function footerLine(state: FooterState, theme?: FooterTheme): string {
  return styled(FOOTER_PARTS[state], theme);
}

function downLinks(value: ReadonlyArray<LinkState> = []): Array<readonly [FooterTone, string]> {
  const down = value.flatMap((link) => {
    if (link.state === "down" || link.state === "probing") {
      const machine = plain(link.machineId, 32);

      return machine.length > 0 ? [machine] : [];
    }

    return [];
  });

  if (down.length === 0) {
    return [];
  }

  const [only] = down;

  return [["warning", down.length === 1 ? ` ! ${only} down` : ` ! ${down.length} links down`]];
}

export function footerStatus(
  status: StatusSnapshot | undefined,
  configured: boolean,
  theme?: FooterTheme,
): string | undefined {
  if (!configured) {
    return undefined;
  }

  if (status === undefined) {
    return footerLine("setup_failed", theme);
  }

  const code = status.status;

  if (code === "connected") {
    const unread = tally(status.inboxMessages);

    const base =
      unread > 0
        ? [["accent", `● ${unread}`] as const]
        : FOOTER_PARTS[status.waiting === true ? "waiting" : "connected"];

    return styled([...base, ...downLinks(status.links)], theme);
  }

  return footerLine(
    code === "activation_pending" || code === "activation_unconfirmed"
      ? "activation_pending"
      : "offline",
    theme,
  );
}
