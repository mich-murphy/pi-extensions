import type { Publication, WorkRef } from "../protocol/schema.js";
import { encodeFrame } from "../protocol/wire.js";
import { allowed, publicationKey, workKey } from "./shared.js";
import type {
  Failure,
  PublishInput,
  ReadInput,
  Result,
  Store,
  StoredPublication,
  Summary,
  WorkSummary,
} from "./types.js";

function summary(publication: Publication): Summary {
  return {
    key: publication.key,
    revision: publication.revision,
    category: publication.category,
    title: publication.title,
    ...(publication.work === undefined ? {} : { work: publication.work }),
    ...(publication.status === undefined ? {} : { status: publication.status }),
  };
}
export function workSummary(publication: Publication): WorkSummary {
  return {
    key: publication.key,
    revision: publication.revision,
    ...(publication.status === undefined ? {} : { status: publication.status }),
  };
}
function wireResult(forOp: "state.get" | "state.list", value: unknown): unknown {
  return { v: 1, op: "result", rid: "0".repeat(32), forOp, outcome: { tag: "ok", value } };
}
function getValue(store: Store, scopeId: string, publication: Publication) {
  return { publisher: store.peer, scopeId, publication };
}
function listValue(
  store: Store,
  scopeId: string,
  entries: readonly StoredPublication[],
  revision = store.revision,
) {
  return {
    publisher: store.peer,
    scopeId,
    revision,
    items: entries
      .filter((entry) => entry.scopeId === scopeId)
      .map((entry) => summary(entry.publication)),
  };
}
export function currentWork(store: Store, scopeId: string, work: WorkRef): Publication | undefined {
  const key = workKey(scopeId, work);
  return [...store.publications.values()].find(
    (entry) =>
      entry.publication.category === "work" &&
      entry.publication.work !== undefined &&
      workKey(entry.scopeId, entry.publication.work) === key,
  )?.publication;
}
function conflict(store: Store, input: PublishInput): boolean {
  if (input.record.category !== "work" || input.record.work === undefined) {
    return false;
  }
  const current = currentWork(store, input.scopeId, input.record.work);
  return current !== undefined && current.key !== input.key;
}
export function preparePublication(store: Store, input: PublishInput): Result<StoredPublication> {
  if (Object.hasOwn(input.record, "key") || Object.hasOwn(input.record, "revision")) {
    return { tag: "error", code: "invalid_record" };
  }
  if (!store.scopeIds.has(input.scopeId)) {
    return { tag: "error", code: "forbidden" };
  }
  if (store.revision === Number.MAX_SAFE_INTEGER) {
    return { tag: "error", code: "revision_exhausted" };
  }
  if (conflict(store, input)) {
    return { tag: "error", code: "work_conflict" };
  }
  const publication: Publication = structuredClone({
    ...input.record,
    key: input.key,
    revision: store.revision + 1,
  });
  const entry = {
    scopeId: input.scopeId,
    publication,
    bytes: Buffer.byteLength(JSON.stringify({ scopeId: input.scopeId, publication }), "utf8"),
  };
  const next = new Map(store.publications);
  next.set(publicationKey(input.scopeId, input.key), entry);
  if (
    next.size > store.limits.publications ||
    [...next.values()].reduce((total, item) => total + item.bytes, 0) >
      store.limits.publicationBytes
  ) {
    return { tag: "error", code: "overloaded", resource: "publications" };
  }
  try {
    encodeFrame(
      wireResult("state.get", getValue(store, input.scopeId, publication)),
      "local-client",
    );
  } catch {
    return { tag: "error", code: "publication_too_large" };
  }
  try {
    encodeFrame(
      wireResult(
        "state.list",
        listValue(store, input.scopeId, [...next.values()], publication.revision),
      ),
      "local-client",
    );
  } catch {
    return { tag: "error", code: "summary_list_too_large" };
  }
  return { tag: "ok", value: entry };
}
export function commitPublication(store: Store, entry: StoredPublication): Publication {
  const key = publicationKey(entry.scopeId, entry.publication.key);
  store.publicationBytes += entry.bytes - (store.publications.get(key)?.bytes ?? 0);
  store.publications.set(key, entry);
  store.revision = entry.publication.revision;
  return structuredClone(entry.publication);
}
export function publish(store: Store, input: PublishInput): Result<Publication> {
  const prepared = preparePublication(store, input);
  return prepared.tag === "ok"
    ? { tag: "ok", value: commitPublication(store, prepared.value) }
    : prepared;
}
export function read(store: Store, input: ReadInput) {
  if (!allowed(store, "read", input.caller, store.peer, input.scopeId)) {
    return { tag: "error", code: "forbidden" } satisfies Failure;
  }
  const record = store.publications.get(publicationKey(input.scopeId, input.key));
  if (record === undefined) {
    return { tag: "error", code: "not_found" } satisfies Failure;
  }
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== record.publication.revision
  ) {
    return { tag: "error", code: "revision_mismatch" } satisfies Failure;
  }
  return {
    tag: "ok",
    value: structuredClone(getValue(store, input.scopeId, record.publication)),
  } as const;
}
export function list(store: Store, input: { caller: ReadInput["caller"]; scopeId: string }) {
  if (!allowed(store, "read", input.caller, store.peer, input.scopeId)) {
    return { tag: "error", code: "forbidden" } satisfies Failure;
  }
  return {
    tag: "ok",
    value: structuredClone(listValue(store, input.scopeId, [...store.publications.values()])),
  } as const;
}
export function removePublication(
  store: Store,
  input: { scopeId: string; key: string },
): Result<{ key: string; revision: number; removed: boolean }> {
  if (!store.scopeIds.has(input.scopeId)) {
    return { tag: "error", code: "forbidden" };
  }
  if (store.revision === Number.MAX_SAFE_INTEGER) {
    return { tag: "error", code: "revision_exhausted" };
  }
  const key = publicationKey(input.scopeId, input.key);
  const prior = store.publications.get(key);
  store.publications.delete(key);
  store.publicationBytes -= prior?.bytes ?? 0;
  store.revision++;
  return {
    tag: "ok",
    value: { key: input.key, revision: store.revision, removed: prior !== undefined },
  };
}
