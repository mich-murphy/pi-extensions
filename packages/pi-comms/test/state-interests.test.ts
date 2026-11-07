import { describe, expect, test } from "vitest";
import { createState } from "../state/core.js";
import type { PublicationRecord } from "../state/types.js";

const peer = { machineId: "alpha", sessionId: "publisher", runtimeNonce: "a".repeat(32) };
const subscriber = { ...peer, sessionId: "subscriber" };
const other = { ...peer, sessionId: "other" };
const work = { kind: "publication", publisher: peer, key: "root" } as const;
const record: PublicationRecord = {
  category: "work",
  work,
  title: "Report",
  summary: "Summary",
  status: "in_progress",
  format: "text",
  preparation: "authored",
};
const input = { subscriber, scopeId: "team", work };
function harness(recipientsPerWork = 8, relationsAndInterests = 256) {
  let now = 0;
  let allowed = true;
  let ids = 0;
  const state = createState({
    peer,
    scopeIds: ["team", "other"],
    clock: () => now,
    authorize: () => allowed,
    offer: () => true,
    newMessageId: () => (++ids).toString(16).padStart(32, "0"),
    limits: { recipientsPerWork, relationsAndInterests },
  });
  state.publish({ scopeId: "team", key: "report", record });
  return {
    state,
    clock: (value: number) => {
      now = value;
    },
    policy: (value: boolean) => {
      allowed = value;
    },
  };
}

