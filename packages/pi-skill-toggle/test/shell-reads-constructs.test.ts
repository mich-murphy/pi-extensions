import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, test } from "vitest";
import { pathsReadByCommand } from "../shell-reads";

const cwd = "/repo";

function reads(command: string): readonly string[] {
  return pathsReadByCommand(command, cwd).toSorted();
}

function paths(...names: string[]): readonly string[] {
  return names.map((name) => resolve(cwd, name)).toSorted();
}

// Each expectation was taken from real `bash -c` with `cat` replaced by a function that prints its
// arguments, so the paths are what bash actually hands to cat.
describe("brace expansion", () => {
  test("alternatives become separate words", () => {
    assert.deepEqual(reads("cat {a,secret}"), paths("a", "secret"));
    assert.deepEqual(reads("cat dir/{a,b}/SKILL.md"), paths("dir/a/SKILL.md", "dir/b/SKILL.md"));
    assert.deepEqual(reads("cat {a,b}{c,d}"), paths("ac", "ad", "bc", "bd"));
    assert.deepEqual(reads("cat {a,b}=c"), paths("a=c", "b=c"));
  });

  test("nested alternatives", () => {
    assert.deepEqual(reads("cat {a,{b,c}}"), paths("a", "b", "c"));
    assert.deepEqual(reads("cat {a{b,c}}"), paths("{ab}", "{ac}"));
    assert.deepEqual(reads("cat {x{a,b}"), paths("{xa", "{xb"));
    assert.deepEqual(reads("cat {a}b{c,d}"), paths("{a}bc", "{a}bd"));
  });

  test("numeric and letter sequences", () => {
    assert.deepEqual(reads("cat {1..3}"), paths("1", "2", "3"));
    assert.deepEqual(reads("cat {3..1}"), paths("1", "2", "3"));
    assert.deepEqual(reads("cat {a..c}"), paths("a", "b", "c"));
    assert.deepEqual(reads("cat {1..10..3}"), paths("1", "4", "7", "10"));
    assert.deepEqual(reads("cat {c..a..2}"), paths("a", "c"));
    // Words that start with a dash are options, never files.
    assert.deepEqual(reads("cat {-2..2}"), paths("0", "1", "2"));
    assert.deepEqual(reads("cat {a..a}"), paths("a"));
  });

  test("a step of zero or below is a step of one", () => {
    assert.deepEqual(reads("cat {1..3..0}"), paths("1", "2", "3"));
    assert.deepEqual(reads("cat {1..3..-1}"), paths("1", "2", "3"));
  });

  test("zero padding", () => {
    assert.deepEqual(reads("cat {01..03}"), paths("01", "02", "03"));
    assert.deepEqual(reads("cat {1..03}"), paths("01", "02", "03"));
  });

  test("empty alternatives", () => {
    assert.deepEqual(reads("cat {,x}"), paths("x"));
    assert.deepEqual(reads("cat x{,}"), paths("x"));
    assert.deepEqual(reads("cat dir/{a,}"), paths("dir/a", "dir"));
  });

  test("forms that do not expand stay literal", () => {
    assert.deepEqual(reads("cat {a}"), paths("{a}"));
    assert.deepEqual(reads("cat {}"), paths("{}"));
    assert.deepEqual(reads('cat "{a,b}"'), paths("{a,b}"));
    assert.deepEqual(reads("cat '{a,b}'"), paths("{a,b}"));
    assert.deepEqual(reads(String.raw`cat \{a,b\}`), paths("{a,b}"));
    assert.deepEqual(reads("cat {a,b"), paths("{a,b"));
    assert.deepEqual(reads("cat {1..c}"), paths("{1..c}"));
    assert.deepEqual(reads("cat {1..}"), paths("{1..}"));
    assert.deepEqual(reads("cat {a..bb}"), paths("{a..bb}"));
    assert.deepEqual(reads("cat {1.2}"), paths("{1.2}"));
    assert.deepEqual(reads("cat ${x}"), []);
  });

  test("quoted or escaped separators do not split", () => {
    assert.deepEqual(reads('cat {a,"b,c"}'), paths("a", "b,c"));
    assert.deepEqual(reads(String.raw`cat {a\,b,c}`), paths("a,b", "c"));
  });

  test("a dynamic alternative leaves the others", () => {
    assert.deepEqual(reads("cat {secret,$x}"), paths("secret"));
    assert.deepEqual(reads("cat {a,$(cat inner)}"), paths("a", "inner"));
  });

  test("expansion works in command position, loops and with a tilde", () => {
    assert.deepEqual(reads("{cat,secret}"), paths("secret"));
    assert.deepEqual(reads("for f in {a,secret}; do cat $f; done"), paths("a", "secret"));
    assert.deepEqual(reads("cat ~/{a,b}"), [resolve(homedir(), "a"), resolve(homedir(), "b")]);
  });

  test("an expansion past the cap is left unresolved, like any dynamic word", () => {
    assert.deepEqual(reads("cat {1..100000}"), []);
    assert.deepEqual(reads("cat {1..257}"), []);
    assert.equal(reads("cat {1..256}").length, 256);
    assert.deepEqual(reads("cat {1..20}{1..20}"), []);
    assert.deepEqual(reads(`cat ${"{a,".repeat(40)}x${"}".repeat(40)}`), []);
    assert.deepEqual(reads(`cat ${"{".repeat(50_000)}`), []);
  });

  test("one command expands at most 4096 words, then leaves later braces unresolved", () => {
    const words = Array.from(
      { length: 20 },
      (_, index) => `${String.fromCodePoint(97 + index)}x{1..256}`,
    ).join(" ");
    const found = reads(`cat ${words}`);
    assert.equal(found.length, 16 * 256);
    assert.ok(found.includes(resolve(cwd, "px256")));
    assert.ok(!found.includes(resolve(cwd, "qx256")));
  });
});

