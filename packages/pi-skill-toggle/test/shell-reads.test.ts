import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pathsReadByCommand } from "../shell-reads";

const cwd = "/repo";

function reads(command: string): readonly string[] {
  return pathsReadByCommand(command, cwd).toSorted();
}

describe("pathsReadByCommand reports content reads", () => {
  test.each([
    ["cat AGENTS.md", ["/repo/AGENTS.md"]],
    ["cat AGENTS.md web/agent/AGENTS.md", ["/repo/AGENTS.md", "/repo/web/agent/AGENTS.md"]],
    ["head -n 40 AGENTS.md", ["/repo/AGENTS.md"]],
    ["tail -20 .agents/skills/x/SKILL.md", ["/repo/.agents/skills/x/SKILL.md"]],
    ["sed -n '1,200p' .agents/skills/x/SKILL.md", ["/repo/.agents/skills/x/SKILL.md"]],
    ["sed -n -e 1,20p AGENTS.md", ["/repo/AGENTS.md"]],
    ["awk 'NR<10' AGENTS.md", ["/repo/AGENTS.md"]],
    ["nl -ba AGENTS.md", ["/repo/AGENTS.md"]],
    ["rg -n Fallow AGENTS.md", ["/repo/AGENTS.md"]],
    ["grep -A3 'pr-landing' AGENTS.md", ["/repo/AGENTS.md"]],
    ["grep -e x -e y AGENTS.md", ["/repo/AGENTS.md"]],
    ["cat < AGENTS.md", ["/repo/AGENTS.md"]],
    ['cat "AGENTS.md"', ["/repo/AGENTS.md"]],
    ["cat /abs/path/AGENTS.md", ["/abs/path/AGENTS.md"]],
    ["cat ./x/../AGENTS.md", ["/repo/AGENTS.md"]],
    ["cd web && cat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ["(cd web; cat AGENTS.md); cat AGENTS.md", ["/repo/AGENTS.md", "/repo/web/AGENTS.md"]],
    ["git status && cat AGENTS.md | head", ["/repo/AGENTS.md"]],
    ["env LC_ALL=C cat AGENTS.md", ["/repo/AGENTS.md"]],
    ["timeout 5 cat AGENTS.md", ["/repo/AGENTS.md"]],
    ["bash -c 'cat AGENTS.md'", ["/repo/AGENTS.md"]],
    ["echo $(cat AGENTS.md)", ["/repo/AGENTS.md"]],
    [
      String.raw`for p in AGENTS.md web/AGENTS.md; do printf '%s\n' "$p"; cat "$p"; done`,
      ["/repo/AGENTS.md", "/repo/web/AGENTS.md"],
    ],
    [
      "for f in AGENTS.md x/SKILL.md\ndo\n  sed -n '1,80p' \"$f\"\ndone",
      ["/repo/AGENTS.md", "/repo/x/SKILL.md"],
    ],
    ["python3 -c \"print(open('AGENTS.md').read())\"", ["/repo/AGENTS.md"]],
    [
      "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('.agents/skills/x/SKILL.md').read_text())\nPY",
      ["/repo/.agents/skills/x/SKILL.md"],
    ],
    [
      "node -e \"console.log(require('fs').readFileSync('AGENTS.md','utf8'))\"",
      ["/repo/AGENTS.md"],
    ],
    ["cat ~/.agents/skills/x/SKILL.md", [join(homedir(), ".agents/skills/x/SKILL.md")]],
    ["cat $HOME/AGENTS.md", [join(homedir(), "AGENTS.md")]],
  ])("%s", (command, expected) => {
    expect(reads(command)).toStrictEqual(expected.toSorted());
  });
});

describe("pathsReadByCommand ignores commands that print no file content", () => {
  test.each([
    "find . -name AGENTS.md",
    "ls .agents/skills/x",
    "rg --files -g AGENTS.md",
    "rg -l pr-landing AGENTS.md",
    "grep -c x AGENTS.md",
    "grep -q x AGENTS.md",
    "wc -l AGENTS.md",
    "wc -l < AGENTS.md",
    "stat AGENTS.md",
    "test -f AGENTS.md",
    "sed -i 's/a/b/' .agents/skills/x/SKILL.md",
    "sed -i.bak -e 's/a/b/' AGENTS.md",
    "perl -pi -e 's/a/b/' AGENTS.md",
    "awk -i inplace '{print}' AGENTS.md",
    "cp AGENTS.md /tmp/x",
    "mv AGENTS.md OLD.md",
    "echo hi > AGENTS.md",
    "printf x >> AGENTS.md",
    "git diff -- AGENTS.md",
    "git show HEAD:AGENTS.md",
    "git log -p -- AGENTS.md",
    "git add AGENTS.md && git commit -m 'update AGENTS.md'",
    "echo 'cat AGENTS.md'",
    "echo AGENTS.md",
    "# cat AGENTS.md",
    "cat $FILE",
    'cat "$dir/AGENTS.md"',
    "cat *.md",
    "cat AGENTS.*",
    'for p in AGENTS.md web/AGENTS.md; do test -f "$p" && echo "$p"; done',
    'for p in AGENTS.md; do wc -l "$p"; done',
    "python3 -c \"import os; print(os.path.exists('AGENTS.md'))\"",
    "python3 script.py AGENTS.md",
    "node build.js",
    "npm run build",
    "command -v cat",
    "cat <<'EOF' > notes.txt\ncat AGENTS.md\nEOF",
    "cat -",
  ])("%s", (command) => {
    expect(reads(command)).toStrictEqual([]);
  });

  test("a heredoc body is data unless it feeds a shell or interpreter", () => {
    expect(reads("cat <<EOF\nAGENTS.md\nEOF")).toStrictEqual([]);
    expect(reads("bash <<EOF\ncat AGENTS.md\nEOF")).toStrictEqual(["/repo/AGENTS.md"]);
  });

  test("a loop list counts only when a reader in the body takes a variable", () => {
    expect(reads('for p in AGENTS.md; do cat other.md; echo "$p"; done')).toStrictEqual([
      "/repo/other.md",
    ]);
  });

  test("a later loop does not inherit an earlier loop's reads", () => {
    expect(
      reads('for f in a.md; do cat "$f"; done; for p in AGENTS.md; do echo "$p"; done'),
    ).toStrictEqual(["/repo/a.md"]);
  });

  test("a dynamic cd stops relative paths from resolving", () => {
    expect(reads('cd "$DIR" && cat AGENTS.md')).toStrictEqual([]);
    expect(reads('cd "$DIR" && cat /abs/AGENTS.md')).toStrictEqual(["/abs/AGENTS.md"]);
  });

  test("tolerates malformed input", () => {
    for (const command of ["cat 'AGENTS.md", "echo $(", 'cat "x', "for p in", "done", "(((", ""]) {
      expect(() => pathsReadByCommand(command, cwd)).not.toThrow();
    }
  });
});
