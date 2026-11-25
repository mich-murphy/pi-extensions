import { appendEvent, LAYERS, readLedger } from "./ledger.ts";
import type { LedgerRead } from "./ledger.ts";
import { deriveGroups } from "./queue.ts";
import type { Group } from "./queue.ts";

export type CliIo = {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly ledger: string;
};

type Layer = (typeof LAYERS)[number];

const USAGE = `Usage:
  pi-feedback queue [--all] [--json] [ledger.jsonl ...]
  pi-feedback resolve <group> <commit> <${LAYERS.join("|")}>
  pi-feedback reopen <group> <reason>
`;

const HEADER = ["READY", "RANK", "SESSIONS", "RECORDS", "STATUS", "OWNER", "GROUP", "EXAMPLE"];
const QUEUE_OPTIONS: ReadonlySet<string> = new Set(["--all", "--json"]);

function isLayer(value: string | undefined): value is Layer {
  return LAYERS.some((layer) => layer === value);
}

async function readAll(files: readonly string[]): Promise<LedgerRead> {
  const reads = await Promise.all(files.map(async (file) => readLedger(file)));
  return {
    events: reads.flatMap((read) => read.events),
    skipped: reads.reduce((total, read) => total + read.skipped, 0),
  };
}

function row(group: Group): string[] {
  return [
    group.ready ? "yes" : "no",
    String(group.rank),
    String(group.sessions),
    String(group.records),
    group.status,
    group.piCore ? "pi-core" : group.owner,
    group.id,
    group.example,
  ];
}

function formatGroups(groups: readonly Group[]): string {
  if (groups.length === 0) {
    return "No open groups.\n";
  }
  const rows = [HEADER, ...groups.map((group) => row(group))];
  const widths = HEADER.map((_, column) =>
    Math.max(...rows.map((cells) => cells[column]?.length ?? 0)),
  );
  const last = HEADER.length - 1;
  const lines = rows.map((cells) =>
    cells
      .map((cell, column) => (column === last ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  "),
  );
  return `${lines.join("\n")}\n`;
}

async function queue(args: readonly string[], io: CliIo): Promise<number> {
  const options = new Set(args.filter((arg) => arg.startsWith("--")));
  const unknown = [...options].find((option) => !QUEUE_OPTIONS.has(option));
  if (unknown !== undefined) {
    io.err(`Unknown option ${unknown}.\n${USAGE}`);
    return 2;
  }
  const files = args.filter((arg) => !arg.startsWith("--"));
  const { events, skipped } = await readAll(files.length > 0 ? files : [io.ledger]);
  if (skipped > 0) {
    io.err(`Skipped ${skipped} unreadable ledger lines.\n`);
  }
  const groups = deriveGroups(events).filter(
    (group) => options.has("--all") || group.status !== "resolved",
  );
  io.out(options.has("--json") ? `${JSON.stringify(groups, null, 2)}\n` : formatGroups(groups));
  return 0;
}

async function knownGroup(io: CliIo, group: string): Promise<boolean> {
  const { events } = await readLedger(io.ledger);
  if (deriveGroups(events).some((known) => known.id === group)) {
    return true;
  }
  io.err(`No group ${group} in ${io.ledger}.\n`);
  return false;
}

async function resolve(args: readonly string[], io: CliIo): Promise<number> {
  const [group, commit, layer, ...extra] = args;
  if (group === undefined || commit === undefined || !isLayer(layer) || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  if (!(await knownGroup(io, group))) {
    return 1;
  }
  await appendEvent(io.ledger, { type: "resolve", group, commit, layer });
  io.out(`Resolved ${group} with ${commit} (${layer}).\n`);
  return 0;
}

async function reopen(args: readonly string[], io: CliIo): Promise<number> {
  const [group, ...words] = args;
  const reason = words.join(" ").trim();
  if (group === undefined || reason === "") {
    io.err(USAGE);
    return 2;
  }
  if (!(await knownGroup(io, group))) {
    return 1;
  }
  await appendEvent(io.ledger, { type: "reopen", group, reason });
  io.out(`Reopened ${group}.\n`);
  return 0;
}

const COMMANDS = new Map(Object.entries({ queue, resolve, reopen }));

export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
  const [command = "help", ...rest] = args;
  const run = COMMANDS.get(command);
  if (run === undefined) {
    const asked = command === "help" || command === "--help";
    (asked ? io.out : io.err)(USAGE);
    return asked ? 0 : 2;
  }
  try {
    return await run(rest, io);
  } catch (error) {
    if (error instanceof TypeError) {
      io.err(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
}