describe("trap", () => {
  test("the action is a command", () => {
    assert.deepEqual(reads("trap 'cat secret' EXIT"), paths("secret"));
    assert.deepEqual(reads('trap "cat secret" EXIT'), paths("secret"));
    assert.deepEqual(reads("trap -- 'cat secret' EXIT"), paths("secret"));
    assert.deepEqual(reads("trap 'echo a; cat secret' INT TERM"), paths("secret"));
    assert.deepEqual(reads('trap "cat secret; rm $tmp" EXIT'), paths("secret"));
  });

  test("resetting, ignoring and listing read nothing", () => {
    assert.deepEqual(reads("trap - EXIT"), []);
    assert.deepEqual(reads("trap '' INT"), []);
    assert.deepEqual(reads("trap -p"), []);
    assert.deepEqual(reads("trap -l"), []);
    assert.deepEqual(reads("trap"), []);
  });

  test("a lone operand is a signal, not an action", () => {
    assert.deepEqual(reads("trap 'cat secret'"), []);
  });
});

describe("coproc", () => {
  test("the command after coproc runs", () => {
    assert.deepEqual(reads("coproc cat secret"), paths("secret"));
    assert.deepEqual(reads("coproc { cat secret; }"), paths("secret"));
    assert.deepEqual(reads("coproc NAME { cat secret; }"), paths("secret"));
    assert.deepEqual(reads("coproc NAME (cat secret)"), paths("secret"));
    assert.deepEqual(reads("coproc (cat secret)"), paths("secret"));
  });

  test("an escaped or quoted brace is an argument, not a group", () => {
    assert.deepEqual(reads(String.raw`coproc cat \{`), paths("{"));
    assert.deepEqual(reads("coproc cat '{'"), paths("{"));
  });

  test("a name before a simple command is the command", () => {
    assert.deepEqual(reads("coproc NAME cat secret"), []);
  });

  test("keeps working directory handling inside the group", () => {
    assert.deepEqual(
      reads("coproc NAME { cd d; cat secret; }; cat after"),
      paths("d/secret", "after"),
    );
  });
});

describe("source", () => {
  test("the file is read, and extra arguments are not files", () => {
    assert.deepEqual(reads("source secret"), paths("secret"));
    assert.deepEqual(reads(". secret"), paths("secret"));
    assert.deepEqual(reads("source secret a b"), paths("secret"));
    assert.deepEqual(reads("source ./secret"), paths("secret"));
    assert.deepEqual(reads("source -- secret"), paths("secret"));
    assert.deepEqual(reads("source /abs/secret"), ["/abs/secret"]);
    assert.deepEqual(reads("cd d && source secret"), paths("d/secret"));
    assert.deepEqual(reads(". ~/.nvm/nvm.sh"), [resolve(homedir(), ".nvm/nvm.sh")]);
  });

  test("other commands that mention the words are unaffected", () => {
    assert.deepEqual(reads("echo . source"), []);
    assert.deepEqual(reads("source"), []);
    assert.deepEqual(reads("source_dir=x; echo $source_dir"), []);
  });
});

