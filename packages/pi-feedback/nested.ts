import type {
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import type { BatchCall } from "./batch.ts";

const MAX_PARENTS = 64;
const MAX_CALLS = 256;

type Tracked = { readonly call: BatchCall; readonly started: number; ended: number | undefined };

type Scope = { readonly calls: Map<string, Tracked>; failed: boolean };

export type NestedEnd = {
  readonly suppressed: boolean;
  readonly batch: readonly BatchCall[] | undefined;
};

const decodeArgs = Schema.decodeUnknownOption(Schema.JsonObject);

function overlapped(failing: Tracked, sibling: Tracked): boolean {
  const failingEnded = failing.ended ?? Number.POSITIVE_INFINITY;
  const siblingEnded = sibling.ended ?? Number.POSITIVE_INFINITY;

  return sibling.started < failingEnded && siblingEnded > failing.started;
}

export function createNestedTracker() {
  const scopes = new Map<string, Scope>();
  let tick = 0;

  const scopeOf = (parent: string): Scope => {
    const existing = scopes.get(parent);

    if (existing !== undefined) {
      return existing;
    }

    const scope: Scope = { calls: new Map(), failed: false };
    scopes.set(parent, scope);
    const [oldest] = scopes.keys();

    if (scopes.size > MAX_PARENTS && oldest !== undefined) {
      scopes.delete(oldest);
    }

    return scope;
  };

  const start = (
    event: Pick<ToolExecutionStartEvent, "toolCallId" | "toolName" | "args" | "parentToolCallId">,
  ): void => {
    tick += 1;

    if (event.parentToolCallId === undefined) {
      return;
    }

    const scope = scopeOf(event.parentToolCallId);

    if (scope.calls.size < MAX_CALLS) {
      const args = Option.getOrElse(decodeArgs(event.args), () => ({}));
      const call: BatchCall = { id: event.toolCallId, name: event.toolName, args };
      scope.calls.set(event.toolCallId, { call, started: tick, ended: undefined });
    }
  };

  const end = (
    event: Pick<ToolExecutionEndEvent, "toolCallId" | "isError" | "parentToolCallId">,
  ): NestedEnd => {
    tick += 1;
    const suppressed = scopes.get(event.toolCallId)?.failed === true;
    scopes.delete(event.toolCallId);

    if (event.parentToolCallId === undefined) {
      return { suppressed, batch: undefined };
    }

    const scope = scopeOf(event.parentToolCallId);
    scope.failed ||= event.isError;
    const failing = scope.calls.get(event.toolCallId);

    if (failing === undefined) {
      return { suppressed, batch: [] };
    }

    failing.ended = tick;

    const batch = [...scope.calls.values()].flatMap((sibling) =>
      overlapped(failing, sibling) ? [sibling.call] : [],
    );

    return { suppressed, batch };
  };

  return { start, end };
}