describe("scoped interests and atomic terminal report plans", () => {
  test("unknown work is not found, natural tuple renews lease without duplicate recipients", () => {
    const h = harness();
    expect(h.state.interest.add({ ...input, scopeId: "other" })).toStrictEqual({
      tag: "error",
      code: "not_found",
    });
    expect(h.state.interest.add(input)).toMatchObject({
      tag: "ok",
      value: {
        active: true,
        expiresInMs: 86_400_000,
        current: { revision: 1, status: "in_progress" },
      },
    });
    h.clock(80_000_000);
    h.state.interest.add(input);
    h.clock(90_000_000);
    expect(h.state.stats().interests).toBe(1);
    h.clock(166_400_000);
    expect(h.state.stats().interests).toBe(0);
  });

  test("interest winning before terminal commit is snapshotted and consumed once", () => {
    const { state } = harness();
    state.interest.add(input);
    const plan = state.prepareReport({
      scopeId: "team",
      key: "report",
      record: { ...record, status: "completed" },
      notify: "interested",
    });
    expect(plan).toMatchObject({
      tag: "ok",
      value: {
        publication: { revision: 2, status: "completed" },
        pushes: [
          {
            to: subscriber,
            message: {
              id: "1".padStart(32, "0"),
              kind: "update",
              status: "completed",
              refs: [{ revision: 2 }],
            },
          },
        ],
        consumedInterests: [subscriber],
      },
    });
    expect(state.stats().interests).toBe(0);
    expect(state.interest.add(input)).toMatchObject({
      tag: "ok",
      value: { active: false, current: { revision: 2, status: "completed" } },
    });
    expect(state.stats().interests).toBe(0);
  });

  test("terminal report winning first gives later registration terminal current state", () => {
    const { state } = harness();
    expect(
      state.prepareReport({
        scopeId: "team",
        key: "report",
        record: { ...record, status: "failed" },
        notify: "interested",
      }),
    ).toMatchObject({ tag: "ok", value: { pushes: [], consumedInterests: [] } });
    expect(state.interest.add(input)).toMatchObject({
      tag: "ok",
      value: { active: false, current: { status: "failed", revision: 2 } },
    });
  });

  test("explicitly unselected interests survive terminal report and older async cleanup cannot erase renewals", () => {
    const { state } = harness();
    state.interest.add(input);
    state.interest.add({ ...input, subscriber: other });
    expect(
      state.prepareReport({
        scopeId: "team",
        key: "report",
        record: { ...record, status: "completed" },
        notify: "selected",
        recipients: [subscriber],
      }),
    ).toMatchObject({
      tag: "ok",
      value: { consumedInterests: [subscriber], pushes: [{ to: subscriber }] },
    });
    expect(state.stats().interests).toBe(1);
    state.publish({ scopeId: "team", key: "report", record });
    state.interest.add(input);
    expect(state.stats().interests).toBe(2);
    expect(state.interest.remove({ ...input, subscriber: other }).tag).toBe("ok");
    expect(state.interest.remove({ ...input, subscriber: other }).tag).toBe("ok");
  });

  test("notification default includes direct requester, not an unrelated claimed WorkRef origin", () => {
    const { state } = harness();
    state.admit({
      from: subscriber,
      to: peer,
      scopeId: "team",
      message: {
        id: "b".repeat(32),
        kind: "request",
        format: "text",
        content: "Please help",
        work,
      },
    });
    expect(
      state.prepareReport({ scopeId: "team", key: "report", record, notify: "interested" }),
    ).toMatchObject({ tag: "ok", value: { pushes: [{ to: subscriber }], consumedInterests: [] } });
  });

  test("fanout counts distinct recipients jointly across direct requesters and interests", () => {
    const { state } = harness(1);
    state.admit({
      from: subscriber,
      to: peer,
      scopeId: "team",
      message: { id: "b".repeat(32), kind: "request", format: "text", content: "Help", work },
    });
    expect(state.interest.add(input).tag).toBe("ok");
    expect(state.interest.add({ ...input, subscriber: other })).toStrictEqual({
      tag: "error",
      code: "overloaded",
      resource: "interests",
    });
    expect(
      state.admit({
        from: other,
        to: peer,
        scopeId: "team",
        message: { id: "c".repeat(32), kind: "request", format: "text", content: "Help", work },
      }),
    ).toMatchObject({ tag: "not_admitted", code: "overloaded", resource: "relations" });
  });

  test("combined relation/interest cap is explicit, but renewing existing interest succeeds", () => {
    const { state } = harness(8, 1);
    expect(state.interest.add(input).tag).toBe("ok");
    expect(state.interest.add(input).tag).toBe("ok");
    expect(state.interest.add({ ...input, subscriber: other })).toStrictEqual({
      tag: "error",
      code: "overloaded",
      resource: "interests",
    });
  });

  test.each([{ selected: [] }, { selected: [subscriber, subscriber] }])(
    "bad selected fanout %# never publishes",
    ({ selected }) => {
      const { state } = harness();
      expect(
        state.prepareReport({
          scopeId: "team",
          key: "report",
          record,
          notify: "selected",
          recipients: selected,
        }),
      ).toStrictEqual({ tag: "error", code: "invalid_recipients" });
      expect(state.stats().revision).toBe(1);
    },
  );

  test("authorization changes stop report before publication and do not consume interests", () => {
    const h = harness();
    h.state.interest.add(input);
    h.policy(false);
    expect(
      h.state.prepareReport({
        scopeId: "team",
        key: "report",
        record: { ...record, status: "completed" },
        notify: "interested",
      }),
    ).toStrictEqual({ tag: "error", code: "forbidden" });
    expect(h.state.stats()).toMatchObject({ revision: 1, interests: 1 });
    expect(h.state.interest.add(input)).toStrictEqual({ tag: "error", code: "forbidden" });
  });
  test("ID allocation failure occurs before publication and selected interest consumption", () => {
    const state = createState({
      peer,
      scopeIds: ["team"],
      clock: () => 0,
      authorize: () => true,
      offer: () => true,
      newMessageId: () => "1".repeat(32),
    });
    state.publish({ scopeId: "team", key: "report", record });
    state.interest.add(input);
    state.interest.add({ ...input, subscriber: other });
    expect(
      state.prepareReport({
        scopeId: "team",
        key: "report",
        record: { ...record, status: "completed" },
        notify: "interested",
      }),
    ).toStrictEqual({ tag: "error", code: "invalid_record" });
    expect(state.stats()).toMatchObject({ revision: 1, interests: 2 });
  });
  test("exhausted sender slots refuse before publication, revision or interest consumption", () => {
    let available = false;
    const reserved: number[] = [];
    const state = createState({
      peer,
      scopeIds: ["team"],
      clock: () => 0,
      authorize: () => true,
      offer: () => true,
      reservePushes: (count) => {
        reserved.push(count);
        return available;
      },
    });
    state.publish({ scopeId: "team", key: "report", record });
    state.interest.add(input);
    const report = {
      scopeId: "team",
      key: "report",
      record: { ...record, status: "completed" },
      notify: "interested",
    } as const;
    expect(state.prepareReport(report)).toStrictEqual({
      tag: "error",
      code: "overloaded",
      resource: "operations",
    });
    expect(state.read({ caller: peer, scopeId: "team", key: "report" })).toMatchObject({
      tag: "ok",
      value: { publication: { revision: 1, status: "in_progress" } },
    });
    expect(state.stats()).toMatchObject({ revision: 1, interests: 1 });
    available = true;
    expect(state.prepareReport(report)).toMatchObject({
      tag: "ok",
      value: {
        publication: { revision: 2, status: "completed" },
        consumedInterests: [subscriber],
        pushes: [{ to: subscriber }],
      },
    });
    expect(reserved).toStrictEqual([1, 1]);
    expect(state.stats()).toMatchObject({ revision: 2, interests: 0 });
  });

  test("pure publication and zero-recipient reports never consume sender slots", () => {
    const reserved: number[] = [];
    const state = createState({
      peer,
      scopeIds: ["team"],
      clock: () => 0,
      authorize: () => true,
      offer: () => true,
      reservePushes: (count) => {
        reserved.push(count);
        return false;
      },
    });
    expect(state.publish({ scopeId: "team", key: "report", record }).tag).toBe("ok");
    expect(
      state.prepareReport({ scopeId: "team", key: "report", record, notify: "interested" }),
    ).toMatchObject({ tag: "ok", value: { pushes: [] } });
    expect(reserved).toHaveLength(0);
  });
});
