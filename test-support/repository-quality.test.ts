import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = resolve(checkout, "scripts/repository-quality.ts");

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "repository quality-"));
  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  function write(path: string, content: string) {
    const full = resolve(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  function run(mode: string, cwd = root, env = process.env) {
    const localRunner = resolve(cwd, ".repository-quality-runner.ts");
    copyFileSync(runner, localRunner);
    return spawnSync(process.execPath, ["--experimental-strip-types", localRunner, mode], {
      cwd,
      env,
      encoding: "utf8",
    });
  }
  git("init", "--quiet");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Offline fixture");
  git("config", "core.hooksPath", "/dev/null");
  write(".gitignore", "node_modules/\n.repository-quality-runner.ts\n");
  mkdirSync(resolve(root, "node_modules/.bin"), { recursive: true });
  for (const tool of ["oxfmt", "oxlint"]) {
    symlinkSync(
      resolve(checkout, "node_modules/.bin", tool),
      resolve(root, "node_modules/.bin", tool),
    );
  }
  symlinkSync(
    resolve(checkout, "node_modules/markdownlint-cli2"),
    resolve(root, "node_modules/markdownlint-cli2"),
  );
  mkdirSync(resolve(root, "config"));
  copyFileSync(
    resolve(checkout, "config/markdownlint-cli2.yaml"),
    resolve(root, "config/markdownlint-cli2.yaml"),
  );
  copyFileSync(resolve(checkout, ".oxfmtrc.json"), resolve(root, ".oxfmtrc.json"));
  return {
    root,
    git,
    write,
    run,
    close: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function parseBatch(line: string): string[] {
  const batch: unknown = JSON.parse(line);
  assert.ok(Array.isArray(batch));
  const args: unknown[] = batch;
  assert.ok(args.every((arg) => typeof arg === "string"));
  return args;
}

function assertSuccess(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function assertFailure(result: ReturnType<ReturnType<typeof fixture>["run"]>) {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
}

await test("clean clone, dirty local artifacts, staged and tracked violations use the same scope", () => {
  const f = fixture();
  try {
    f.write("good.json", "{}\n");
    f.write("README.md", "# Fixture\n\nValid text.\n");
    f.write(
      ".gitignore",
      "node_modules/\n.repository-quality-runner.ts\n.direnv/\ncoverage/\npackages/pi-comms/gateway/target/\n",
    );
    f.git("add", ".");
    f.git("commit", "--quiet", "-m", "fixture");
    assertSuccess(f.run("format-check"));
    assertSuccess(f.run("markdownlint"));
    for (const dir of [
      ".agents/tasks",
      ".direnv/cache",
      "node_modules/dependency",
      "coverage",
      "packages/pi-comms/gateway/target",
    ]) {
      f.write(`${dir}/bad.json`, "{bad JSON");
      f.write(`${dir}/bad.md`, "# Bad\n\nhttp://bare.example\n");
    }
    assertSuccess(f.run("format-check"));
    assertSuccess(f.run("markdownlint"));
    f.write("good.json", '{"bad":1}');
    assertFailure(f.run("format-check"));
    f.write("good.json", "{}\n");
    f.write(".agents/skills/new/SKILL.md", "# Bad\n\nhttp://bare.example\n");
    f.git("add", ".agents/skills");
    assertFailure(f.run("markdownlint"));
    f.write(".agents/skills/new/SKILL.md", "# Good\n\nValid.\n");
    assertSuccess(f.run("markdownlint"));
    f.write("new source.ts", "export const value={a:1}");
    assertSuccess(f.run("format-check"));
    f.git("add", "new source.ts");
    assertFailure(f.run("format-check"));
    f.write("new source.ts", "export const value = { a: 1 };\n");
    assertSuccess(f.run("format-check"));
    f.write("bad.js", "const = ;\n");
    f.git("add", "bad.js");
    assertFailure(f.run("lint"));
    f.git("rm", "--force", "bad.js");
    assertSuccess(f.run("lint"));
    const clone = resolve(f.root, "clone");
    f.git("clone", "--quiet", f.root, clone);
    symlinkSync(resolve(f.root, "node_modules"), resolve(clone, "node_modules"));
    assertSuccess(f.run("format-check", clone));
    assertSuccess(f.run("markdownlint", clone));
  } finally {
    f.close();
  }
});

await test("literal filenames, unstaged/staged deletions and linked worktrees", () => {
  const f = fixture();
  try {
    for (const name of [
      "space name.json",
      "line\nbreak.json",
      "tab\tname.json",
      "[bracket].json",
      "!bang.json",
      "-option.json",
      ".agents/config.json",
    ]) {
      f.write(name, "{}\n");
    }
    for (const name of ["space name.md", "line\nbreak.md", "[bracket].md", "!bang.md"]) {
      f.write(name, "# Good\n");
    }
    f.git("add", ".");
    f.git("commit", "--quiet", "-m", "fixture");
    assertSuccess(f.run("format-check"));
    assertSuccess(f.run("markdownlint"));
    for (const name of [
      "[bracket].json",
      "line\nbreak.json",
      "!bang.json",
      "-option.json",
      ".agents/config.json",
    ]) {
      f.write(name, '{"bad":1}');
      assertFailure(f.run("format-check"));
      f.write(name, "{}\n");
    }
    unlinkSync(resolve(f.root, "[bracket].json"));
    f.git("rm", "--", "space name.json");
    assertSuccess(f.run("format-check"));
    f.write("line\nbreak.md", "# Bad\n\nhttp://bare.example\n");
    assertFailure(f.run("markdownlint"));
    const worktree = resolve(f.root, "linked worktree");
    f.git("worktree", "add", "--quiet", "--detach", worktree, "HEAD");
    symlinkSync(resolve(f.root, "node_modules"), resolve(worktree, "node_modules"));
    assertSuccess(f.run("format-check", worktree));
    assertSuccess(f.run("markdownlint", resolve(worktree, "config")));
  } finally {
    f.close();
  }
});

await Promise.all(
  ["format-check", "format"].map(async (mode) =>
    test(`${mode} refuses symlink ancestors without reading or changing outside files`, () => {
      const f = fixture();
      const outside = mkdtempSync(resolve(tmpdir(), "repository-quality-outside-"));
      try {
        f.write("tracked/file.json", "{}\n");
        f.git("add", "tracked/file.json");
        rmSync(resolve(f.root, "tracked"), { recursive: true });
        const target = resolve(outside, "file.json");
        const original = '{"bad":1}';
        writeFileSync(target, original);
        symlinkSync(outside, resolve(f.root, "tracked"));
        const result = f.run(mode);
        assert.equal(readFileSync(target, "utf8"), original);
        assertFailure(result);
        assert.match(result.stderr, /Indexed symlink/u);
        assert.match(result.stderr, /tracked\/file\.json/u);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /Found formatting issues|Formatted.*files/u,
        );
      } finally {
        f.close();
        rmSync(outside, { recursive: true, force: true });
      }
    }),
  ),
);

await test("deleted ancestor paths and canonical checkout root aliases remain supported", () => {
  const f = fixture();
  const aliases = mkdtempSync(resolve(tmpdir(), "repository-quality-alias-"));
  try {
    f.write("tracked/nested/file.json", "{}\n");
    f.write("normal/file.json", "{}\n");
    f.git("add", "tracked", "normal");
    assertSuccess(f.run("format-check"));
    rmSync(resolve(f.root, "tracked"), { recursive: true });
    assertSuccess(f.run("format-check"));
    assertSuccess(f.run("format"));
    const alias = resolve(aliases, "checkout");
    symlinkSync(f.root, alias);
    assertSuccess(f.run("format-check", alias));
  } finally {
    f.close();
    rmSync(aliases, { recursive: true, force: true });
  }
});

await test("symlink ancestors pointing inside the checkout are also refused", () => {
  const f = fixture();
  try {
    f.write("tracked/file.json", "{}\n");
    f.write("actual/file.json", "{}\n");
    f.git("add", "tracked/file.json");
    rmSync(resolve(f.root, "tracked"), { recursive: true });
    symlinkSync("actual", resolve(f.root, "tracked"));
    const result = f.run("format-check");
    assertFailure(result);
    assert.match(result.stderr, /Indexed symlink.*tracked\/file\.json/u);
  } finally {
    f.close();
  }
});

await test("indexed symlinks cannot become selected regular files through working-copy replacement", () => {
  const f = fixture();
  try {
    f.write("target.json", "{}\n");
    symlinkSync("target.json", resolve(f.root, "linked.json"));
    f.git("add", "linked.json");
    unlinkSync(resolve(f.root, "linked.json"));
    f.write("linked.json", "{}\n");
    const result = f.run("format-check");
    assertFailure(result);
    assert.match(result.stderr, /Indexed symlink.*linked\.json/u);
  } finally {
    f.close();
  }
});

await test("empty index never falls back to directory scanning; missing tools and Git fail closed", () => {
  const f = fixture();
  try {
    f.write("bad.json", "{bad");
    f.write("bad.md", "# Bad\n\nhttp://bare.example\n");
    assertSuccess(f.run("format-check"));
    assertSuccess(f.run("markdownlint"));
    f.git("add", "bad.json");
    unlinkSync(resolve(f.root, "node_modules/.bin/oxfmt"));
    const missing = f.run("format-check");
    assertFailure(missing);
    assert.match(missing.stderr, /npm ci/u);
    f.git("add", "bad.md");
    unlinkSync(resolve(f.root, "node_modules/markdownlint-cli2"));
    const missingMarkdown = f.run("markdownlint");
    assertFailure(missingMarkdown);
    assert.match(missingMarkdown.stderr, /Unable to locate markdownlint-cli2; run npm ci/u);
    symlinkSync("bad.json", resolve(f.root, "linked.json"));
    f.git("add", "linked.json");
    const symlink = f.run("format-check");
    assertFailure(symlink);
    assert.match(symlink.stderr, /Indexed symlink/u);
    assertFailure(f.run("format-check", f.root, { ...process.env, PATH: "" }));
    rmSync(resolve(f.root, ".git"), { recursive: true });
    assertFailure(f.run("format-check"));
  } finally {
    f.close();
  }
});

await test("tool exit status and signal are not masked; batches stop at first failure", () => {
  const f = fixture();
  try {
    for (let n = 0; n < 130; n++) {
      f.write(`source-${n}.json`, "{}\n");
    }
    f.git("add", ".");
    const tool = resolve(f.root, "node_modules/.bin/oxfmt");
    unlinkSync(tool);
    writeFileSync(
      tool,
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.TOOL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exitCode = 17;\n`,
    );
    chmodSync(tool, 0o755);
    const log = resolve(f.root, "tool-log");
    const result = f.run("format-check", f.root, { ...process.env, TOOL_LOG: log });
    assert.equal(result.status, 17);
    assert.match(result.stderr, /rerun npm run format:check/u);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
    unlinkSync(log);
    writeFileSync(
      tool,
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.TOOL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    );
    assertSuccess(f.run("format-check", f.root, { ...process.env, TOOL_LOG: log }));
    const batches = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => parseBatch(line));
    assert.equal(batches.length, 3);
    assert.deepEqual(
      batches.map((batch) => batch.slice(0, 2)),
      Array.from({ length: 3 }, () => ["--check", "--threads=2"]),
    );
    assert.deepEqual(
      batches.map((batch) => batch.length - 2),
      [64, 64, 4],
    );
    const paths = batches.flatMap((batch) => batch.slice(2));
    assert.equal(new Set(paths).size, 132);
    assert.ok(paths.includes("./.oxfmtrc.json"));
    assert.ok(paths.includes("./config/markdownlint-cli2.yaml"));
    for (let n = 0; n < 130; n++) {
      assert.ok(paths.includes(`./source-${n}.json`));
    }
    writeFileSync(tool, `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM');\n`);
    const interrupted = f.run("format-check");
    assertFailure(interrupted);
    assert.match(interrupted.stderr, /interrupted.*SIGTERM/u);
    assert.doesNotMatch(interrupted.stderr, /npm ci/u);
    f.write("README.md", "# Fixture\n");
    f.git("add", "README.md");
    unlinkSync(resolve(f.root, "node_modules/markdownlint-cli2"));
    f.write("node_modules/markdownlint-cli2/package.json", '{"exports":"./index.mjs"}');
    f.write(
      "node_modules/markdownlint-cli2/index.mjs",
      'throw new Error("Do not import the library");',
    );
    const markdownTool = "node_modules/markdownlint-cli2/markdownlint-cli2-bin.mjs";
    f.write(markdownTool, `#!${process.execPath}\nprocess.exitCode = 23;\n`);
    chmodSync(resolve(f.root, markdownTool), 0o755);
    const markdownFailure = f.run("markdownlint");
    assert.equal(markdownFailure.status, 23);
    assert.match(markdownFailure.stderr, /rerun npm run markdownlint/u);
    f.write(markdownTool, `#!${process.execPath}\nprocess.kill(process.pid, 'SIGTERM');\n`);
    const markdownInterrupted = f.run("markdownlint");
    assertFailure(markdownInterrupted);
    assert.match(markdownInterrupted.stderr, /interrupted.*SIGTERM/u);
    assert.doesNotMatch(markdownInterrupted.stderr, /npm ci/u);
  } finally {
    f.close();
  }
});
