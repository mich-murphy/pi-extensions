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

// Each expectation below was taken from real `bash -c` with `cat` replaced by a function that
// prints its arguments, so the paths are what bash actually hands to cat.
describe("escapes inside command substitutions", () => {
  test("an escaped quote does not close a double-quoted string inside $( )", () => {
    assert.deepEqual(reads(String.raw`echo $(cat "\")")`), paths('")'));
    assert.deepEqual(reads(String.raw`echo $(cat a\;"\")")`), paths('a;")'));
    assert.deepEqual(reads(String.raw`echo $(cat "a\"b")`), paths('a"b'));
  });

  test("an escaped backslash before the closing quote still closes it", () => {
    assert.deepEqual(reads(String.raw`echo $(cat "a\\")`), paths("a\\"));
    assert.deepEqual(reads(String.raw`echo $(cat "a\\") && cat b`), paths("a\\", "b"));
  });

  test("single quotes have no escapes", () => {
    assert.deepEqual(reads(String.raw`echo $(cat '")' )`), paths('")'));
    assert.deepEqual(reads(String.raw`echo $(cat 'a\' b)`), paths("a\\", "b"));
  });

  test("a $( ) nested in double quotes keeps its own quotes", () => {
    assert.deepEqual(reads(String.raw`echo $(cat "$(cat ")")")`), paths(")"));
    assert.deepEqual(reads(String.raw`echo $(cat "a$(cat "\")")")`), paths('")'));
    assert.deepEqual(reads(String.raw`echo "$(cat "a)b")"`), paths("a)b"));
  });

  test("a backtick substitution inside $( ) keeps its parenthesis", () => {
    assert.deepEqual(reads('echo $(cat a `cat ")"` b)'), paths(")", "a", "b"));
    assert.deepEqual(reads('echo $(cat "`cat \\")\\"`")'), paths(")"));
  });
});

describe("escapes inside backticks", () => {
  test("an escaped backtick does not close the substitution", () => {
    assert.deepEqual(reads("echo `echo \\`cat f\\``"), paths("f"));
    assert.deepEqual(reads("echo `echo \\`cat 'a b'\\`; cat c`"), paths("a b", "c"));
  });

  test("backslash-escaped quotes inside backticks inside double quotes", () => {
    assert.deepEqual(reads('echo "`cat \\"x y\\"`"'), paths("x y"));
    const command = 'echo $(echo "`cat \\"\\\\\\")\\"`")';
    assert.deepEqual(reads(command), paths('")'));
  });
});

// `x` is unset and `cat` prints its arguments in the bash oracle. `${x:+…}` is not run by bash with
// `x` unset, but the guard cannot know that, so it reports the read.
describe("parameter expansions", () => {
  const hidden: readonly string[] = [
    'echo ${x:-"}"} ; cat secret',
    'echo ${x:-"a } b"} ; cat secret',
    "echo ${x:-$(cat secret)}",
    "echo ${x:-`cat secret`}",
    'echo "${x:-$(cat secret)}"',
    "echo ${x:-'}'} ; cat secret",
    'echo "${x:-"}"}" ; cat secret',
    "echo ${x:-${y:-$(cat secret)}}",
    "echo ${x:+$(cat secret)}",
    "echo ${x:+$(cat secret)} ${#x}",
    'echo ${x:-"$(cat "secret")"}',
    'echo ${x:-$(echo "}")} ; cat secret',
  ];
  test.each(hidden)("%s", (command) => {
    assert.deepEqual(reads(command), paths("secret"));
  });

  const exact: readonly string[] = [
    "echo ${x:-}} ; cat secret",
    "echo $((1+2)) ; cat secret",
    'echo ${x:-"a b"} ; cat secret',
    "echo \"${x:-'}'}\" ; cat secret",
    "echo ${x:-\\}} ; cat secret",
    "echo ${#x} ; cat secret",
    "echo ${x%%\\}*} ; cat secret",
    "echo $(echo ${x:-)} ; cat secret)",
    "echo ${x:-(} ; cat secret",
    'echo "${x:-\\"}" ; cat secret',
    "echo ${x/\\}/a} ; cat secret",
  ];
  test.each(exact)("%s", (command) => {
    assert.deepEqual(reads(command), paths("secret"));
  });

  test("an expansion that never closes still reports the substitution inside it", () => {
    assert.deepEqual(reads("echo ${x:-$(cat secret)"), paths("secret"));
  });

  test("the home directory expansion is unchanged", () => {
    assert.deepEqual(reads("cat ${HOME}/a"), [`${homedir()}/a`]);
  });
});

