import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { Handles, sessionHandle, TakenIndex } from "../adapter/handles.js";
import { composeLabel, connectLabel, parentSessionId, readBranch } from "../adapter/label.js";

const run = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

function runtime(sessionId: string, nonce = "1", machineId = "beta") {
  return { machineId, sessionId, runtimeNonce: nonce.repeat(32) };
}

function colliding(): [string, string] {
  const seen = new Map<string, string>();

  for (let index = 0; ; index += 1) {
    const sessionId = `session-${index}`;
    const handle = sessionHandle("beta", sessionId);
    const earlier = seen.get(handle);

    if (earlier !== undefined) {
      return [earlier, sessionId];
    }

    seen.set(handle, sessionId);
  }
}

describe("session handles", () => {
  test("a colliding prefix lengthens and a handle is never reused for another session", () => {
    const [first, second] = colliding();
    const handles = new Handles();
    const [one] = handles.list([{ peer: runtime(first), scopeId: "team" }]);
    const [two] = handles.list([{ peer: runtime(second), scopeId: "team" }]);
    assert(one);
    assert(two);
    expect(one.handle).toBe(sessionHandle("beta", first));
    expect(two.handle).toMatch(/^s-[0-9a-f]{6}$/u);
    expect(two.handle.startsWith(one.handle)).toBe(true);
    const [again] = handles.list([{ peer: runtime(second), scopeId: "team" }]);
    const [back] = handles.list([{ peer: runtime(first, "2"), scopeId: "team" }]);
    expect(again?.handle).toBe(two.handle);
    expect(back?.handle).toBe(one.handle);
    expect(handles.resolve(one.handle)?.peer).toStrictEqual(runtime(first, "2"));
  });
  test("handles are not sequential: listing order does not choose them", () => {
    const left = new Handles().list([
      { peer: runtime("a"), scopeId: "team" },
      { peer: runtime("b"), scopeId: "team" },
    ]);

    const right = new Handles().list([
      { peer: runtime("b"), scopeId: "team" },
      { peer: runtime("a"), scopeId: "team" },
    ]);

    expect(left.map((entry) => entry.handle).toSorted()).toStrictEqual(
      right.map((entry) => entry.handle).toSorted(),
    );
  });
  test("a second live runtime of one session gets /2, the bare handle binds the first", () => {
    const handles = new Handles();

    const listed = handles.list([
      { peer: runtime("same", "1"), scopeId: "team" },
      { peer: runtime("same", "2"), scopeId: "team" },
      { peer: runtime("same", "3"), scopeId: "team" },
    ]);

    const base = sessionHandle("beta", "same");
    expect(listed.map((entry) => entry.handle)).toStrictEqual([base, `${base}/2`, `${base}/3`]);
    expect(handles.resolve(base)?.peer.runtimeNonce).toBe("1".repeat(32));
    expect(handles.resolve(`${base}/2`)?.peer.runtimeNonce).toBe("2".repeat(32));
  });
  test("a changed runtime nonce rebinds the handle and marks it restarted once", () => {
    const handles = new Handles();
    expect(handles.list([{ peer: runtime("x", "1"), scopeId: "team" }])[0]?.restarted).toBe(false);
    expect(handles.list([{ peer: runtime("x", "1"), scopeId: "team" }])[0]?.restarted).toBe(false);
    expect(handles.list([{ peer: runtime("x", "2"), scopeId: "team" }])[0]?.restarted).toBe(true);
    expect(handles.list([{ peer: runtime("x", "2"), scopeId: "team" }])[0]?.restarted).toBe(false);
    expect(handles.resolve(sessionHandle("beta", "x"))?.peer.runtimeNonce).toBe("2".repeat(32));
  });
  test("an unlisted sender gets its handle, and a different runtime of it gets /2", () => {
    const handles = new Handles();
    const base = sessionHandle("beta", "y");
    expect(handles.sender(runtime("y", "1"), "team")).toBe(base);
    expect(handles.sender(runtime("y", "1"), "team")).toBe(base);
    expect(handles.sender(runtime("y", "2"), "team")).toBe(`${base}/2`);
    expect(handles.resolve(base)?.peer.runtimeNonce).toBe("1".repeat(32));
  });
  test("the taken index keeps the most recent entries only", () => {
    const index = new TakenIndex(2);
    index.record("a", { peer: runtime("a"), scopeId: "team" });
    index.record("b", { peer: runtime("b"), scopeId: "team" });
    index.record("a", { peer: runtime("a"), scopeId: "other" });
    index.record("c", { peer: runtime("c"), scopeId: "team" });
    expect(index.find("b")).toBeUndefined();
    expect(index.find("a")?.scopeId).toBe("other");
    expect(index.find("c")?.peer.sessionId).toBe("c");
  });
});

