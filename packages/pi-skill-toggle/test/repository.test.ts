import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { disabledResourceMatcher } from "../guard";
import { RepositoryLocator } from "../repository";
import { resourcePathId } from "../resource-path";
import { ResourcePolicy } from "../resources";
import type { ToggleOverrides, ToggleResource } from "../resources";
import { ToggleStateFile } from "../state";
import type { ToggleStateResult } from "../state";

const directories: string[] = [];
function value(result: ToggleStateResult) {
  if (result._tag === "err") {
    throw result.error;
  }
  return result.value;
}
function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    },
  ).trim();
}
function write(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "rules\n");
}
function resource(path: string, origin: "global" | "project" = "project"): ToggleResource {
  return {
    id: resourcePathId(path, "/"),
    kind: "instruction",
    origin,
    label: "AGENTS.md",
    description: path,
    editability: "editable",
  };
}
function repository(separate = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-skill-real-git-")));
  directories.push(root);
  const main = join(root, "main");
  const common = separate ? join(root, "git-data") : join(main, ".git");
  const child = join(root, "child");
  const second = join(root, "second");
  git("init", "-q", ...(separate ? ["--separate-git-dir", common] : []), main);
  for (const path of ["AGENTS.md", "nested/AGENTS.md", "custom-skills/deploy/SKILL.md"]) {
    write(join(main, path));
  }
  git("-C", main, "add", ".");
  git(
    "-C",
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "initial",
  );
  git("-C", main, "worktree", "add", "-q", "--detach", child);
  git("-C", main, "worktree", "add", "-q", "--detach", second);
  const statePath = join(root, "state.json");
  return { root, main, common, child, second, statePath, store: new ToggleStateFile(statePath) };
}

function expectOutsideGit(repo: ReturnType<typeof repository>, stale: string) {
  // Git itself no longer recognizes the stale checkout.
  expect(() => git("-C", stale, "rev-parse", "--git-dir")).toThrow(/not a git repository/u);
  const locator = new RepositoryLocator();
  expect(locator.locate(join(stale, "nested/AGENTS.md"))).toBeUndefined();
  expect(locator.worktreeRoot(stale)).toBeUndefined();
  expect(locator.locate(join(repo.second, "nested/AGENTS.md"))?.main).toBe(false);
}

function legacyState(version: number, entries: Record<string, string>) {
  if (version === 6) {
    return { version, overrides: entries };
  }
  return {
    version,
    resources: Object.fromEntries(
      Object.entries(entries).map(([path, choice]) => [
        path,
        { enabled: choice === "enabled", kind: "instruction", origin: "project" },
      ]),
    ),
  };
}

