import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

/** A shell word, and whether its text is known without running the shell. */
type Word = {
  readonly text: string;
  readonly literal: boolean;
  /** Set when every character was written as itself, so `\{` and `'{'` are not a bare `{`. */
  readonly bare?: boolean | undefined;
  /** Set only for an exact `$name`, `${name}`, or double-quoted equivalent. */
  readonly variable?: string | undefined;
};

/** One lexed part of a word. Only an unquoted, unescaped character that is itself is `plain`. */
type Piece = Word & { readonly plain: boolean };

/** One simple command. Its heredoc body is filled in once the lexer reaches the next line. */
type Command = {
  readonly words: readonly Word[];
  readonly inputs: readonly Word[];
  readonly substitutions: readonly string[];
  readonly heredoc: { body: string | undefined };
};

type Item =
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "open" }
  | { readonly kind: "close" }
  | { readonly kind: "boundary"; readonly boundary: Boundary };

/** How a list operator separates commands: `&&`/`||`, `;`/newline, `|`/`|&`, or `&`. */
type Boundary = "and" | "semi" | "pipe" | "background";

/** Where the current list and pipeline started, for undoing a `cd` that ran in a subshell. */
type Frame = {
  list: string | undefined;
  pipe: string | undefined;
  piped: boolean;
  /** A `coproc` group, whose closing brace also ends the subshell's own directory. */
  subshell?: true;
};

/** Option letters and long options that take a separate value. */
type Options = { readonly short: string; readonly long: readonly string[] };

type Arguments = {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly positionals: readonly Word[];
};

const MAX_DEPTH = 3;
/**
 * Backstop for input the analyser cannot resolve in reasonable time. A longer command is not
 * analysed at all, like any other input it cannot resolve: the best-effort check fails open.
 */
const MAX_COMMAND_LENGTH = 100_000;
/** Longest directory or file path tracked; a `cd` chain beyond it is treated as unresolvable. */
const MAX_PATH_LENGTH = 4096;
const WORD_END = new Set([" ", "\t", "\r", "\n", "|", "&", ";", "(", ")", "<", ">"]);
const OPERATORS = [
  "<<<",
  "&>>",
  "<<",
  "&&",
  "||",
  "|&",
  ";;",
  "&>",
  ">>",
  ">&",
  "<&",
  ">|",
  "<>",
  "|",
  "&",
  ";",
  "(",
  ")",
  "<",
  ">",
] as const;
const OUTPUT_REDIRECTS = new Set(["<<<", "&>>", "&>", ">>", ">&", "<&", ">|", ">"]);
const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
]);
/** What may follow `coproc NAME`: a compound command. */
const COMPOUND_START = new Set(["{", "while", "until", "if", "for", "case", "select"]);
const CONDITION_LOOPS = new Set(["while", "until"]);
/**
 * Brace expansion stops here, and the word is left unresolved like any other dynamic one. The
 * limits keep one word's expansion, a whole command's, and the nesting it is scanned at bounded.
 */
