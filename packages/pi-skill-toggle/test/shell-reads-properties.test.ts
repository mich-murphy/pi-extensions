import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import * as gs from "@hegeldev/hegel/generators";
import { describe, test } from "vitest";
import { pathsReadByCommand } from "../shell-reads";
import { assertProperty } from "./hegel-property";

const cwd = "/repo";

function reads(command: string): readonly string[] {
  return pathsReadByCommand(command, cwd).toSorted();
}

// ---- Generators -----------------------------------------------------------------------------

const SAFE = /^[a-z0-9._]$/u;
const escapeBackslash = (char: string): string => `\\${char}`;
const escapeDouble = (char: string): string => ('$`"\\'.includes(char) ? `\\${char}` : char);

/** Encode a chunk of characters so a shell reads it back as exactly those characters. */
function encodeChunk(chunk: readonly string[], scheme: number): string {
  const safe = chunk.every((char) => SAFE.test(char));
  const escaped = chunk.map((char) => escapeBackslash(char));
  switch (scheme) {
    case 0: {
      return safe ? chunk.join("") : escaped.join("");
    }
    case 1: {
      return escaped.join("\\\n");
    }
    case 2: {
      return chunk.includes("'") ? escaped.join("") : `'${chunk.join("")}'`;
    }
    case 3: {
      return `"${chunk.map((char) => escapeDouble(char)).join("")}"`;
    }
    case 4: {
      return `"${chunk.map((char) => escapeDouble(char)).join("\\\n")}"`;
    }
    default: {
      return safe ? chunk.join("\\\n") : escaped.join("");
    }
  }
}

type Quoted = { readonly word: string; readonly source: string };

/** A literal word, and shell source that denotes exactly that word. */
const quoted = gs.composite((tc): Quoted => {
  const first = tc.draw(gs.sampledFrom("abc/.~*{$".split("")));
  const rest = tc.draw(gs.text({ alphabet: "abc/. *?[{}~$`'\"\\#;&|<>()=,", maxSize: 8 }));
  const chars = (first + rest).split("");
  let source = "";
  for (let index = 0; index < chars.length;) {
    const size = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
    const scheme = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
    source += encodeChunk(chars.slice(index, index + size), scheme);
    index += size;
  }
  return { word: chars.join(""), source };
});

const directory = gs.text({ alphabet: "abcdefg", minSize: 1, maxSize: 4 });
const plain = gs.text({ alphabet: "abc.", maxSize: 4 });
const SHELL_NOISE = "cat ab'\"\\$`(){}<>|&;#~*?[]\n-=!,.";
const TOKENS = [
  "cat",
  "bash -c",
  "'",
  '"',
  "$(",
  ")",
  "(",
  "|",
  "&",
  "&&",
  ";",
  "\n",
  "cd",
  "cd x",
  "<",
  "<<",
  "EOF",
  "`",
  "\\",
  "{",
  "}",
  "~",
  "*",
  "for f in a; do",
  "done",
  "$f",
  '"$f"',
  "a.md",
  "-n",
  "env",
  "timeout 5",
  "command",
  "xargs",
  "#",
];

function inSingleQuotes(script: string): string {
  return `'${script.replaceAll("'", String.raw`'\''`)}'`;
}

/** Ways to run a command that must not change which files it reads. */
const WRAPS: readonly ((command: string) => string)[] = [
  (command) => `${command}; true`,
  (command) => `true && ${command}`,
  (command) => `true\n${command}\ntrue`,
  (command) => `bash -c ${inSingleQuotes(command)}`,
  (command) => `sh -c ${inSingleQuotes(command)}`,
  (command) => `env X=1 ${command}`,
  (command) => `timeout 5 ${command}`,
  (command) => `command ${command}`,
  (command) => `command -p ${command}`,
  (command) => `echo $(${command})`,
  (command) => `(${command})`,
];

function wrapped(index: number, command: string): string {
  return WRAPS[index]?.(command) ?? "";
}

// ---- Properties -----------------------------------------------------------------------------