describe("repository-wide policy with real Git", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const path of directories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test.each([false, true])(
    "recognizes main and linked checkouts (separate git dir: %s)",
    (separate) => {
      const repo = repository(separate);
      const locator = new RepositoryLocator();
      expect(locator.locate(join(repo.main, "nested/AGENTS.md"))).toStrictEqual({
        repository: repo.common,
        path: "nested/AGENTS.md",
        main: true,
      });
      expect(locator.locate(join(repo.child, "nested/AGENTS.md"))).toStrictEqual({
        repository: repo.common,
        path: "nested/AGENTS.md",
        main: false,
      });
      // A locator is safe to reuse after the checkout layout changes: no stale directory cache.
      const outside = join(repo.root, "new-repo", "AGENTS.md");
      expect(locator.locate(outside)).toBeUndefined();
      git("init", "-q", dirname(outside));
      expect(locator.locate(outside)?.main).toBe(true);
    },
  );

  test("treats a moved linked worktree with a missing gitdir as outside Git", () => {
    const repo = repository();
    const stale = join(repo.root, "moved");
    renameSync(repo.child, stale);
    git("-C", repo.main, "worktree", "prune");
    expectOutsideGit(repo, stale);
  });

  test("treats a pruned linked worktree with a missing gitdir as outside Git", () => {
    const repo = repository();
    rmSync(join(repo.common, "worktrees", "child"), { recursive: true });
    expectOutsideGit(repo, repo.child);
  });

  test("migrates stale-worktree choices to file entries that never win as a main checkout", () => {
    const repo = repository();
    const stale = join(repo.root, "moved");
    renameSync(repo.child, stale);
    git("-C", repo.main, "worktree", "prune");
    const stalePath = resourcePathId(join(stale, "AGENTS.md"), "/");
    const secondPath = resourcePathId(join(repo.second, "AGENTS.md"), "/");
    writeFileSync(
      repo.statePath,
      JSON.stringify({
        version: 6,
        overrides: { [stalePath]: "disabled", [secondPath]: "enabled" },
      }),
    );
    const loaded = value(repo.store.load());
    expect([...loaded.files]).toStrictEqual([[stalePath, "disabled"]]);
    expect([...loaded.repositories]).toStrictEqual([
      [repo.common, new Map([["AGENTS.md", "enabled"]])],
    ]);
    for (const checkout of [repo.main, repo.second]) {
      expect(new ResourcePolicy(loaded).value(resource(join(checkout, "AGENTS.md")))).toBe(
        "enabled",
      );
    }
    expect(new ResourcePolicy(loaded).value(resource(stalePath))).toBe("disabled");
    value(repo.store.set(resourcePathId(join(repo.main, "nested/AGENTS.md"), "/"), "disabled"));
    expect(JSON.parse(readFileSync(repo.statePath, "utf8"))).toStrictEqual({
      version: 7,
      files: { [stalePath]: "disabled" },
      repositories: {
        [repo.common]: { "AGENTS.md": "enabled", "nested/AGENTS.md": "disabled" },
      },
    });
  });

  test("memoizes locations only within one policy evaluation and keeps global scope separate", () => {
    const repo = repository();
    const path = resourcePathId(join(repo.root, "new-repo/AGENTS.md"), "/");
    const choices: ToggleOverrides = {
      files: new Map(),
      repositories: new Map([[join(dirname(path), ".git"), new Map([["AGENTS.md", "disabled"]])]]),
    };
    const locate = vi.spyOn(RepositoryLocator.prototype, "locate");
    const policy = new ResourcePolicy(choices);
    expect(policy.override(path)).toBeUndefined();
    expect(policy.override(path)).toBeUndefined();
    expect(locate).toHaveBeenCalledTimes(1);
    git("init", "-q", dirname(path));
    const refreshed = new ResourcePolicy(choices);
    expect(refreshed.override(path)).toBe("disabled");
    expect(refreshed.override(path)).toBe("disabled");
    expect(refreshed.override(path, "global")).toBeUndefined();
    expect(locate).toHaveBeenCalledTimes(2);
  });

  test.each([4, 5, 6])(
    "migrates v%s conflicts read-only, with main checkout winning",
    (version) => {
      const repo = repository(true);
      const mainPath = join(repo.main, "nested/AGENTS.md");
      const childPath = join(repo.child, "nested/AGENTS.md");
      const entries = { [childPath]: "disabled", [mainPath]: "enabled" } as const;
      const state = legacyState(version, entries);
      writeFileSync(repo.statePath, JSON.stringify(state));
      const before = readFileSync(repo.statePath, "utf8");
      const loaded = value(repo.store.load());
      const policy = new ResourcePolicy(loaded);
      for (const checkout of [repo.main, repo.child, repo.second]) {
        expect(policy.value(resource(join(checkout, "nested/AGENTS.md")))).toBe("enabled");
        expect(
          disabledResourceMatcher([], loaded, new Set()).match(join(checkout, "nested/AGENTS.md")),
        ).toBeUndefined();
      }
      expect(readFileSync(repo.statePath, "utf8")).toBe(before);
      value(repo.store.set(resourcePathId(join(repo.child, "AGENTS.md"), "/"), "disabled"));
      expect(JSON.parse(readFileSync(repo.statePath, "utf8"))).toStrictEqual({
        version: 7,
        files: {},
        repositories: {
          [repo.common]: {
            "AGENTS.md": "disabled",
            "nested/AGENTS.md": "enabled",
          },
        },
      });
    },
  );

  test("normalizes v7 repository keys on load and persists them only on save", () => {
    const repo = repository();
    writeFileSync(
      repo.statePath,
      JSON.stringify({
        version: 7,
        files: {},
        repositories: { [`${repo.common}/`]: { "AGENTS.md": "disabled" } },
      }),
    );
    const before = readFileSync(repo.statePath, "utf8");
    const loaded = value(repo.store.load());
    expect([...loaded.repositories.keys()]).toStrictEqual([repo.common]);
    for (const checkout of [repo.main, repo.child]) {
      const path = join(checkout, "AGENTS.md");
      expect(new ResourcePolicy(loaded).value(resource(path))).toBe("disabled");
      expect(disabledResourceMatcher([], loaded, new Set()).match(path)).toBe("AGENTS.md");
    }
    expect(readFileSync(repo.statePath, "utf8")).toBe(before);
    value(repo.store.set(resourcePathId(join(repo.main, "nested/AGENTS.md"), "/"), "enabled"));
    expect(JSON.parse(readFileSync(repo.statePath, "utf8"))).toStrictEqual({
      version: 7,
      files: {},
      repositories: {
        [repo.common]: {
          "AGENTS.md": "disabled",
          "nested/AGENTS.md": "enabled",
        },
      },
    });
  });

  test("child-only legacy conflicts are deterministic regardless of JSON entry order", () => {
    const repo = repository();
    const first = join(repo.child, "AGENTS.md");
    const second = join(repo.second, "AGENTS.md");
    const orders: Record<string, string>[] = [
      { [second]: "enabled", [first]: "disabled" },
      { [first]: "disabled", [second]: "enabled" },
    ];
    for (const entries of orders) {
      writeFileSync(repo.statePath, JSON.stringify({ version: 6, overrides: entries }));
      expect(
        new ResourcePolicy(value(repo.store.load())).value(resource(join(repo.main, "AGENTS.md"))),
      ).toBe("disabled");
    }
  });

  test("saved repository choices survive deletion of their originating worktree and later saves", () => {
    const repo = repository();
    const path = resourcePathId(join(repo.child, "nested/AGENTS.md"), "/");
    value(repo.store.set(path, "disabled"));
    git("-C", repo.main, "worktree", "remove", "--force", repo.child);
    value(repo.store.set(resourcePathId(join(repo.main, "AGENTS.md"), "/"), "enabled"));
    const loaded = value(new ToggleStateFile(repo.statePath).load());
    for (const checkout of [repo.main, repo.second]) {
      const target = join(checkout, "nested/AGENTS.md");
      expect(new ResourcePolicy(loaded).value(resource(target))).toBe("disabled");
      expect(disabledResourceMatcher([], loaded, new Set()).match(target)).toBe("nested/AGENTS.md");
    }
    expect(loaded.files.size).toBe(0);
    expect(loaded.repositories.get(repo.common)?.get("nested/AGENTS.md")).toBe("disabled");
  });

  test.each([
    ["agent-dir", ".pi/agent/AGENTS.md"],
    ["agents-skills", ".agents/skills/deploy/SKILL.md"],
  ])("keeps %s globals absolute even inside a Git checkout", (_kind, suffix) => {
    const repo = repository();
    // Both global conventions deliberately live under this repository.
    vi.stubEnv("PI_CODING_AGENT_DIR", join(repo.main, ".pi/agent"));
    vi.stubEnv("HOME", repo.main);
    const mainPath = resourcePathId(join(repo.main, suffix), "/");
    const childPath = resourcePathId(join(repo.child, suffix), "/");
    write(mainPath);
    write(childPath);
    // v6 migration uses the same global discovery-path classification as arbitrary reads.
    writeFileSync(
      repo.statePath,
      JSON.stringify({ version: 6, overrides: { [mainPath]: "disabled" } }),
    );
    const loaded = value(repo.store.load());
    expect(loaded.files.get(mainPath)).toBe("disabled");
    expect(loaded.repositories.size).toBe(0);
    const policy = new ResourcePolicy(value(repo.store.set(mainPath, "disabled", "global")));
    expect(policy.override(mainPath, "global")).toBe("disabled");
    expect(policy.override(childPath)).toBeUndefined();
  });
});
