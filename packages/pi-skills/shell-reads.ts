import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

type Word = {
  readonly text: string;
  readonly literal: boolean;
  readonly bare?: boolean | undefined;
  readonly variable?: string | undefined;
};

type Piece = Word & { readonly plain: boolean };

type Command = {
  readonly words: ReadonlyArray<Word>;
  readonly inputs: ReadonlyArray<Word>;
  readonly substitutions: ReadonlyArray<string>;
  readonly heredoc: HereDocument;
};

type Item =
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "open" }
  | { readonly kind: "close" }
  | { readonly kind: "boundary"; readonly boundary: Boundary };

type Boundary = "and" | "semi" | "pipe" | "background";

type Frame = {
  list: string | undefined;
  pipe: string | undefined;
  piped: boolean;
  subshell?: true;
};

type Options = { readonly short: string; readonly long: ReadonlyArray<string> };

type Arguments = {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly positionals: ReadonlyArray<Word>;
};

const MAX_DEPTH = 3;
const FAIL_OPEN_ABOVE_COMMAND_LENGTH = 100_000;
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

const COMPOUND_START = new Set(["{", "while", "until", "if", "for", "case", "select"]);
const CONDITION_LOOPS = new Set(["while", "until"]);
const MAX_BRACE_WORDS = 256;
const MAX_BRACE_WORDS_PER_COMMAND = 4096;
const MAX_BRACE_NESTING = 8;
const MAX_BRACE_PIECES = 1024;
const MAX_DEFAULT_NESTING = 8;

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

