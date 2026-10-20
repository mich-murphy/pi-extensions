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
    ["cd -- web && cat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ["cd -L web && cat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ["cd -P -- web && cat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ["cd -LP web && cat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ['cd web && echo "$(cat AGENTS.md)"', ["/repo/web/AGENTS.md"]],
    [
      '(cd web; echo "$(cat AGENTS.md)"); cat AGENTS.md',
      ["/repo/AGENTS.md", "/repo/web/AGENTS.md"],
    ],
    ["cd web && echo `cat AGENTS.md`", ["/repo/web/AGENTS.md"]],
    ["cd web && diff <(cat AGENTS.md) public.txt", ["/repo/web/AGENTS.md", "/repo/web/public.txt"]],
    [`cd web && bash -c 'echo "$(cat AGENTS.md)"'`, ["/repo/web/AGENTS.md"]],
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
    ["cat ~/.agents/skills/x/SKILL.md", [join(homedir(), ".agents/skills/x/SKILL.md")]],
    ["cat $HOME/AGENTS.md", [join(homedir(), "AGENTS.md")]],
    ["cat AGEN\\\nTS.md", ["/repo/AGENTS.md"]],
    ['cat "AGEN\\\nTS.md"', ["/repo/AGENTS.md"]],
    ['for p in AGENTS.md; do cat "${p}"; done', ["/repo/AGENTS.md"]],
    ["for p in AGENTS.md; do cat $p; done", ["/repo/AGENTS.md"]],
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

  test.each([
    "python3 -c \"print(open('AGENTS.md').read())\"",
    "python3 -c \"print(open('public.txt').read()); print('AGENTS.md')\"",
    "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('AGENTS.md').read_text())\nPY",
    "node -e \"console.log(require('fs').readFileSync('AGENTS.md','utf8'))\"",
    "node -e \"require('fs').readFileSync('public.txt'); console.log('AGENTS.md')\"",
    "perl -e \"print 'AGENTS.md'; read(X, Y, 1)\"",
    "ruby -e \"puts File.read('public.txt'); puts 'AGENTS.md'\"",
  ])("intentionally unsupported interpreter script: %s", (command) => {
    expect(reads(command)).toStrictEqual([]);
  });

  test.each([
    'for p in AGENTS.md; do cat "$q"; done',
    'for p in AGENTS.md; do cat "$p/public.txt"; done',
    'for p in AGENTS.md; do cat "${p:-public.txt}"; done',
    'for p in AGENTS.md; do cat "$(echo public.txt)"; done',
    "cd --unknown web && cat AGENTS.md",
    "cd web extra && cat AGENTS.md",
    "cd - && cat AGENTS.md",
    "cd -- - && cat AGENTS.md",
    'for p in public.txt AGENTS.md; do cd web; cat "$p"; done',
    'cd "$DIR" && echo "$(cat AGENTS.md)"',
  ])("skips unresolved paths: %s", (command) => {
    expect(reads(command)).toStrictEqual([]);
  });

  test.each([
    'for p in AGENTS.md; do for q in public.txt; do cat "$q"; done; done',
    'for p in AGENTS.md; do for p in public.txt; do cat "$p"; done; done',
    "for p in AGENTS.md; do while test true; do cat public.txt; done; done",
  ])("does not confuse enclosing loop bindings: %s", (command) => {
    expect(reads(command)).toStrictEqual(["/repo/public.txt"]);
  });

  test.each([
    'for p in AGENTS.md; do p=public.txt; cat "$p"; done',
    'for p in AGENTS.md; do p="$OTHER"; cat "$p"; done',
    'for p in AGENTS.md; do p=public.txt cat "$p"; cat "$p"; done',
    'for p in AGENTS.md; do for q in public.txt; do p=public.txt; done; cat "$p"; done',
  ])("skips a reassigned or temporarily shadowed loop binding: %s", (command) => {
    expect(reads(command)).toStrictEqual([]);
  });

  // Documented limitation (README "Limitations"): the shell check is fail-open here. Inline
  // interpreter code is not inspected, a loop value copied into another variable is not
  // tracked, and a temporary `name=value cmd` assignment makes that loop binding unknown for
  // the rest of the body. These pins catch accidental changes in either direction.
  test.each([
    "python3 -c \"print(open('AGENTS.md').read())\"",
    "node -e \"console.log(require('fs').readFileSync('AGENTS.md','utf8'))\"",
    "perl -e 'open(F, \"AGENTS.md\"); print <F>'",
    "ruby -e 'puts File.read(\"AGENTS.md\")'",
    'for f in AGENTS.md; do g=$f; cat "$g"; done',
    'for f in AGENTS.md; do g="$f"; cat "$g"; done',
    'for f in AGENTS.md; do f=x true; cat "$f"; done',
    'for f in AGENTS.md; do f=x cat "$f"; done',
  ])("documented unsupported form is not detected: %s", (command) => {
    expect(reads(command)).toStrictEqual([]);
  });

  test("assignment to another variable leaves the loop binding usable", () => {
    expect(reads('for p in AGENTS.md; do q=public.txt; cat "$p"; done')).toStrictEqual([
      "/repo/AGENTS.md",
    ]);
  });

  test("a heredoc body is data unless it feeds a shell", () => {
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
