const STATUS = "Ask the user to run `/peers status`.";

const busy: Record<string, string> = {
  inbox:
    "Their inbox is full. Do not retry in a loop; wait for them to reply or catch up, then send once.",
  receipts: "The receiver is tracking too many messages; try again later.",
  relations: "The receiver is tracking too many messages; try again later.",
  operations: "This session is busy with other peer requests; retry once.",
};

const reasons: Record<string, string> = {
  forbidden: "The peers configuration does not allow this. Do not retry.",
  no_route:
    "That session runtime is not reachable now: it may have restarted or closed. Call peers_list; if the session is listed again, use its entry.",
  link_down:
    "The link to that machine is down; the session may still exist. Try later, or wait for replies with peers_take and waitSeconds.",
  unavailable: `Peers is not connected, or that scope is not available to this session. ${STATUS}`,
  protocol_error: `The peers gateway sent an invalid reply. ${STATUS}`,
  cancelled: "The request was cancelled.",
  invalid_input:
    "The arguments were rejected before anything was sent. Check them and the configured scopes.",
  delivery_too_large: "The message is too large. Shorten it and send again.",
  expired:
    "It ran out of time on the way and was dropped before reaching their inbox. Try again once.",
  invalid_correlation: "replyTo does not match a message from that session runtime.",
  id_conflict: "Internal error: message id conflict. Report this to the user.",
};

export function failureHint(code: string, resource?: string): string {
  if (code === "overloaded") {
    return busy[resource ?? "operations"] ?? "The receiver is overloaded; try again later.";
  }
  return reasons[code] ?? `The request failed (${code}).`;
}

export type HintOutcome = {
  tag: string;
  code?: string;
  resource?: string;
};
const SAFE = new Set(["no_route", "link_down", "expired"]);
export function sendHint(outcome: HintOutcome, machine?: string): string {
  if (outcome.tag === "admitted") {
    return "Delivered to their inbox; not yet read, accepted or done.";
  }
  if (outcome.tag === "unknown") {
    return "It may have arrived. Do not send it as a new message. To retry within 8 minutes, repeat the call unchanged with retryOf set to this id.";
  }
  if (outcome.code === "link_down") {
    const link = machine === undefined ? "The link to that machine" : `The link to ${machine}`;
    return `Not delivered. ${link} is down; the session may still exist. Sending again cannot duplicate it; try later, or wait for replies with peers_take and waitSeconds.`;
  }
  const hint = failureHint(outcome.code ?? "unavailable", outcome.resource);
  return SAFE.has(outcome.code ?? "")
    ? `Not delivered. ${hint} Sending again cannot duplicate it.`
    : `Not delivered. ${hint}`;
}