// Substitutions run inside arithmetic and inside the body of a heredoc whose delimiter is unquoted;
// in such a body quotes are literal and only `\\`, `$(`, `${` and backticks matter.
describe("arithmetic expansions and heredoc bodies", () => {
  const hidden: readonly string[] = [
    "echo $(( $(cat secret) + 1 ))",
    "echo $(( `cat secret` + 1 ))",
    "echo $((x[$(cat secret)]))",
    "x=1; echo $((x + $(cat secret)))",
    "echo $((cat secret) )",
    'echo $(( "$(cat secret)" ))',
    "echo $(( ${x:-$(cat secret)} ))",
    "echo ${x:-$((cat secret) )}",
    "cat <<EOF\n$(cat secret)\nEOF",
    "cat <<EOF\n`cat secret`\nEOF",
    "cat <<EOF\n${x:-$(cat secret)}\nEOF",
    "cat <<-EOF\n\t$(cat secret)\n\tEOF",
    "cat <<EOF\n'$(cat secret)'\nEOF",
    "cat <<EOF\n$((1+$(cat secret)))\nEOF",
    "cat <<EOF\n\\\\$(cat secret)\nEOF",
  ];
  test.each(hidden)("%j", (command) => {
    assert.deepEqual(reads(command), paths("secret"));
  });

  const seen: readonly string[] = [
    "echo $[ $(cat secret) ]",
    "echo <(cat secret)",
    "x=$(cat secret)",
    "(( $(cat secret) )); echo",
    "let $(cat secret)",
    "a[$(cat secret)]=1",
    "echo ${a[$(cat secret)]}",
    'cat <<EOF\n"\nEOF\ncat secret',
  ];
  test.each(seen)("%j", (command) => {
    assert.deepEqual(reads(command), paths("secret"));
  });

  const literal: readonly string[] = [
    "cat <<'EOF'\n$(cat secret)\nEOF",
    'cat <<"EOF"\n$(cat secret)\nEOF',
    "cat <<\\EOF\n$(cat secret)\nEOF",
    "cat <<EOF\n\\$(cat secret)\nEOF",
    "cat <<EOF\n\\`cat secret\\`\nEOF",
    "echo $((cat secret))",
    "echo $((1<2)) ; echo $((1+2))",
  ];
  test.each(literal)("%j reads nothing", (command) => {
    assert.deepEqual(reads(command), []);
  });

  test("a quote in a heredoc body does not start a string", () => {
    assert.deepEqual(reads('cat <<EOF\n"$(cat ")")"\nEOF'), paths(")"));
  });

  test("deeply nested arithmetic stays bounded and keeps the read", () => {
    const body = `${"$(( $(cat a) + ".repeat(5000)}1${" ))".repeat(5000)}`;
    assert.deepEqual(reads(`echo ${body}`), paths("a"));
  });
});

describe("ordinary commands keep their results", () => {
  const benign: readonly (readonly [string, readonly string[]])[] = [
    [String.raw`git commit -m "say \"hi\""`, []],
    ['echo "$(date)"', []],
    [String.raw`cat "a b" | grep "x\"y"`, ["a b"]],
    ['echo $(cat "a b.txt")', ["a b.txt"]],
    ['cat $(echo "it\'s")', []],
    [String.raw`echo "a\\" "b" ; cat c`, ["c"]],
    [String.raw`ls "a\$b" && cat d`, ["d"]],
    ['echo `cat "q r"`', ["q r"]],
    ['cat "a$(echo "b")c"', []],
    [String.raw`echo "$(printf "%s" "x\"y")" && cat z`, ["z"]],
  ];
  test.each(benign)("%s", (command, expected) => {
    assert.deepEqual(reads(command), paths(...expected));
  });
});

describe("pathological input", () => {
  test("many escaped quote pairs are scanned in one pass and the read is still found", () => {
    const body = String.raw`\")`.repeat(50_000 / 3);
    // The quoted word is longer than any path the guard resolves, so only `y` is reported.
    assert.deepEqual(reads(`echo $(cat "${body}" y)`), paths("y"));
  });

  test("deeply nested quoted substitutions do not overflow the stack", () => {
    const depth = 20_000;
    const command = `${'"$('.repeat(depth)}cat x${')"'.repeat(depth)}`;
    assert.doesNotThrow(() => reads(command));
  });

  test("deeply nested parameter expansions are scanned in one pass and keep the read", () => {
    const depth = 10_000;
    const command = `echo ${"${x:-".repeat(depth)}$(cat secret)${"}".repeat(depth)}`;
    assert.deepEqual(reads(command), paths("secret"));
  });
});
