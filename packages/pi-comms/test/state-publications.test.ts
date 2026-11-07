import { describe, expect, test } from "vitest";
import { createState } from "../state/core.js";
import type { PublicationRecord } from "../state/types.js";

const peer = { machineId: "alpha", sessionId: "session", runtimeNonce: "a".repeat(32) };
const record: PublicationRecord = {
  category: "context",
  title: "Title",
  summary: "Summary",
  format: "text",
  preparation: "authored",
};
function harness(publications = 16, publicationBytes = 524_288) {
  let allowed = true;
  const state = createState({
    peer,
    scopeIds: ["team", "other"],
    clock: () => 0,
    authorize: () => allowed,
    offer: () => true,
    limits: { publications, publicationBytes },
  });
  return {
    state,
    policy: (value: boolean) => {
      allowed = value;
    },
  };
}

describe("adapter current publications and monotonic revisions", () => {
  test("put/remove including absent removal advance one lifetime counter across scoped keys", () => {
    const { state } = harness();
    expect(state.publish({ scopeId: "team", key: "same", record })).toMatchObject({
      tag: "ok",
      value: { key: "same", revision: 1 },
    });
    expect(state.publish({ scopeId: "other", key: "same", record })).toMatchObject({
      tag: "ok",
      value: { revision: 2 },
    });
    expect(state.remove({ scopeId: "team", key: "absent" })).toStrictEqual({
      tag: "ok",
      value: { key: "absent", revision: 3, removed: false },
    });
    expect(state.remove({ scopeId: "team", key: "same" })).toMatchObject({
      tag: "ok",
      value: { revision: 4, removed: true },
    });
    expect(state.publish({ scopeId: "team", key: "same", record })).toMatchObject({
      tag: "ok",
      value: { revision: 5 },
    });
    expect(state.read({ caller: peer, scopeId: "other", key: "same" })).toMatchObject({
      tag: "ok",
      value: { publication: { revision: 2 } },
    });
  });

  test("expected revision reads never substitute a newer record or retain history", () => {
    const { state } = harness();
    state.publish({ scopeId: "team", key: "key", record });
    state.publish({ scopeId: "team", key: "key", record: { ...record, summary: "new" } });
    expect(
      state.read({ caller: peer, scopeId: "team", key: "key", expectedRevision: 1 }),
    ).toStrictEqual({ tag: "error", code: "revision_mismatch" });
    state.remove({ scopeId: "team", key: "key" });
    expect(state.read({ caller: peer, scopeId: "team", key: "key" })).toStrictEqual({
      tag: "error",
      code: "not_found",
    });
  });

  test("replacement refusal preserves old record and revision", () => {
    const { state } = harness();
    state.publish({ scopeId: "team", key: "key", record });
    expect(
      state.publish({
        scopeId: "team",
        key: "key",
        record: { ...record, content: "\u0001".repeat(24_560) },
      }),
    ).toStrictEqual({ tag: "error", code: "publication_too_large" });
    expect(state.read({ caller: peer, scopeId: "team", key: "key" })).toMatchObject({
      tag: "ok",
      value: { publication: { revision: 1, summary: "Summary" } },
    });
    expect(state.stats().revision).toBe(1);
  });

  test.each([
    { count: 0, bytes: 524_288 },
    { count: 16, bytes: 1 },
  ])("count and byte caps reject without publication: %#", ({ count, bytes }) => {
    const { state } = harness(count, bytes);
    expect(state.publish({ scopeId: "team", key: "key", record })).toStrictEqual({
      tag: "error",
      code: "overloaded",
      resource: "publications",
    });
    expect(state.stats()).toMatchObject({ publications: 0, publicationBytes: 0, revision: 0 });
  });

  test("one designated work-report key per scoped work, not a terminal state machine", () => {
    const { state } = harness();
    const work = { kind: "publication", publisher: peer, key: "root" } as const;
    const workRecord = { ...record, category: "work", work, status: "completed" } as const;
    expect(state.publish({ scopeId: "team", key: "report", record: workRecord }).tag).toBe("ok");
    expect(state.publish({ scopeId: "team", key: "second", record: workRecord })).toStrictEqual({
      tag: "error",
      code: "work_conflict",
    });
    expect(
      state.publish({
        scopeId: "team",
        key: "report",
        record: { ...workRecord, status: "in_progress" },
      }).tag,
    ).toBe("ok");
    expect(state.publish({ scopeId: "other", key: "second", record: workRecord }).tag).toBe("ok");
    state.remove({ scopeId: "team", key: "report" });
    expect(state.publish({ scopeId: "team", key: "second", record: workRecord }).tag).toBe("ok");
  });

  test("authorization rechecks do not leak hidden existence and lists expose only summaries", () => {
    const h = harness();
    h.state.publish({
      scopeId: "team",
      key: "key",
      record: { ...record, content: "private body" },
    });
    expect(h.state.list({ caller: peer, scopeId: "team" })).toMatchObject({
      tag: "ok",
      value: { items: [{ key: "key", revision: 1, category: "context", title: "Title" }] },
    });
    h.policy(false);
    expect(h.state.read({ caller: peer, scopeId: "team", key: "key" })).toStrictEqual({
      tag: "error",
      code: "forbidden",
    });
    expect(h.state.read({ caller: peer, scopeId: "team", key: "missing" })).toStrictEqual({
      tag: "error",
      code: "forbidden",
    });
    expect(h.state.list({ caller: peer, scopeId: "team" })).toStrictEqual({
      tag: "error",
      code: "forbidden",
    });
  });
});