describe("pathsReadByCommand properties", () => {
  test("never throws and only returns absolute normalized paths", () => {
    assertProperty(
      "shell-reads",
      "never throws and only returns absolute normalized paths",
      (tc) => {
        const source = tc.draw(
          gs.oneOf(
            gs.text({ alphabet: SHELL_NOISE, maxSize: 60 }),
            gs.arrays(gs.sampledFrom(TOKENS), { maxSize: 14 }).map((parts) => parts.join(" ")),
          ),
          "source",
        );
        for (const path of pathsReadByCommand(source, cwd)) {
          assert.ok(isAbsolute(path), path);
          assert.equal(resolve(path), path);
        }
      },
    );
  });

  test("cat reports exactly the word that any quoting scheme encodes", () => {
    assertProperty(
      "shell-reads",
      "cat reports exactly the word that any quoting scheme encodes",
      (tc) => {
        const { word, source } = tc.draw(quoted, "word");
        assert.deepEqual(reads(`cat ${source}`), [resolve(cwd, word)]);
      },
    );
  });

  // Found by HEGEL_SEED=15001035743802267891 at 2000 cases. `balanced` skips a double-quoted string up to
  // the next `"` without honouring `\"`, so the `)` inside the string closes the substitution early and
  // the file `")` that cat reads is never reported. Fails until `balanced` handles escapes in quotes.
  test("a substitution keeps a double-quoted string that holds an escaped quote and a parenthesis", () => {
    assert.deepEqual(reads(String.raw`echo $(cat "\")")`), [resolve(cwd, '")')]);
    assert.deepEqual(reads(String.raw`echo $(cat a\;"\")")`), [resolve(cwd, 'a;")')]);
  });

  test("wrappers, sequencing and substitution leave the read set unchanged", () => {
    assertProperty(
      "shell-reads",
      "wrappers, sequencing and substitution leave the read set unchanged",
      (tc) => {
        const { word, source } = tc.draw(quoted, "word");
        const wrap = tc.draw(gs.integers({ minValue: 0, maxValue: WRAPS.length - 1 }), "wrapper");
        const command = wrapped(wrap, `cat ${source}`);
        assert.deepEqual(reads(command), [resolve(cwd, word)], command);
      },
    );
  });

  // `${name:-word}` ends at its own closing brace however the word is quoted, and the substitutions
  // inside it run: the generator had never produced one, which is how the next bug hid.
  test("a parameter expansion default keeps its quoting and its substitutions", () => {
    assertProperty(
      "shell-reads",
      "a parameter expansion default keeps its quoting and its substitutions",
      (tc) => {
        const { word, source } = tc.draw(quoted, "word");
        const name = tc.draw(gs.sampledFrom(["x", "y1", "_v"]), "name");
        const operator = tc.draw(gs.sampledFrom([":-", "-", ":=", ":?", ":+", "+"]), "operator");
        const tail = tc.draw(directory, "tail");
        const expansion = `\${${name}${operator}${source}}`;
        const nested = `\${${name}${operator}\${y${operator}$(cat ${source})}}`;
        const read = [resolve(cwd, word)];
        assert.deepEqual(reads(`echo ${expansion} ; cat ${tail}`), [resolve(cwd, tail)]);
        assert.deepEqual(reads(`echo "${expansion}" ; cat ${tail}`), [resolve(cwd, tail)]);
        assert.deepEqual(reads(`echo \${${name}${operator}$(cat ${source})}`), read);
        assert.deepEqual(reads(`echo "\${${name}${operator}$(cat ${source})}"`), read);
        assert.deepEqual(
          reads(`echo ${nested} ; cat ${tail}`),
          [...new Set([resolve(cwd, tail), ...read])].toSorted(),
        );
      },
    );
  });

  // Arithmetic and an unquoted heredoc body run their substitutions; a quoted delimiter makes the body literal.
  test("a substitution in arithmetic or an unquoted heredoc runs, in a quoted heredoc it does not", () => {
    assertProperty(
      "shell-reads",
      "a substitution in arithmetic or an unquoted heredoc runs, in a quoted heredoc it does not",
      (tc) => {
        const { word, source } = tc.draw(quoted, "word");
        const literal = tc.draw(gs.sampledFrom(["'EOF'", '"EOF"', String.raw`\EOF`]), "delimiter");
        const dash = tc.draw(gs.sampledFrom(["<<", "<<-"]), "dash");
        const read = [resolve(cwd, word)];
        const substitution = `$(cat ${source})`;
        assert.deepEqual(reads(`echo $(( ${substitution} + 1 ))`), read, "arithmetic");
        assert.deepEqual(reads(`echo $(( 1 + ${substitution} ))`), read, "arithmetic operand");
        assert.deepEqual(reads(`cat ${dash}EOF\n${substitution}\nEOF`), read, "unquoted heredoc");
        assert.deepEqual(
          reads(`cat ${dash}${literal}\n${substitution}\nEOF`),
          [],
          "quoted heredoc",
        );
      },
    );
  });

  test("a cd scopes exactly as bash scopes it", () => {
    assertProperty("shell-reads", "a cd scopes exactly as bash scopes it", (tc) => {
      const { word, source } = tc.draw(quoted, "word");
      const dir = tc.draw(directory, "dir");
      const cat = `cat ${source}`;
      const inside = [resolve(cwd, dir, word)];
      const outside = [resolve(cwd, word)];
      assert.deepEqual(reads(`cd ${dir} && ${cat}`), inside);
      assert.deepEqual(reads(`cd ${dir}; ${cat}`), inside);
      assert.deepEqual(reads(`(cd ${dir}; ${cat})`), inside);
      assert.deepEqual(reads(`(cd ${dir}); ${cat}`), outside);
      assert.deepEqual(reads(`(cd ${dir} && true) && ${cat}`), outside);
      assert.deepEqual(reads(`cd ${dir} | ${cat}`), outside, "pipeline");
      assert.deepEqual(reads(`cd ${dir} |& ${cat}`), outside, "stderr pipeline");
      assert.deepEqual(reads(`cd ${dir} & ${cat}`), outside, "background");
      assert.deepEqual(reads(`${cat} | cd ${dir}; ${cat}`), outside, "last pipeline element");
      assert.deepEqual(reads(`{ cd ${dir}; } | ${cat}`), outside, "brace group in pipeline");
      assert.deepEqual(reads(`true | cd ${dir}\n${cat}`), outside, "newline after pipeline cd");
      assert.deepEqual(reads(`cd ${dir}\n${cat} & ${cat}`), inside, "newline ends the list");
      assert.deepEqual(reads(`${cat} |\ncd ${dir}; ${cat}`), outside, "pipe continuation");
      assert.deepEqual(reads(`cd ${dir} |\n${cat}`), outside, "pipe then newline");
      assert.deepEqual(reads(`cd ${dir} &&\n${cat}`), inside, "and then newline");
      assert.deepEqual(reads(`cd ${dir} &&\ntrue & ${cat}`), outside, "and-list backgrounded");
    });
  });

  test("words with an unknown expansion never produce a path", () => {
    assertProperty("shell-reads", "words with an unknown expansion never produce a path", (tc) => {
      const before = tc.draw(plain, "before");
      const after = tc.draw(plain, "after");
      const special = tc.draw(
        gs.sampledFrom([
          "*",
          "?",
          "[ab]",
          "$V",
          "${V}",
          "$(echo x)",
          "`echo x`",
          "{a,b}",
          "{1..3}",
        ]),
        "special",
      );
      assert.deepEqual(reads(`cat ${before}${special}${after}`), []);
      assert.deepEqual(reads(`cat ~user/${after}`), []);
      assert.deepEqual(reads(`cat ~${before}x`), []);
    });
  });

  test("a brace without a comma or range stays literal", () => {
    assertProperty("shell-reads", "a brace without a comma or range stays literal", (tc) => {
      const before = tc.draw(plain, "before");
      const inner = tc.draw(gs.text({ alphabet: "abc", maxSize: 4 }), "inner");
      const word = `${before}{${inner}}x`;
      assert.deepEqual(reads(`cat ${word}`), [resolve(cwd, word)]);
    });
  });

  test("commands that print no file content read nothing", () => {
    assertProperty("shell-reads", "commands that print no file content read nothing", (tc) => {
      const name = tc.draw(
        gs.sampledFrom(["echo", "ls", "git", "wc", "stat", "test", "true", "printf", "find", "cp"]),
        "name",
      );
      const args = tc.draw(gs.arrays(quoted, { maxSize: 4 }), "args");
      assert.deepEqual(reads(`${name} ${args.map((arg) => arg.source).join(" ")}`), []);
    });
  });
});
