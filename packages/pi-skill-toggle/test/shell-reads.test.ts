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

  // Documented limitation (README "Limitations" points here for the exact list): the shell check is fail-open here. Inline
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

describe("pathsReadByCommand follows bash scoping and expansion", () => {
  test.each([
    ["cd web | cat AGENTS.md", ["/repo/AGENTS.md"]],
    ["cd web |& cat AGENTS.md", ["/repo/AGENTS.md"]],
    ["cd web & cat AGENTS.md", ["/repo/AGENTS.md"]],
    ["cd web &\ncat AGENTS.md", ["/repo/AGENTS.md"]],
    ["cd web && cat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ["cd web; cat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ["cd web\ncat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ["cd web || cat AGENTS.md", ["/repo/web/AGENTS.md"]],
    ["cd web && cat a | cat b", ["/repo/web/a", "/repo/web/b"]],
    // A newline ends a list, so a `cd` before it scopes later lines, but a pipeline element
    // runs in a subshell and its `cd` never leaks past the newline.
    ["true | cd web\ncat a", ["/repo/a"]],
    // The newline ends the list, so `cd web` applies to both background jobs on the next line.
    ["cd web\ncat a & cat b", ["/repo/web/a", "/repo/web/b"]],
    // A newline after `|` continues the pipeline: `cd web` is still a subshell element.
    ["cat a |\ncd web; cat b", ["/repo/a", "/repo/b"]],
    ["cd web |\ncat a", ["/repo/a"]],
    ["cd web |&\ncat a", ["/repo/a"]],
    // A newline after `&&` continues the and-list, which `&` then backgrounds as a whole.
    ["cd web &&\ntrue & cat b", ["/repo/b"]],
    ["cd web &&\ncat a", ["/repo/web/a"]],
    ["cd web ||\ncat a", ["/repo/web/a"]],
    ["cat {AGENTS,README}.md", []],
    ["cat {1..3}.md", []],
    ["cat ~user/x", []],
    ["cat ~+/x", []],
    ["cat ~/x", [join(homedir(), "x")]],
    ["command cat AGENTS.md", ["/repo/AGENTS.md"]],
    ["command -p cat AGENTS.md", ["/repo/AGENTS.md"]],
    ["ksh -c 'cat AGENTS.md'", ["/repo/AGENTS.md"]],
    ["mksh -c 'cat AGENTS.md'", ["/repo/AGENTS.md"]],
    ["ash -c 'cat AGENTS.md'", ["/repo/AGENTS.md"]],
    // Brace choice: bash expands only a comma list or a `x..y` sequence, so `{}`, `{a}`, `{..}`
    // and quoted braces stay literal and are still reported.
    ["cat {}", ["/repo/{}"]],
    ["cat {a}", ["/repo/{a}"]],
    ["cat {..}", ["/repo/{..}"]],
    ['cat "{a,b}"', ["/repo/{a,b}"]],
    [String.raw`cat \{a,b\}`, ["/repo/{a,b}"]],
  ])("%s", (command, expected) => {
    expect(reads(command)).toStrictEqual(expected.toSorted());
  });

  test.each(["command -v cat AGENTS.md", "command -V cat AGENTS.md"])("%s only describes", (c) => {
    expect(reads(c)).toStrictEqual([]);
  });
});

// Known limits: each form reads AGENTS.md in bash, but the guard does not see it. Pinned so any
// change is deliberate; see README "Limitations".
describe("pathsReadByCommand known limits (fail-open)", () => {
  test.each([
    'echo "$(<AGENTS.md)"',
    "cat <<< AGENTS.md",
    "xargs cat <<< AGENTS.md",
    'eval "cat AGENTS.md"',
    "find . -name AGENTS.md -exec cat {} +",
    "tr a b < AGENTS.md",
    "while read l; do :; done < AGENTS.md",
    "cat $'AGENTS.md'",
    "rg -n pattern",
    "rg -uu pattern",
    "grep -r pattern",
    "jq -R . AGENTS.md",
    "cmp AGENTS.md /dev/null; tr a-z a-z < AGENTS.md",
    'while IFS= read -r l; do echo "$l"; done < AGENTS.md',
    "awk 'BEGIN{while((getline l < \"AGENTS.md\")>0) print l}'",
    "tar cf - AGENTS.md | tar xOf -",
  ])("%s", (command) => {
    expect(reads(command)).toStrictEqual([]);
  });

  // The read is of a directory or of a copy the analyser cannot connect to the protected file.
  // The guard still compares the reported path's file identity, but only for links that already
  // exist when the command starts.
  test.each([
    ["grep -r pattern .", ["/repo"]],
    ["rg pattern .", ["/repo"]],
    ["grep -R pattern /repo", ["/repo"]],
    ["cp AGENTS.md copy.txt && cat copy.txt", ["/repo/copy.txt"]],
    ["ln AGENTS.md copy.txt; cat copy.txt", ["/repo/copy.txt"]],
    ["mv AGENTS.md m.txt; cat m.txt", ["/repo/m.txt"]],
    ["sed 'r AGENTS.md' other.txt", ["/repo/other.txt"]],
  ])("%s", (command, expected) => {
    expect(reads(command)).toStrictEqual(expected);
  });
});

describe("pathsReadByCommand reads plain file readers", () => {
  test.each([
    "sort AGENTS.md",
    "sort -r -k2 AGENTS.md",
    "sort -t, -k 2 AGENTS.md",
    "uniq AGENTS.md",
    "paste AGENTS.md",
    "paste -d, AGENTS.md",
    "rev AGENTS.md",
    "column -t AGENTS.md",
    "fmt -w 60 AGENTS.md",
    "expand -t 4 AGENTS.md",
    "unexpand AGENTS.md",
    "pr AGENTS.md",
    "pr -h title AGENTS.md",
    "comm -3 AGENTS.md /dev/null",
    "hexdump -C AGENTS.md",
    "dd if=AGENTS.md",
    "dd if=AGENTS.md of=/dev/stdout bs=1k 2>/dev/null",
    "dd bs=1 if=AGENTS.md",
    "dd if=/repo/AGENTS.md",
    "env LC_ALL=C sort AGENTS.md",
  ])("%s", (command) => {
    expect(reads(command)).toContain("/repo/AGENTS.md");
  });

  test.each([
    "sort",
    "echo x | sort -u | uniq -c",
    "sort < /dev/null",
    "dd of=out.bin bs=1k count=1",
    "dd if=/dev/zero of=out.bin count=1",
    "cat x | column -t",
    "ls | sort -r",
    "sort -o sorted.txt -",
  ])("%s", (command) => {
    expect(reads(command).filter((path) => path.endsWith("AGENTS.md"))).toStrictEqual([]);
  });
});

describe("pathsReadByCommand bounds pathological input", () => {
  test("a very long chain of cd stops resolving relative paths instead of growing quadratically", () => {
    // The tracked directory would exceed any file system's path limit long before this chain ends.
    expect(reads(`${"cd a;".repeat(5000)} cat AGENTS.md`)).toStrictEqual([]);
    // Short chains are exact.
    expect(reads(`${"cd a;".repeat(20)} cat AGENTS.md`)).toStrictEqual([
      `/repo/${"a/".repeat(20)}AGENTS.md`,
    ]);
  });

  test("a command over the size cap is not analysed, so the guard fails open", () => {
    const filler = "echo x;".repeat(15_000);
    expect(reads(`${filler} cat AGENTS.md`)).toStrictEqual([]);
    expect(reads(`cat AGENTS.md; ${filler}`)).toStrictEqual([]);
    expect(reads("cat AGENTS.md; echo x;")).toStrictEqual(["/repo/AGENTS.md"]);
  });

  test("a command near the cap with a worst-case cd chain returns promptly", () => {
    const started = performance.now();
    reads("cd a;".repeat(19_990));
    // Unfixed this takes seconds (about 8 s); the bound is generous for loaded machines.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