const MAX_BRACE_WORDS = 256;
const MAX_BRACE_WORDS_PER_COMMAND = 4096;
const MAX_BRACE_NESTING = 8;
const MAX_BRACE_PIECES = 1024;
/** Deepest `${name:-default}` nested in another's default that is still read as a path. */
const MAX_DEFAULT_NESTING = 8;
/** `${name:-word}`, `${name-word}`, `${name:=word}`, `${name=word}`, `${name:+word}`, `${name+word}`. */
const PARAMETER_DEFAULT =
  /^(?<name>[A-Za-z_]\w*(?:\[[^\]]*\])?|\d+|[@*?$!#-])(?<operator>:?[-=+])(?<word>.*)$/su;
const EXACT_VARIABLE = /^\$(?:(?<bare>[A-Za-z_]\w*)|\{(?<braced>[A-Za-z_]\w*)\})$/u;
const DEFAULTED_VARIABLE = /^\$\{(?<name>[A-Za-z_]\w*):?[-=]/u;
const SIGNED_NUMBER = /^-?\d{1,15}$/u;
const NUMBER_SEQUENCE = /^(?<from>-?\d+)\.\.(?<to>-?\d+)(?:\.\.(?<step>-?\d+))?$/u;
const LETTER_SEQUENCE = /^(?<from>[A-Za-z])\.\.(?<to>[A-Za-z])(?:\.\.(?<step>-?\d+))?$/u;
const ASSIGNMENT = /^[A-Za-z_]\w*=/u;
const NAME = /[A-Za-z_]\w*/uy;
const FILE_DESCRIPTOR = /\d+(?=[<>])/uy;
const NO_OPTIONS: Options = { short: "", long: [] };

/** Commands that print the content of every file they are given. */
const PRINTERS: ReadonlyMap<string, Options> = new Map(
  Object.entries({
    cat: NO_OPTIONS,
    tac: NO_OPTIONS,
    nl: NO_OPTIONS,
    head: { short: "nc", long: ["--lines", "--bytes"] },
    tail: { short: "nc", long: ["--lines", "--bytes"] },
    less: NO_OPTIONS,
    more: NO_OPTIONS,
    bat: { short: "lr", long: ["--language", "--line-range"] },
    batcat: { short: "lr", long: ["--language", "--line-range"] },
    strings: NO_OPTIONS,
    xxd: NO_OPTIONS,
    od: NO_OPTIONS,
    base64: NO_OPTIONS,
    cut: { short: "bcdf", long: [] },
    fold: { short: "w", long: [] },
    diff: { short: "UCxX", long: [] },
    hexdump: { short: "nse", long: [] },
    sort: { short: "kotST", long: ["--key", "--field-separator", "--output", "--buffer-size"] },
    uniq: { short: "fsw", long: [] },
    paste: { short: "d", long: ["--delimiters"] },
    rev: NO_OPTIONS,
    column: { short: "csoWNRTH", long: [] },
    fmt: { short: "wpgt", long: [] },
    expand: { short: "t", long: [] },
    unexpand: { short: "t", long: [] },
    pr: { short: "ehiwlnoNsSTm", long: [] },
    comm: NO_OPTIONS,
  }),
);
const SEARCH_OPTIONS: ReadonlyMap<string, Options> = new Map(
  Object.entries({
    grep: { short: "efmABC", long: ["--regexp", "--file", "--include", "--exclude"] },
    rg: {
      short: "efgtTmABCMj",
      long: ["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count"],
    },
  }),
);
/** Search flags that print only names, counts, or nothing. */
const SILENT_SEARCH = new Set([
  "-l",
  "-L",
  "-c",
  "-q",
  "--files",
  "--files-with-matches",
  "--files-without-match",
  "--count",
  "--count-matches",
  "--quiet",
  "--type-list",
]);
const SED_OPTIONS: Options = { short: "efl", long: ["--expression", "--file"] };
const AWK_OPTIONS: Options = { short: "Fvf", long: [] };

/** Commands that run the command after them, with options and the positionals they consume. */
const WRAPPERS: ReadonlyMap<string, { readonly options: Options; readonly skip: number }> = new Map(
  Object.entries({
    env: { options: { short: "uCS", long: [] }, skip: 0 },
    sudo: { options: { short: "ugCDhpT", long: [] }, skip: 0 },
    nohup: { options: NO_OPTIONS, skip: 0 },
    exec: { options: NO_OPTIONS, skip: 0 },
    command: { options: NO_OPTIONS, skip: 0 },
    nice: { options: { short: "n", long: [] }, skip: 0 },
    timeout: { options: { short: "sk", long: [] }, skip: 1 },
    stdbuf: { options: { short: "ioe", long: [] }, skip: 0 },
    xargs: { options: { short: "IndPLsEa", long: [] }, skip: 0 },
  }),
);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash"]);
/**
 * List the files a shell command prints the contents of, as far as its literal text shows.
 *
 * Best-effort detection of literal reader arguments, input redirects, shell scripts, and simple
 * `for` loops whose readers take an exact loop-variable argument. Substitutions are analyzed in
 * their command's directory. Dynamic paths, general shell control flow, and non-shell interpreter
 * scripts are unsupported; unresolvable reads are skipped rather than guessed.
 *
 * @param command - Shell command text, as the bash tool receives it.
 * @param cwd - Directory relative paths start from.
 * @returns Absolute paths whose content the command reads.
 */
export function pathsReadByCommand(command: string, cwd: string): readonly string[] {
  const reads = new Set<string>();
  if (command.length > MAX_COMMAND_LENGTH) {
    return [];
  }
  analyze(command, cwd, 0, reads);
  return [...reads];
}

function analyze(source: string, cwd: string | undefined, depth: number, reads: Set<string>): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  const lexer = new Lexer(source);
  lexer.lex();
  new Evaluator(cwd, depth, reads).run(lexer.items);
}

const BACKTICK_ESCAPE = /\\(?<char>[`$\\])/gu;
const QUOTED_BACKTICK_ESCAPE = /\\(?<char>[`$"\\])/gu;

/** An open construct while scanning a substitution: a `(` or `${` group or a double-quoted string. */
type Open = "(" | "{" | '"';

type Scan = {
  readonly open: Open[];
  /** How many `(` groups are open. */
  parens: number;
  /** Where the outermost open `$( )` began, or -1. */
  span: number;
};

class Lexer {
  readonly items: Item[] = [];
  private substitutions: string[] = [];
  private index = 0;
  private words: Word[] = [];
  private inputs: Word[] = [];
  private heredoc: { body: string | undefined } = { body: undefined };
  private readonly pending: {
    readonly heredoc: { body: string | undefined };
    readonly delimiter: string;
    /** A quoted delimiter makes the body literal; otherwise its substitutions run. */
    readonly quoted: boolean;
    readonly substitutions: string[];
  }[] = [];

  /** How many more words brace expansion may produce in this source. */
  private braceBudget = MAX_BRACE_WORDS_PER_COMMAND;

  constructor(
    private readonly source: string,
    /** How many `${name:-default}` defaults enclose this source. */
    private readonly nesting = 0,
  ) {}

  lex(): void {
    while (this.index < this.source.length) {
      const char = this.source.charAt(this.index);
      if (char === " " || char === "\t" || char === "\r") {
        this.index += 1;
      } else if (char === "\\" && this.source.charAt(this.index + 1) === "\n") {
        this.index += 2;
      } else if (char === "#") {
        const end = this.source.indexOf("\n", this.index);
        this.index = end === -1 ? this.source.length : end;
      } else if (char === "\n") {
        this.newline();
      } else if ((char === "<" || char === ">") && this.source.charAt(this.index + 1) === "(") {
        this.index += 2;
        this.substitutions.push(this.scan("("));
        this.words.push({ text: "", literal: false });
      } else {
        this.operatorOrWord();
      }
    }
    this.flush();
  }

  private newline(): void {
    this.index += 1;
    this.flush();
    const last = this.items.at(-1);
    // A newline after `|`, `|&`, `&&` or `||` continues the command.
    const continues =
      last?.kind === "boundary" && (last.boundary === "pipe" || last.boundary === "and");
    if (!continues) {
      this.items.push({ kind: "boundary", boundary: "semi" });
    }
    this.readHeredocBodies();
  }

  private operatorOrWord(): void {
    FILE_DESCRIPTOR.lastIndex = this.index;
    if (FILE_DESCRIPTOR.test(this.source)) {
      this.index = FILE_DESCRIPTOR.lastIndex;
    }
    const operator = OPERATORS.find((candidate) => this.source.startsWith(candidate, this.index));
    if (operator === undefined) {
      this.words.push(...this.wordList());
      return;
    }
    this.index += operator.length;
    if (operator === "(" || operator === ")") {
      this.flush();
      this.items.push({ kind: operator === "(" ? "open" : "close" });
    } else if (operator === "<" || operator === "<>") {
      this.inputs.push(this.target());
    } else if (operator === "<<") {
      const dash = this.source.charAt(this.index) === "-";
      this.index += dash ? 1 : 0;
      const start = this.index;
      const delimiter = this.target().text;
      this.pending.push({
        heredoc: this.heredoc,
        delimiter,
        quoted: /['"\\]/u.test(this.source.slice(start, this.index)),
        substitutions: this.substitutions,
      });
    } else if (OUTPUT_REDIRECTS.has(operator)) {
      this.target();
    } else {
      this.flush();
      this.items.push({ kind: "boundary", boundary: boundaryOf(operator) });
    }
  }

  private target(): Word {
    while (this.source.charAt(this.index) === " " || this.source.charAt(this.index) === "\t") {
      this.index += 1;
    }
    return this.word();
  }

  private flush(): void {
    if (this.words.length > 0 || this.inputs.length > 0) {
      this.items.push({
        kind: "command",
        command: {
          words: this.words,
          inputs: this.inputs,
          substitutions: this.substitutions,
          heredoc: this.heredoc,
        },
      });
    }
    this.words = [];
    this.inputs = [];
    this.substitutions = [];
    this.heredoc = { body: undefined };
  }

  private readHeredocBodies(): void {
    for (const { heredoc, delimiter, quoted, substitutions } of this.pending.splice(0)) {
      const lines: string[] = [];
      while (this.index < this.source.length) {
        const end = this.source.indexOf("\n", this.index);
        const line = this.source.slice(this.index, end === -1 ? undefined : end);
        this.index = end === -1 ? this.source.length : end + 1;
        if (line.replace(/^\t+/u, "") === delimiter) {
          break;
        }
        lines.push(line);
      }
      heredoc.body = lines.join("\n");
      if (!quoted) {
        substitutions.push(...Lexer.expansionsIn(heredoc.body));
      }
    }
  }

  /** One word where the shell makes one; a brace expansion that makes several is unresolved. */
  private word(): Word {
    const [first, second] = this.wordList();
    return second === undefined && first !== undefined ? first : { text: "", literal: false };
  }

  /** The words one source word becomes: several for a brace expansion, one otherwise. */
  private wordList(): readonly Word[] {
    const start = this.index;
    const pieces: Piece[] = [];
    while (this.index < this.source.length && !WORD_END.has(this.source.charAt(this.index))) {
      const char = this.source.charAt(this.index);
      const part = this.wordPart(start);
      pieces.push({ ...part, plain: part.text === char && !"\\'\"$`".includes(char) });
    }
    const single = this.single(pieces, start);
    if (!pieces.some((piece) => piece.plain && piece.text === "{")) {
      return [single];
    }
    const expansion = expandBraces(pieces, 0);
    this.braceBudget -= expansion?.length ?? 0;
    if (expansion === undefined || this.braceBudget < 0) {
      return [{ text: single.text, literal: false }];
    }
    return expansion.map((expanded) => joinPieces(expanded));
  }

  private single(pieces: readonly Piece[], start: number): Word {
    const word = joinPieces(pieces);
    return { ...word, variable: this.variableOf(this.source.slice(start, this.index), word) };
  }

  /**
   * The variable a word is exactly: `$name` or `${name}` when unknown, and `${name:-word}`,
   * `${name-word}`, `${name:=word}` or `${name=word}` whose word is only a fallback.
   */
  private variableOf(raw: string, word: Word): string | undefined {
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    const exact = EXACT_VARIABLE.exec(unquoted)?.groups;
    if (exact !== undefined) {
      return word.literal ? undefined : (exact.bare ?? exact.braced);
    }
    const name = DEFAULTED_VARIABLE.exec(unquoted)?.groups?.name;
    if (name === undefined) {
      return undefined;
    }
    const probe = new Lexer(unquoted.slice(2));
    probe.scan("{");
    return probe.index === unquoted.length - 2 ? name : undefined;
  }

  /** Consume one piece of a word: an escape, a quoted run, an expansion, or one character. */
  private wordPart(start: number): Word {
    const char = this.source.charAt(this.index);
    switch (char) {
      case "\\": {
        const text = this.source.charAt(this.index + 1);
        this.index += 2;
        return { text: text === "\n" ? "" : text, literal: true };
      }
      case "'": {
        return this.singleQuoted();
      }
      case '"': {
        return this.doubleQuoted();
      }
      case "$": {
        return this.dollar();
      }
      case "`": {
        this.backtick(false);
        return { text: "", literal: false };
      }
      default: {
        break;
      }
    }
    this.index += 1;
    if (char === "~" && this.index - 1 === start) {
      // `~user`, `~+` and `~-` name directories only the shell knows.
      return this.tildeEndsAt(this.index)
        ? { text: homedir(), literal: true }
        : { text: char, literal: false };
    }
    return { text: char, literal: !"*?[".includes(char) };
  }

  private singleQuoted(): Word {
    const end = this.source.indexOf("'", this.index + 1);
    const text = this.source.slice(this.index + 1, end === -1 ? undefined : end);
    this.index = end === -1 ? this.source.length : end + 1;
    return { text, literal: end !== -1 };
  }

  /** Whether a `~` ends at this index, so it names the home directory. */
  private tildeEndsAt(index: number): boolean {
    const next = this.source.charAt(index);
    return next === "/" || next === "" || WORD_END.has(next);
  }

  private doubleQuoted(): Word {
    let text = "";
    let literal = true;
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source.charAt(this.index);
      if (char === '"') {
        this.index += 1;
        return { text, literal };
      }
      if (char === "\\" && this.source.charAt(this.index + 1) === "\n") {
        this.index += 2;
      } else if (char === "\\" && '$`"\\'.includes(this.source.charAt(this.index + 1))) {
        text += this.source.charAt(this.index + 1);
        this.index += 2;
      } else if (char === "$") {
        const expansion = this.dollar(true);
        text += expansion.text;
        literal &&= expansion.literal;
      } else if (char === "`") {
        this.backtick(true);
        literal = false;
      } else {
        text += char;
        this.index += 1;
      }
    }
    return { text, literal: false };
  }

  /**
   * `$( … )` runs `inner`; `$(( … ))` is arithmetic, whose own substitutions run. When the
   * leading `(` does not close at the very end (`$((cat a) )`) the whole is a subshell.
   */
  private substitution(inner: string): void {
    if (!inner.startsWith("(")) {
      this.substitutions.push(inner);
      return;
    }
    const probe = new Lexer(inner.slice(1));
    probe.scan("(");
    if (probe.index < inner.length - 1) {
      this.substitutions.push(inner);
    } else {
      this.substitutions.push(...Lexer.expansionsIn(inner));
    }
  }

  /**
   * The command substitutions that run in text where quotes are literal and only backslash,
   * `$(`, `${` and backticks matter: an arithmetic expansion or an unquoted heredoc body.
   */
  static expansionsIn(text: string): readonly string[] {
    const lexer = new Lexer(text);
    while (lexer.index < text.length) {
      lexer.expansionStep();
    }
    return lexer.substitutions;
  }

  private expansionStep(): void {
    const char = this.source.charAt(this.index);
    const next = this.source.charAt(this.index + 1);
    if (char === "\\") {
      this.index += 2;
    } else if (char === "`") {
      this.backtick(false);
    } else if (char === "$" && (next === "(" || next === "{")) {
      this.index += 2;
      if (next === "(") {
        this.substitutions.push(this.scan("("));
      } else {
        this.scan("{");
      }
    } else {
      this.index += 1;
    }
  }

  /**
   * Only `$HOME` has a value known without running the shell. A literal default or alternative
   * word of any other `${name:-word}` is a possible path, since `name` may well be unset.
   */
  private dollar(quoted = false): Word {
    const next = this.source.charAt(this.index + 1);
    if (next === "(") {
      this.index += 2;
      this.substitution(this.scan("("));
      return { text: "", literal: false };
    }
    if (next === "{") {
      this.index += 2;
      return this.parameter(this.scan("{"), quoted);
    }
    NAME.lastIndex = this.index + 1;
    const name = NAME.exec(this.source)?.[0];
    if (name !== undefined) {
      this.index += 1 + name.length;
      return home(name);
    }
    if (next === "" || WORD_END.has(next) || next === '"') {
      this.index += 1;
      return { text: "$", literal: true };
    }
    this.index += 2;
    return { text: "", literal: false };
  }

  /** The inside of a `${ }`: a default or alternative word, or a plain name. */
  private parameter(inner: string, quoted: boolean): Word {
    const groups = PARAMETER_DEFAULT.exec(inner)?.groups;
    if (groups?.word === undefined) {
      return home(inner);
    }
    // `$HOME` is set, so `${HOME:-word}` is its value; `${HOME:+word}` is the word.
    if (groups.name === "HOME" && groups.operator?.endsWith("+") !== true) {
      return home("HOME");
    }
    return this.defaultWord(groups.word, quoted);
  }

  /**
   * Read the word of a `${name:-word}` as shell text. Its substitutions already ran when the
   * enclosing `${ }` was scanned. Unquoted, an unquoted space would split it into several words,
   * which one word cannot stand for.
   */
  private defaultWord(text: string, quoted: boolean): Word {
    if (this.nesting >= MAX_DEFAULT_NESTING) {
      return { text: "", literal: false };
    }
    const lexer = new Lexer(text, this.nesting + 1);
    const pieces: Word[] = [];
    let splits = false;
    while (lexer.index < text.length) {
      const char = lexer.source.charAt(lexer.index);
      const part = quoted ? lexer.quotedPart() : lexer.wordPart(0);
      splits ||= !quoted && part.text === char && /\s/u.test(char);
      pieces.push(part);
    }
    const word = joinPieces(pieces.map((piece) => ({ ...piece, plain: false })));
    return splits ? { text: word.text, literal: false } : word;
  }

  /**
   * One piece of a default word inside double quotes: a single quote is an ordinary character
   * there, and a backslash escapes only `$`, `` ` ``, `"`, `\` and a newline.
   */
  private quotedPart(): Word {
    const char = this.source.charAt(this.index);
    const next = this.source.charAt(this.index + 1);
    if (char === "'" || (char === "\\" && !'$`"\\\n'.includes(next))) {
      this.index += 1;
      return { text: char, literal: true };
    }
    return this.wordPart(0);
  }

  /** Backslash removes itself before `` ` ``, `$` and `\`, and before `"` when the backticks sit in double quotes. */
  private backtick(inDoubleQuotes: boolean): void {
    const end = this.backtickEnd(this.index);
    const inner = this.source.slice(this.index + 1, end === -1 ? undefined : end);
    this.substitutions.push(
      inner.replaceAll(inDoubleQuotes ? QUOTED_BACKTICK_ESCAPE : BACKTICK_ESCAPE, "$<char>"),
    );
    this.index = end === -1 ? this.source.length : end + 1;
  }

  /** The index of the backtick closing the one at `open`; `\`` does not close it. Or -1. */
  private backtickEnd(open: number): number {
    for (let index = open + 1; index < this.source.length; index += 1) {
      const char = this.source.charAt(index);
      if (char === "\\") {
        index += 1;
      } else if (char === "`") {
        return index;
      }
    }
    return -1;
  }

  /**
   * Read up to the `)` (or `}`) that closes an already consumed `$(` (or `${`), skipping quoted
   * text. A stack of open constructs keeps this one linear pass: inside double quotes `\"` does not
   * close the string, and `$(` and `${` open nested constructs whose own quotes are independent.
   * Inside `${ }` the outermost `$( )` and backtick substitutions are collected for analysis.
   */
  private scan(base: "(" | "{"): string {
    const start = this.index;
    const scan: Scan = { open: [base], parens: base === "(" ? 1 : 0, span: -1 };
    while (this.index < this.source.length) {
      const char = this.source.charAt(this.index);
      const top = scan.open.at(-1);
      if (char === "\\") {
        this.index += 2;
      } else if (char === "`") {
        this.scanBacktick(scan, top === '"');
      } else if (char === "'" && top !== '"') {
        const end = this.source.indexOf(char, this.index + 1);
        this.index = end === -1 ? this.source.length : end + 1;
      } else if (this.scanStep(scan, char, top)) {
        return this.source.slice(start, this.index - 1);
      }
    }
    this.collect(scan, this.source.length);
    return this.source.slice(start);
  }

  /** Step over one character; true once the construct that `scan` started with is closed. */
  private scanStep(scan: Scan, char: string, top: Open | undefined): boolean {
    const next = this.source.charAt(this.index + 1);
    if (char === "$" && (next === "(" || next === "{")) {
      scan.open.push(next);
      this.index += 2;
      if (next === "(") {
        this.enterParen(scan);
      }
      return false;
    }
    this.index += 1;
    if (char === '"') {
      this.toggleQuote(scan, top);
    } else if (char === "(" && top === "(") {
      scan.open.push("(");
      this.enterParen(scan);
    } else if (char === ")" && top === "(") {
      scan.open.pop();
      scan.parens -= 1;
      this.collect(scan, this.index - 1);
    } else if (char === "}" && top === "{") {
      scan.open.pop();
    }
    return scan.open.length === 0;
  }

  private toggleQuote(scan: Scan, top: Open | undefined): void {
    if (top === '"') {
      scan.open.pop();
    } else {
      scan.open.push('"');
    }
  }

  private enterParen(scan: Scan): void {
    scan.parens += 1;
    if (scan.parens === 1) {
      scan.span = this.index;
    }
  }

  /** Record the outermost `$( )` inside a `${ }` once it closes (or the input ends). */
  private collect(scan: Scan, end: number): void {
    if (scan.span !== -1 && (scan.parens === 0 || end === this.source.length)) {
      this.substitution(this.source.slice(scan.span, end));
      scan.span = -1;
    }
  }

  /** Backticks nested in a `$( )` are analysed with it; any other is a substitution of its own. */
  private scanBacktick(scan: Scan, inDoubleQuotes: boolean): void {
    if (scan.parens > 0) {
      const end = this.backtickEnd(this.index);
      this.index = end === -1 ? this.source.length : end + 1;
    } else {
      this.backtick(inDoubleQuotes);
    }
  }
}

function boundaryOf(operator: string): Boundary {
  if (operator === "|" || operator === "|&") {
    return "pipe";
  }
  if (operator === "&") {
    return "background";
  }
  return operator === "&&" || operator === "||" ? "and" : "semi";
}

function home(name: string): Word {
  return name === "HOME" ? { text: homedir(), literal: true } : { text: "", literal: false };
}

function joinPieces(pieces: readonly Piece[]): Word {
  return {
    text: pieces.map((piece) => piece.text).join(""),
    literal: pieces.every((piece) => piece.literal),
    bare: pieces.every((piece) => piece.plain),
  };
}

type Expansion = readonly (readonly Piece[])[];

/**
 * The words bash's brace expansion makes of a word, or undefined when there would be too many.
 * Only plain `{`, `,`, `}` and sequence characters count, so quoted, escaped and `${ }` braces
 * stay inert. A `{` that does not start an expansion stays literal, as in `{a}` or `{a{b,c}}`.
 *
 * @param depth - How many braces enclose these pieces.
 */
function expandBraces(pieces: readonly Piece[], depth: number): Expansion | undefined {
  if (pieces.length > MAX_BRACE_PIECES || depth > MAX_BRACE_NESTING) {
    return undefined;
  }
  const closes = matchingBraces(pieces);
  for (let open = 0; open < pieces.length; open += 1) {
    const close = closes[open] ?? -1;
    if (close === -1) {
      continue;
    }
    const inner = pieces.slice(open + 1, close);
    const options = braceAlternatives(inner) ?? braceSequence(inner);
    if (options === null) {
      return undefined;
    }
    if (options !== undefined) {
      return combineBraces(pieces.slice(0, open), options, pieces.slice(close + 1), depth);
    }
  }
  return [pieces];
}

/** For each plain `{`, the index of its plain `}`, or -1. */
function matchingBraces(pieces: readonly Piece[]): readonly number[] {
  const closes = pieces.map(() => -1);
  const opens: number[] = [];
  for (const [index, piece] of pieces.entries()) {
    if (piece.plain && piece.text === "{") {
      opens.push(index);
    } else if (piece.plain && piece.text === "}") {
      closes[opens.pop() ?? index] = index;
    }
  }
  return closes;
}

/** The comma-separated alternatives of a brace body, or undefined when it has no top-level comma. */
function braceAlternatives(inner: readonly Piece[]): readonly (readonly Piece[])[] | undefined {
  const options: Piece[][] = [[]];
  let depth = 0;
  let commas = 0;
  for (const piece of inner) {
    if (piece.plain && piece.text === "," && depth === 0) {
      commas += 1;
      options.push([]);
      continue;
    }
    depth += piece.plain && piece.text === "{" ? 1 : 0;
    depth -= piece.plain && piece.text === "}" ? 1 : 0;
    options.at(-1)?.push(piece);
  }
  return commas === 0 ? undefined : options;
}

/**
 * The words of `{1..3}`, `{3..1..2}`, `{01..10}` or `{a..e}`. Undefined when the body is not a
 * sequence, null when it has more words than the cap allows.
 */
function braceSequence(inner: readonly Piece[]): Expansion | null | undefined {
  if (!inner.every((piece) => piece.plain && piece.text.length === 1)) {
    return undefined;
  }
  const body = inner.map((piece) => piece.text).join("");
  const numbers = NUMBER_SEQUENCE.exec(body)?.groups;
  const letters = LETTER_SEQUENCE.exec(body)?.groups;
  if (numbers !== undefined) {
    return numberSequence(numbers.from ?? "", numbers.to ?? "", numbers.step ?? "1");
  }
  if (letters === undefined) {
    return undefined;
  }
  const values = sequenceValues(
    (letters.from ?? "").codePointAt(0) ?? 0,
    (letters.to ?? "").codePointAt(0) ?? 0,
    letters.step ?? "1",
  );
  return values?.map((value) => [sequencePiece(String.fromCodePoint(value))]) ?? null;
}

/** `{from..to..step}` of integers; bash pads to the longest end when either has a leading zero. */
function numberSequence(from: string, to: string, step: string): Expansion | null {
  if (![from, to, step].every((part) => SIGNED_NUMBER.test(part))) {
    return null;
  }
  const values = sequenceValues(Number(from), Number(to), step);
  const width = /^-?0\d/u.test(from) || /^-?0\d/u.test(to) ? Math.max(from.length, to.length) : 0;
  return values?.map((value) => [sequencePiece(paddedNumber(value, width))]) ?? null;
}

function paddedNumber(value: number, width: number): string {
  const digits = String(Math.abs(value));
  return value < 0 ? `-${digits.padStart(width - 1, "0")}` : digits.padStart(width, "0");
}

function sequencePiece(text: string): Piece {
  return { text, literal: true, plain: false };
}

/** The values from `from` to `to` in steps of `|step|` (1 for 0), or undefined past the cap. */
function sequenceValues(from: number, to: number, step: string): readonly number[] | undefined {
  const size = Math.abs(Number(step)) || 1;
  const count = Math.floor(Math.abs(to - from) / size) + 1;
  if (count > MAX_BRACE_WORDS) {
    return undefined;
  }
  const direction = to < from ? -size : size;
  return Array.from({ length: count }, (_, index) => from + index * direction);
}

/** Every alternative of the first brace, in front of every expansion of what follows it. */
function combineBraces(
  before: readonly Piece[],
  options: Expansion,
  after: readonly Piece[],
  depth: number,
): Expansion | undefined {
  const middle: (readonly Piece[])[] = [];
  for (const option of options) {
    const expanded = expandBraces(option, depth + 1);
    if (expanded === undefined || middle.length + expanded.length > MAX_BRACE_WORDS) {
      return undefined;
    }
    middle.push(...expanded);
  }
  const tail = expandBraces(after, depth);
  if (tail === undefined || middle.length * tail.length > MAX_BRACE_WORDS) {
    return undefined;
  }
  return middle.flatMap((head) => tail.map((rest) => [...before, ...head, ...rest]));
}

class Evaluator {
  private readonly directories: (string | undefined)[];
  private readonly frames: Frame[];
  /** Nested loop bindings; other loop forms have no resolvable binding. */
  private readonly loops: { readonly variable?: string | undefined; list: readonly Word[] }[] = [];

  constructor(
    cwd: string | undefined,
    private readonly depth: number,
    private readonly reads: Set<string>,
  ) {
    this.directories = [cwd];
    this.frames = [{ list: cwd, pipe: cwd, piped: false }];
  }

  run(items: readonly Item[]): void {
    for (const item of items) {
      if (item.kind === "open") {
        this.directories.push(this.cwd);
        this.frames.push(this.frame());
      } else if (item.kind === "close") {
        if (this.directories.length > 1) {
          this.directories.pop();
        }
        this.popFrame();
      } else if (item.kind === "boundary") {
        this.boundary(item.boundary);
      } else {
        this.evaluate(item.command);
      }
    }
  }

  private get cwd(): string | undefined {
    return this.directories.at(-1);
  }

  private frame(): Frame {
    return { list: this.cwd, pipe: this.cwd, piped: false };
  }

  private popFrame(): void {
    if (this.frames.length > 1 && this.frames.pop()?.subshell && this.directories.length > 1) {
      this.directories.pop();
    }
  }

  /**
   * Every pipeline element, and a list followed by `&`, runs in a subshell, so a `cd` in it does
   * not reach the next command. `cd x && cat f` and `cd x; cat f` stay in one shell.
   */
  private boundary(boundary: Boundary): void {
    const frame = this.frames.at(-1);
    if (frame === undefined) {
      return;
    }
    if (boundary === "pipe") {
      frame.piped = true;
      this.directories[this.directories.length - 1] = frame.pipe;
      return;
    }
    if (boundary === "background") {
      this.directories[this.directories.length - 1] = frame.list;
      frame.pipe = frame.list;
      frame.piped = false;
      return;
    }
    if (frame.piped) {
      this.directories[this.directories.length - 1] = frame.pipe;
    }
    frame.pipe = this.cwd;
    frame.piped = false;
    if (boundary === "semi") {
      frame.list = this.cwd;
    }
  }

  private evaluate(command: Command): void {
    for (const inner of command.substitutions) {
      analyze(inner, this.cwd, this.depth + 1, this.reads);
    }
    const words = this.withoutKeywords(command.words);
    if (words[0]?.literal === true && words[0].text === "coproc") {
      this.coproc(words, command);
    } else {
      this.evaluateWords(words, command);
    }
  }

  /**
   * `coproc [NAME] command` runs the command in a subshell, so a `cd` in it does not reach the
   * next command. `NAME` is only a name before a compound command: `coproc NAME cat x` runs a
   * command called `NAME`.
   */
  private coproc(words: readonly Word[], command: Command): void {
    const [, name, third] = words;
    const named =
      name?.literal === true &&
      /^[A-Za-z_]\w*$/u.test(name.text) &&
      third?.bare === true &&
      COMPOUND_START.has(third.text);
    const rest = words.slice(named ? 2 : 1);
    this.directories.push(this.cwd);
    if (rest[0]?.bare === true && rest[0].text === "{") {
      // The group's own `}` ends the subshell.
      this.frames.push({ ...this.frame(), subshell: true });
      this.evaluateWords(this.withoutKeywords(rest.slice(1)), command);
      return;
    }
    this.evaluateWords(this.withoutKeywords(rest), command);
    this.directories.pop();
  }

  private evaluateWords(words: readonly Word[], command: Command): void {
    if (this.loopBoundary(words)) {
      return;
    }
    const assignments = leadingAssignments(words);
    // Reassignment makes a binding unknown. Also skip temporary inline assignments rather than
    // model when their values take effect or persist (argument expansion may precede assignment).
    for (const assignment of words.slice(0, assignments)) {
      const name = assignment.text.slice(0, assignment.text.indexOf("="));
      for (const loop of this.loops) {
        if (loop.variable === name) {
          loop.list = [];
        }
      }
    }
    const run = unwrap(words.slice(assignments));
    if (run[0]?.literal !== true) {
      return;
    }
    const name = basename(run[0].text);
    const args = run.slice(1);
    if (this.builtin(name, args, command)) {
      return;
    }
    const files = fileArguments(name, args);
    if (files !== undefined) {
      this.add([...files, ...command.inputs]);
    }
  }

  /** Drop leading keywords such as `if` and `do`, opening a loop for `while` and `until`. */
  private withoutKeywords(words: readonly Word[]): readonly Word[] {
    const start = words.findIndex((word) => !(word.literal && KEYWORDS.has(word.text)));
    const keywords = start === -1 ? words : words.slice(0, start);
    for (const keyword of keywords) {
      if (CONDITION_LOOPS.has(keyword.text)) {
        this.loops.push({ list: [] });
      } else if (keyword.text === "{") {
        this.frames.push(this.frame());
      } else if (keyword.text === "}") {
        this.popFrame();
      }
    }
    return start === -1 ? [] : words.slice(start);
  }

  /** Open a loop at `for` and close one at `done`; returns whether the command was either. */
  private loopBoundary(words: readonly Word[]): boolean {
    const [first, binding, third] = words;
    if (first?.literal !== true) {
      return false;
    }
    if (first.text === "for") {
      const list = third?.literal === true && third.text === "in" ? words.slice(3) : [];
      const variable =
        binding?.literal === true && /^[A-Za-z_]\w*$/u.test(binding.text)
          ? binding.text
          : undefined;
      this.loops.push({ variable, list });
      return true;
    }
    if (first.text !== "done") {
      return false;
    }
    this.loops.pop();
    return true;
  }

  /** Handle a command that runs or reads rather than prints; true when `name` is one. */
  private builtin(name: string, args: readonly Word[], command: Command): boolean {
    if (name === "cd" || name === "pushd") {
      this.changeDirectory(args);
    } else if (SHELLS.has(name)) {
      const script = shellScript(args, command.heredoc.body);
      if (script !== undefined) {
        analyze(script, this.cwd, this.depth + 1, this.reads);
      }
    } else if (name === "trap") {
      this.trapAction(args);
    } else if (name === "source" || name === ".") {
      this.add(parseArguments(args, NO_OPTIONS, true).positionals.slice(0, 1));
    } else {
      return false;
    }
    return true;
  }

  /**
   * `trap ACTION SIGNAL…` runs ACTION as a command later. A lone operand is a signal, `-` resets
   * and an empty ACTION ignores, and `-p` or `-l` only list.
   */
  private trapAction(args: readonly Word[]): void {
    const { flags, positionals } = parseArguments(args, NO_OPTIONS);
    const [action, signal] = positionals;
    if (
      action === undefined ||
      signal === undefined ||
      ["-l", "-p", "-P"].some((f) => flags.has(f))
    ) {
      return;
    }
    if (action.text !== "-") {
      analyze(action.text, this.cwd, this.depth + 1, this.reads);
    }
  }

  private changeDirectory(args: readonly Word[]): void {
    let index = 0;
    while (args[index]?.literal === true) {
      const option = args[index]?.text ?? "";
      if (option === "--") {
        index += 1;
        break;
      }
      if (!/^-[LP]+$/u.test(option)) {
        break;
      }
      index += 1;
    }
    const targets = args.slice(index);
    const [target] = targets;
    let next: string | undefined;
    if (targets.length === 0) {
      next = homedir();
    } else if (
      targets.length === 1 &&
      target?.literal === true &&
      target.text !== "" &&
      target.text !== "-" &&
      ((index > 0 && args[index - 1]?.text === "--") || !target.text.startsWith("-"))
    ) {
      // A relative cd in a loop can start from a different directory on each iteration.
      next =
        this.loops.length === 0 || isAbsolute(target.text) ? this.resolve(target.text) : undefined;
    }
    // Unknown options, dynamic targets, and extra operands invalidate relative resolution.
    this.directories[this.directories.length - 1] = next;
  }

  private add(words: readonly Word[]): void {
    for (const word of words) {
      const binding =
        word.variable === undefined
          ? undefined
          : this.loops.findLast((loop) => loop.variable === word.variable);
      for (const file of binding?.list ?? [word]) {
        if (file.literal && file.text !== "" && !file.text.startsWith("-")) {
          const path = this.resolve(file.text);
          if (path !== undefined) {
            this.reads.add(path);
          }
        }
      }
    }
  }

  private resolve(path: string): string | undefined {
    if (!isAbsolute(path) && this.cwd === undefined) {
      return undefined;
    }
    const resolved = isAbsolute(path) ? resolve(path) : resolve(this.cwd ?? "", path);
    // Each step of a long `cd` chain copies the whole path, so cap its growth.
    return resolved.length > MAX_PATH_LENGTH ? undefined : resolved;
  }
}

function leadingAssignments(words: readonly Word[]): number {
  const index = words.findIndex((word) => !ASSIGNMENT.test(word.text));
  return index === -1 ? words.length : index;
}

/** Strip commands such as `env`, `sudo`, `xargs`, and `timeout 5` that run the command after them. */
function unwrap(words: readonly Word[]): readonly Word[] {
  let remaining = words;
  for (;;) {
    const [first] = remaining;
    const wrapper = first?.literal === true ? WRAPPERS.get(basename(first.text)) : undefined;
    if (wrapper === undefined) {
      return remaining;
    }
    const rest = remaining.slice(1);
    const parsed = parseArguments(rest, wrapper.options, true);
    if (
      basename(first?.text ?? "") === "command" &&
      (parsed.flags.has("-v") || parsed.flags.has("-V"))
    ) {
      return []; // `command -v` and `-V` only describe the command.
    }
    const positional = parsed.positionals;
    const after = positional.slice(wrapper.skip);
    remaining = after.slice(leadingAssignments(after));
  }
}

/**
 * Split arguments into flags, option values, and positionals.
 *
 * @param stopAtPositional - Treat everything from the first positional on as positionals, as a
 *   wrapper does with the command it runs.
 */
function parseArguments(
  args: readonly Word[],
  options: Options,
  stopAtPositional = false,
): Arguments {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: Word[] = [];
  let ended = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    const next = args[index + 1];
    if (word === undefined) {
      break;
    }
    if (ended || isPositional(word)) {
      positionals.push(word);
      ended ||= stopAtPositional;
    } else if (word.text === "--") {
      ended = true;
    } else {
      const parseOption = word.text.startsWith("--") ? longOption : shortCluster;
      index += parseOption(word.text, next, options, flags, values);
    }
  }
  return { flags, values, positionals };
}

function isPositional(word: Word): boolean {
  return !word.literal || !word.text.startsWith("-") || word.text === "-";
}

/** Record an option such as `--file=x` or `--file x`; returns 1 when it consumed the next argument. */
function longOption(
  option: string,
  next: Word | undefined,
  options: Options,
  flags: Set<string>,
  values: Map<string, string>,
): number {
  const separator = option.indexOf("=");
  const name = separator === -1 ? option : option.slice(0, separator);
  flags.add(name);
  if (separator !== -1) {
    values.set(name, option.slice(separator + 1));
    return 0;
  }
  if (!options.long.includes(name)) {
    return 0;
  }
  values.set(name, next?.text ?? "");
  return 1;
}

/** Record a cluster such as `-rn` or `-A3`; returns 1 when it consumed the next argument. */
function shortCluster(
  cluster: string,
  next: Word | undefined,
  options: Options,
  flags: Set<string>,
  values: Map<string, string>,
): number {
  for (let index = 1; index < cluster.length; index += 1) {
    const flag = `-${cluster.charAt(index)}`;
    flags.add(flag);
    if (options.short.includes(cluster.charAt(index))) {
      const attached = cluster.slice(index + 1);
      values.set(flag, attached === "" ? (next?.text ?? "") : attached);
      return attached === "" ? 1 : 0;
    }
  }
  return 0;
}

/** File arguments of a content reader, or undefined when the command prints no file content. */
function fileArguments(name: string, args: readonly Word[]): readonly Word[] | undefined {
  const printer = PRINTERS.get(name);
  if (printer !== undefined) {
    return parseArguments(args, printer).positionals;
  }
  const search = SEARCH_OPTIONS.get(name === "rg" ? "rg" : name.replace(/^[ef]grep$/u, "grep"));
  if (search !== undefined) {
    const parsed = parseArguments(args, search);
    return [...parsed.flags].some((flag) => SILENT_SEARCH.has(flag))
      ? undefined
      : withoutProgram(parsed, ["-e", "-f", "--regexp", "--file"]);
  }
  if (name === "dd") {
    return ddInputs(args);
  }
  if (name === "sed") {
    const parsed = parseArguments(args, SED_OPTIONS);
    return [...parsed.flags].some((flag) => flag === "-i" || flag === "--in-place")
      ? undefined
      : withoutProgram(parsed, ["-e", "-f", "--expression", "--file"]);
  }
  if (name === "awk" || name === "gawk" || name === "mawk") {
    const parsed = parseArguments(args, AWK_OPTIONS);
    if (parsed.flags.has("-i")) {
      return undefined;
    }
    return withoutProgram(parsed, ["-f"]).filter((word) => !ASSIGNMENT.test(word.text));
  }
  return undefined;
}

/** `dd if=FILE` names its input file; every other `dd` operand is an option. */
function ddInputs(args: readonly Word[]): readonly Word[] {
  return args
    .filter((word) => word.literal && word.text.startsWith("if="))
    .map((word) => ({ text: word.text.slice(3), literal: true }));
}

/** Drop the script or pattern positional unless an option supplied it. */
function withoutProgram(parsed: Arguments, programOptions: readonly string[]): readonly Word[] {
  return programOptions.some((option) => parsed.values.has(option))
    ? parsed.positionals
    : parsed.positionals.slice(1);
}

function shellScript(args: readonly Word[], heredoc: string | undefined): string | undefined {
  const parsed = parseArguments(args, { short: "o", long: [] });
  if (parsed.flags.has("-c")) {
    const [script] = parsed.positionals;
    return script?.literal === true ? script.text : undefined;
  }
  return parsed.positionals.length === 0 ? heredoc : undefined;
}
