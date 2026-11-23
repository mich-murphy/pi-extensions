import type { PeerRef } from "../../protocol/schema.js";

export const SCOPE = "team";
export const LOCAL_MACHINE = "alpha";
export const MACHINES = ["beta", "gamma", "delta", "epsilon", "zeta", "eta"] as const;
export const ROSTER_ONLY_MACHINE_WITHOUT_POLICY = "omega";

export function peerRef(machine: string): PeerRef {
  const nonce = Buffer.from(machine).toString("hex").padEnd(32, "0").slice(0, 32);
  return { machineId: machine, sessionId: `peer-${machine}`, runtimeNonce: nonce };
}

type SyntheticPublication = {
  revision: number;
  category: "context" | "finding" | "plan";
  title: string;
  summary: string;
  content: string;
};
const padding = (seed: string) =>
  Array.from({ length: 36 }, (_, i) => `build-log ${seed} step ${i}: ok (synthetic filler)`).join(
    "\n",
  );
function pub(
  key: string,
  revision: number,
  ticket: string,
  category: SyntheticPublication["category"] = "finding",
): [string, SyntheticPublication] {
  return [
    key,
    {
      revision,
      category,
      title: `${key} for ${ticket}`,
      summary: `${key} r${revision}`,
      content: `TICKET: ${ticket}\n${padding(`${ticket}-${key}`)}`,
    },
  ];
}
export const PUBLICATIONS: Record<string, Record<string, ReturnType<typeof pub>[1]>> = {
  beta: Object.fromEntries([pub("handoff", 3, "T-301"), pub("notes", 1, "N-1", "context")]),
  gamma: Object.fromEntries([pub("handoff", 1, "T-102"), pub("notes", 2, "N-2", "context")]),
  delta: Object.fromEntries([pub("handoff", 2, "T-217"), pub("plan", 4, "P-4", "plan")]),
  epsilon: Object.fromEntries([pub("handoff", 5, "T-540"), pub("notes", 1, "N-3", "context")]),
  zeta: Object.fromEntries([pub("notes", 1, "N-4", "context")]),
  eta: Object.fromEntries([pub("handoff", 2, "T-225"), pub("notes", 3, "N-5", "context")]),
  [ROSTER_ONLY_MACHINE_WITHOUT_POLICY]: Object.fromEntries([pub("handoff", 9, "T-999")]),
};

export type Fault = "no_route" | "unavailable" | "hang" | "unknown";
export type Scenario = { id: string; faults: Record<string, Fault> };
export const SCENARIOS: Record<string, Scenario> = {
  aggregate: { id: "aggregate", faults: {} },
  single_read: { id: "single_read", faults: {} },
  partial_failure: {
    id: "partial_failure",
    faults: { "state.list:peer-zeta": "no_route", "state.get:peer-delta": "unavailable" },
  },
  unknown_send: { id: "unknown_send", faults: { "send:peer-beta": "unknown" } },
  pending_cancel: { id: "pending_cancel", faults: { "state.list:peer-beta": "hang" } },
};

export type Task = { id: string; prompt: string; expected: unknown };
const aggregateExpected = {
  selected: MACHINES.flatMap((machine) => {
    const handoff = PUBLICATIONS[machine]?.handoff;
    return handoff !== undefined && handoff.revision >= 2
      ? [
          {
            publisher: `peer-${machine}`,
            key: "handoff",
            revision: handoff.revision,
            ticket: handoff.content.split("\n")[0]?.slice("TICKET: ".length),
          },
        ]
      : [];
  }).toSorted((a, b) => a.publisher.localeCompare(b.publisher)),
};
const betaHandoff = PUBLICATIONS.beta?.handoff;
export const TASKS: Task[] = [
  {
    id: "aggregate",
    prompt:
      `Use the session communication tools. Find every live peer in scope "${SCOPE}". ` +
      `For each peer, list its publications, then read only a publication with key "handoff" whose current revision is at least 2. ` +
      `Do not read any other publication. The ticket is the value on the line of its content that starts with "TICKET: ". ` +
      `Reply with only this JSON object, no code fence: {"selected":[{"publisher":<sessionId>,"key":"handoff","revision":<n>,"ticket":"<ticket>"}]} ` +
      `sorted by publisher sessionId.`,
    expected: aggregateExpected,
  },
  {
    id: "single_read",
    prompt:
      `Use the session communication tools. Read the publication with key "handoff" revision ${betaHandoff?.revision} in scope "${SCOPE}" ` +
      `from this exact publisher: ${JSON.stringify(peerRef("beta"))}. Do not discover or read anything else. ` +
      `Reply with only this JSON object, no code fence: {"ticket":"<ticket>"} where the ticket is the value on the line of its content that starts with "TICKET: ".`,
    expected: { ticket: "T-301" },
  },
];

export const EXPECTED_READS: Record<string, string[]> = {
  aggregate: aggregateExpected.selected.map((s) => `${s.publisher}:${s.key}:${s.revision}`),
  single_read: [`peer-beta:handoff:${betaHandoff?.revision}`],
};
export const EXPECTED_OPS: Record<string, number> = { aggregate: 11, single_read: 1 };