describe("literal defaults in parameter expansion", () => {
  test("a default, assigned default or alternative word is a possible path", () => {
    assert.deepEqual(reads('cat "${x:-secret}"'), paths("secret"));
    assert.deepEqual(reads("cat ${x:-secret}"), paths("secret"));
    assert.deepEqual(reads("cat ${x-secret}"), paths("secret"));
    assert.deepEqual(reads("cat ${x:=secret}"), paths("secret"));
    assert.deepEqual(reads("cat ${x=secret}"), paths("secret"));
    assert.deepEqual(reads("cat ${x:+alt}"), paths("alt"));
    assert.deepEqual(reads("cat ${x+alt}"), paths("alt"));
    assert.deepEqual(reads("cat ${1:-pos}"), paths("pos"));
  });

  test("the default is itself a word", () => {
    assert.deepEqual(reads('cat ${x:-"a b"}'), paths("a b"));
    assert.deepEqual(reads('cat "${x:-a b}"'), paths("a b"));
    assert.deepEqual(reads("cat ${x:-${y:-deep}}"), paths("deep"));
    assert.deepEqual(reads("cat ${x:-pre/$HOME}"), paths(`pre/${homedir()}`));
    assert.deepEqual(reads("cat ${x:-{a,b}}"), paths("{a,b}"));
    assert.deepEqual(reads("cat dir/${x:-secret}.md"), paths("dir/secret.md"));
  });

  test("single quotes are ordinary characters in a double-quoted default", () => {
    assert.deepEqual(reads(`cat "\${x:-'q r'}"`), paths("'q r'"));
    assert.deepEqual(reads(`cat \${x:-'q r'}`), paths("q r"));
  });

  test("a loop variable is set, so its value is read instead of the default", () => {
    assert.deepEqual(
      reads('for p in AGENTS.md; do cat "${p:-public.txt}"; done'),
      paths("AGENTS.md"),
    );
    assert.deepEqual(reads("for p in AGENTS.md; do cat ${p-public.txt}; done"), paths("AGENTS.md"));
    assert.deepEqual(reads('for p in AGENTS.md; do cat "${p:+alt}"; done'), paths("alt"));
  });

  test("HOME is known, so its default is not used", () => {
    assert.deepEqual(reads("cat ${HOME:-d}"), [homedir()]);
    assert.deepEqual(reads("cat ${HOME:+alt}"), paths("alt"));
  });

  test("dynamic or empty defaults stay unresolved", () => {
    assert.deepEqual(reads("cat ${x:-$y}"), []);
    assert.deepEqual(reads("cat ${x:-pre$y}"), []);
    assert.deepEqual(reads("cat ${x:-$(cat z)}"), paths("z"));
    assert.deepEqual(reads("cat ${x:-}"), []);
    assert.deepEqual(reads("cat ${x:?e}"), []);
    assert.deepEqual(reads("cat ${x%.txt}.md"), []);
    assert.deepEqual(reads("cat ${x:-a b}"), []);
    assert.deepEqual(reads(`cat ${"${x:-".repeat(5000)}a${"}".repeat(5000)}`), []);
  });
});

describe("benign commands", () => {
  const benign = [
    'git commit -m "fix {a,b}"',
    "echo {1..3}",
    'find . -name "*.{js,ts}"',
    "trap 'rm -f \"$tmp\"' EXIT",
    'echo "${HOME:-/tmp}"',
    "docker run -e X={a,b} img",
    "ls {a,b}",
    "npm run build -- --env={dev,prod}",
    "echo ${x:-default} done",
    "bash -c 'echo {a,b}'",
    "ssh host 'cat {a,b}'",
    "mkdir -p a/{b,c}",
    "trap cleanup EXIT",
    "trap 'echo bye' EXIT INT",
    "coproc sleep 1",
    "python -c 'print({1,2})'",
    "cat ${x%.txt}.md",
    "echo $(( 1 + 2 ))",
  ];

  test("none read a file", () => {
    for (const command of benign) {
      assert.deepEqual(reads(command), [], command);
    }
  });
});