export function pathsReadByCommand(command: string, cwd: string): ReadonlyArray<string> {
  const reads = new Set<string>();

  if (command.length > FAIL_OPEN_ABOVE_COMMAND_LENGTH) {
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

type Open = "(" | "{" | '"';

type Scan = {
  readonly open: Array<Open>;
  parens: number;
  span: number;
};

type HereDocument = { body: string | undefined };

class Lexer {
  readonly items: Array<Item> = [];
  private substitutions: Array<string> = [];
  private index = 0;
  private words: Array<Word> = [];
  private inputs: Array<Word> = [];
  private heredoc: HereDocument = { body: undefined };
  private readonly pending: Array<{
    readonly heredoc: HereDocument;
    readonly delimiter: string;
    readonly quoted: boolean;
    readonly substitutions: Array<string>;
  }> = [];

  private braceBudget = MAX_BRACE_WORDS_PER_COMMAND;

  constructor(
    private readonly source: string,
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
      const lines: Array<string> = [];

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

  private word(): Word {
    const [first, second] = this.wordList();

    return second === undefined && first !== undefined ? first : { text: "", literal: false };
  }

  private wordList(): ReadonlyArray<Word> {
    const start = this.index;
    const pieces: Array<Piece> = [];

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

  private single(pieces: ReadonlyArray<Piece>, start: number): Word {
    const word = joinPieces(pieces);

    return { ...word, variable: this.variableOf(this.source.slice(start, this.index), word) };
  }

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

  static expansionsIn(text: string): ReadonlyArray<string> {
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

  private parameter(inner: string, quoted: boolean): Word {
    const groups = PARAMETER_DEFAULT.exec(inner)?.groups;

    if (groups?.word === undefined) {
      return home(inner);
    }

    if (groups.name === "HOME" && groups.operator?.endsWith("+") !== true) {
      return home("HOME");
    }

    return this.defaultWord(groups.word, quoted);
  }

  private defaultWord(text: string, quoted: boolean): Word {
    if (this.nesting >= MAX_DEFAULT_NESTING) {
      return { text: "", literal: false };
    }

    const lexer = new Lexer(text, this.nesting + 1);
    const pieces: Array<Word> = [];
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

  private quotedPart(): Word {
    const char = this.source.charAt(this.index);
    const next = this.source.charAt(this.index + 1);

    if (char === "'" || (char === "\\" && !'$`"\\\n'.includes(next))) {
      this.index += 1;

      return { text: char, literal: true };
    }

    return this.wordPart(0);
  }

  private backtick(inDoubleQuotes: boolean): void {
    const end = this.backtickEnd(this.index);
    const inner = this.source.slice(this.index + 1, end === -1 ? undefined : end);
    this.substitutions.push(
      inner.replaceAll(inDoubleQuotes ? QUOTED_BACKTICK_ESCAPE : BACKTICK_ESCAPE, "$<char>"),
    );
    this.index = end === -1 ? this.source.length : end + 1;
  }

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

  private collect(scan: Scan, end: number): void {
    if (scan.span !== -1 && (scan.parens === 0 || end === this.source.length)) {
      this.substitution(this.source.slice(scan.span, end));
      scan.span = -1;
    }
  }

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

function joinPieces(pieces: ReadonlyArray<Piece>): Word {
  return {
    text: pieces.map((piece) => piece.text).join(""),
    literal: pieces.every((piece) => piece.literal),
    bare: pieces.every((piece) => piece.plain),
  };
}

type Expansion = ReadonlyArray<ReadonlyArray<Piece>>;

function expandBraces(pieces: ReadonlyArray<Piece>, depth: number): Expansion | undefined {
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

function matchingBraces(pieces: ReadonlyArray<Piece>): ReadonlyArray<number> {
  const closes = pieces.map(() => -1);
  const opens: Array<number> = [];

  for (const [index, piece] of pieces.entries()) {
    if (piece.plain && piece.text === "{") {
      opens.push(index);
    } else if (piece.plain && piece.text === "}") {
      closes[opens.pop() ?? index] = index;
    }
  }

  return closes;
}

function braceAlternatives(
  inner: ReadonlyArray<Piece>,
): ReadonlyArray<ReadonlyArray<Piece>> | undefined {
  const options: Array<Array<Piece>> = [[]];
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

function braceSequence(inner: ReadonlyArray<Piece>): Expansion | null | undefined {
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

function sequenceValues(from: number, to: number, step: string): ReadonlyArray<number> | undefined {
  const size = Math.abs(Number(step)) || 1;
  const count = Math.floor(Math.abs(to - from) / size) + 1;

  if (count > MAX_BRACE_WORDS) {
    return undefined;
  }

  const direction = to < from ? -size : size;

  return Array.from({ length: count }, (_, index) => from + index * direction);
}

function combineBraces(
  before: ReadonlyArray<Piece>,
  options: Expansion,
  after: ReadonlyArray<Piece>,
  depth: number,
): Expansion | undefined {
  const middle: Array<ReadonlyArray<Piece>> = [];

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
  private readonly directories: Array<string | undefined>;
  private readonly frames: Array<Frame>;
  private readonly loops: Array<{
    readonly variable?: string | undefined;
    list: ReadonlyArray<Word>;
  }> = [];

  constructor(
    cwd: string | undefined,
    private readonly depth: number,
    private readonly reads: Set<string>,
  ) {
    this.directories = [cwd];
    this.frames = [{ list: cwd, pipe: cwd, piped: false }];
  }

  run(items: ReadonlyArray<Item>): void {
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

  private coproc(words: ReadonlyArray<Word>, command: Command): void {
    const [, name, third] = words;

    const named =
      name?.literal === true &&
      /^[A-Za-z_]\w*$/u.test(name.text) &&
      third?.bare === true &&
      COMPOUND_START.has(third.text);

    const rest = words.slice(named ? 2 : 1);
    this.directories.push(this.cwd);

    if (rest[0]?.bare === true && rest[0].text === "{") {
      this.frames.push({ ...this.frame(), subshell: true });
      this.evaluateWords(this.withoutKeywords(rest.slice(1)), command);

      return;
    }

    this.evaluateWords(this.withoutKeywords(rest), command);
    this.directories.pop();
  }

  private evaluateWords(words: ReadonlyArray<Word>, command: Command): void {
    if (this.loopBoundary(words)) {
      return;
    }

    const assignments = leadingAssignments(words);

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

  private withoutKeywords(words: ReadonlyArray<Word>): ReadonlyArray<Word> {
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

  private loopBoundary(words: ReadonlyArray<Word>): boolean {
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

  private builtin(name: string, args: ReadonlyArray<Word>, command: Command): boolean {
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

  private trapAction(args: ReadonlyArray<Word>): void {
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

  private changeDirectory(args: ReadonlyArray<Word>): void {
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
      next =
        this.loops.length === 0 || isAbsolute(target.text) ? this.resolve(target.text) : undefined;
    }

    this.directories[this.directories.length - 1] = next;
  }

  private add(words: ReadonlyArray<Word>): void {
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

    return resolved.length > MAX_PATH_LENGTH ? undefined : resolved;
  }
}

function leadingAssignments(words: ReadonlyArray<Word>): number {
  const index = words.findIndex((word) => !ASSIGNMENT.test(word.text));

  return index === -1 ? words.length : index;
}

function unwrap(words: ReadonlyArray<Word>): ReadonlyArray<Word> {
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
      return [];
    }

    const positional = parsed.positionals;
    const after = positional.slice(wrapper.skip);
    remaining = after.slice(leadingAssignments(after));
  }
}

function parseArguments(
  args: ReadonlyArray<Word>,
  options: Options,
  stopAtPositional = false,
): Arguments {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: Array<Word> = [];
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

function fileArguments(name: string, args: ReadonlyArray<Word>): ReadonlyArray<Word> | undefined {
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

function ddInputs(args: ReadonlyArray<Word>): ReadonlyArray<Word> {
  return args.flatMap((word) =>
    word.literal && word.text.startsWith("if=")
      ? [{ text: word.text.slice(3), literal: true }]
      : [],
  );
}

function withoutProgram(
  parsed: Arguments,
  programOptions: ReadonlyArray<string>,
): ReadonlyArray<Word> {
  return programOptions.some((option) => parsed.values.has(option))
    ? parsed.positionals
    : parsed.positionals.slice(1);
}

function shellScript(args: ReadonlyArray<Word>, heredoc: string | undefined): string | undefined {
  const parsed = parseArguments(args, { short: "o", long: [] });

  if (parsed.flags.has("-c")) {
    const [script] = parsed.positionals;

    return script?.literal === true ? script.text : undefined;
  }

  return parsed.positionals.length === 0 ? heredoc : undefined;
}