function sessions(cwd: string) {
  return { getCwd: () => cwd, getSessionName: () => "named", getHeader: () => null };
}

describe("own label at connect", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });
  const facts = { configured: "Pi", machineId: "alpha", cwd: "/work/pi-extensions" };
  test("parts in priority order joined with a middle dot", () => {
    expect(composeLabel(facts)).toBe("Pi · pi-extensions");
    expect(
      composeLabel({
        ...facts,
        sessionName: "fix pi peers",
        parentSession:
          "/home/u/.pi/agent/sessions/--work--/2026-11-16T07-14-25-782Z_parent-id.jsonl",
        branch: "feat/x",
      }),
    ).toBe(
      `Pi · fix pi peers · pi-extensions · derived from ${sessionHandle("alpha", "parent-id")} · branch feat/x at connect`,
    );
  });
  test("lineage names the parent handle, never its path", () => {
    expect(parentSessionId("/a/b/2026-11-16T07-14-25-782Z_01a1e335-0775.jsonl")).toBe(
      "01a1e335-0775",
    );
    expect(parentSessionId("/a/b/no-separator.jsonl")).toBeUndefined();
    expect(parentSessionId("/a/b/trailing_.jsonl")).toBeUndefined();
    const label = composeLabel({ ...facts, parentSession: "/secret/dir/t_abc.jsonl" });
    expect(label).toContain(`derived from ${sessionHandle("alpha", "abc")}`);
    expect(label).not.toContain("secret");
  });
  test("control and bidi characters are stripped", () => {
    const label = composeLabel({
      ...facts,
      sessionName: "a\u001b[31mb‮c\n\td\u009b",
    });

    expect(label).toBe("Pi · a [31mb c d · pi-extensions");
    expect(label).not.toMatch(/[\p{Cc}‪-‮⁦-⁩]/u);
  });
  test("lowest parts drop first to fit 128 bytes; the configured label is cut last", () => {
    const long = composeLabel({ ...facts, sessionName: "n".repeat(100), branch: "b".repeat(20) });
    expect(long).toBe(`Pi · ${"n".repeat(100)} · pi-extensions`);
    const name = composeLabel({ ...facts, sessionName: "界".repeat(50) });
    expect(name).toBe("Pi");
    const cut = composeLabel({ ...facts, configured: "é".repeat(100) });
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(128);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.startsWith("é".repeat(60))).toBe(true);
  });
  test("the branch is shared only with shareBranch, and a non-repository omits it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pl-"));
    cleanups.push(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const outside = await mkdtemp(join(tmpdir(), "pl-none-"));
    cleanups.push(async () => {
      await rm(outside, { recursive: true, force: true });
    });
    await run("git", ["-C", directory, "init", "-q", "-b", "feat/labels"]);
    await run("git", [
      "-C",
      directory,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    ]);

    const config = {
      machineId: "alpha",
      socketPath: "/tmp/g.sock",
      scopeIds: ["team"],
      label: "Pi",
      policies: [],
    };

    await expect(connectLabel(config, sessions(directory))).resolves.not.toContain("branch");
    await expect(
      connectLabel({ ...config, shareBranch: true }, sessions(directory)),
    ).resolves.toMatch(/ · branch feat\/labels at connect$/u);
    await expect(readBranch(outside)).resolves.toBeUndefined();
    await expect(
      connectLabel({ ...config, shareBranch: true }, sessions(outside)),
    ).resolves.not.toContain("branch");
  });
});
