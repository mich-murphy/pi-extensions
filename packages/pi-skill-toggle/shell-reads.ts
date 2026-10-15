import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

/** A shell word, and whether its text is known without running the shell. */
type Word = { readonly text: string; readonly literal: boolean };

/** One simple command. Its heredoc body is filled in once the lexer reaches the next line. */
type Command = {
  readonly words: readonly Word[];
  readonly inputs: readonly Word[];
  readonly heredoc: { body: string | undefined };
};

type Item =
  | { readonly kind: "command"; readonly command: Command }
  | { readonly kind: "open" }
  | { readonly kind: "close" };

/** Option letters and long options that take a separate value. */
type Options = { readonly short: string; readonly long: readonly string[] };

type Arguments = {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly positionals: readonly Word[];
};

const MAX_DEPTH = 3;
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
const CONDITION_LOOPS = new Set(["while", "until"]);
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
    nice: { options: { short: "n", long: [] }, skip: 0 },
    timeout: { options: { short: "sk", long: [] }, skip: 1 },
    stdbuf: { options: { short: "ioe", long: [] }, skip: 0 },
    xargs: { options: { short: "IndPLsEa", long: [] }, skip: 0 },
  }),
);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
/** Inline-script options of each interpreter family. */
const INTERPRETERS: readonly {
  readonly name: RegExp;
  readonly options: Options;
  readonly script: readonly string[];
}[] = [
  { name: /^python[\d.]*$/u, options: { short: "cmWX", long: [] }, script: ["-c"] },
  {
    name: /^(?:node|bun)$/u,
    options: { short: "epr", long: ["--eval", "--print", "--require", "--import"] },
    script: ["-e", "--eval", "-p", "--print"],
  },
  { name: /^(?:perl|ruby)$/u, options: { short: "eEI", long: [] }, script: ["-e", "-E"] },
];
/** An inline script reads the paths it names only when it calls a file-reading API. */
const SCRIPT_READ_CALL =
  /\.read\(|\bread_text\(|\bread_bytes\(|\breadlines\(|\breadFile(?:Sync)?\(|\bcreateReadStream\(|\bFile\.read\(/u;
const PATH_SHAPED = /\/|\.\w+$/u;
const STRING_LITERAL = /(?<quote>['"`])(?<body>(?:\\.|(?!\k<quote>)[^\\\n])*)\k<quote>/gu;

/**
 * List the files a shell command prints the contents of, as far as its literal text shows.
 *
 * Reports literal file arguments of content readers such as `cat`, `head`, `sed`, `grep`, and `rg`,
 * the list of a `for` loop whose body runs a reader, input redirects, and string literals in
 * inline Python, Node, Perl, or Ruby scripts that call a file-reading API. Never reports listing,
 * counting, editing, copying, or Git commands, and skips anything it cannot resolve without running
 * the shell, such as variables, globs, and command substitutions.
 *
 * @param command - Shell command text, as the bash tool receives it.
 * @param cwd - Directory relative paths start from.
 * @returns Absolute paths whose content the command reads.
 */
export function pathsReadByCommand(command: string, cwd: string): readonly string[] {
  const reads = new Set<string>();
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
  for (const inner of lexer.substitutions) {
    analyze(inner, cwd, depth + 1, reads);
  }
}

class Lexer {
  readonly items: Item[] = [];
  readonly substitutions: string[] = [];
  private index = 0;
  private words: Word[] = [];
  private inputs: Word[] = [];
  private heredoc: { body: string | undefined } = { body: undefined };
  private readonly pending: {
    readonly heredoc: { body: string | undefined };
    readonly delimiter: string;
  }[] = [];

  constructor(private readonly source: string) {}

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
        this.index += 1;
        this.flush();
        this.readHeredocBodies();
      } else if ((char === "<" || char === ">") && this.source.charAt(this.index + 1) === "(") {
        this.index += 2;
        this.substitutions.push(this.balanced());
        this.words.push({ text: "", literal: false });
      } else {
        this.operatorOrWord();
      }
    }
    this.flush();
  }

  private operatorOrWord(): void {
    FILE_DESCRIPTOR.lastIndex = this.index;
    if (FILE_DESCRIPTOR.test(this.source)) {
      this.index = FILE_DESCRIPTOR.lastIndex;
    }
    const operator = OPERATORS.find((candidate) => this.source.startsWith(candidate, this.index));
    if (operator === undefined) {
      this.words.push(this.word());
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
      this.pending.push({ heredoc: this.heredoc, delimiter: this.target().text });
    } else if (OUTPUT_REDIRECTS.has(operator)) {
      this.target();
    } else {
      this.flush();
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
        command: { words: this.words, inputs: this.inputs, heredoc: this.heredoc },
      });
    }
    this.words = [];
    this.inputs = [];
    this.heredoc = { body: undefined };
  }

  private readHeredocBodies(): void {
    for (const { heredoc, delimiter } of this.pending.splice(0)) {
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
    }
  }

  private word(): Word {
    const start = this.index;
    let text = "";
    let literal = true;
    while (this.index < this.source.length && !WORD_END.has(this.source.charAt(this.index))) {
      const part = this.wordPart(start);
      text += part.text;
      literal &&= part.literal;
    }
    return { text, literal };
  }

  /** Consume one piece of a word: an escape, a quoted run, an expansion, or one character. */
  private wordPart(start: number): Word {
    const char = this.source.charAt(this.index);
    switch (char) {
      case "\\": {
        const text = this.source.charAt(this.index + 1);
        this.index += 2;
        return { text, literal: true };
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
        this.backtick();
        return { text: "", literal: false };
      }
      default: {
        break;
      }
    }
    this.index += 1;
    if (char === "~" && this.index - 1 === start && this.tildeEndsAt(this.index)) {
      return { text: homedir(), literal: true };
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
      if (char === "\\" && '$`"\\'.includes(this.source.charAt(this.index + 1))) {
        text += this.source.charAt(this.index + 1);
        this.index += 2;
      } else if (char === "$") {
        const expansion = this.dollar();
        text += expansion.text;
        literal &&= expansion.literal;
      } else if (char === "`") {
        this.backtick();
        literal = false;
      } else {
        text += char;
        this.index += 1;
      }
    }
    return { text, literal: false };
  }

  /** Only `$HOME` has a value known without running the shell; every other expansion is dynamic. */
  private dollar(): Word {
    const next = this.source.charAt(this.index + 1);
    if (next === "(") {
      this.index += 2;
      const inner = this.balanced();
      if (!inner.startsWith("(")) {
        this.substitutions.push(inner);
      }
      return { text: "", literal: false };
    }
    if (next === "{") {
      const end = this.source.indexOf("}", this.index + 2);
      const name = this.source.slice(this.index + 2, end === -1 ? undefined : end);
      this.index = end === -1 ? this.source.length : end + 1;
      return home(name);
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

  private backtick(): void {
    const end = this.source.indexOf("`", this.index + 1);
    this.substitutions.push(this.source.slice(this.index + 1, end === -1 ? undefined : end));
    this.index = end === -1 ? this.source.length : end + 1;
  }

  /** Read up to the `)` that closes an already consumed `(`, skipping quoted text. */
  private balanced(): string {
    const start = this.index;
    let depth = 1;
    while (this.index < this.source.length) {
      const char = this.source.charAt(this.index);
      if (char === "\\") {
        this.index += 2;
      } else if (char === "'" || char === '"') {
        const end = this.source.indexOf(char, this.index + 1);
        this.index = end === -1 ? this.source.length : end + 1;
      } else {
        depth += Number(char === "(") - Number(char === ")");
        this.index += 1;
        if (depth === 0) {
          return this.source.slice(start, this.index - 1);
        }
      }
    }
    return this.source.slice(start);
  }
}

function home(name: string): Word {
  return name === "HOME" ? { text: homedir(), literal: true } : { text: "", literal: false };
}

class Evaluator {
  private readonly directories: (string | undefined)[];
  /** Lists of the enclosing `for` loops, and whether each loop's body runs a reader. */
  private readonly loops: { readonly list: readonly Word[]; reads: boolean }[] = [];

  constructor(
    cwd: string | undefined,
    private readonly depth: number,
    private readonly reads: Set<string>,
  ) {
    this.directories = [cwd];
  }

  run(items: readonly Item[]): void {
    for (const item of items) {
      if (item.kind === "open") {
        this.directories.push(this.cwd);
      } else if (item.kind === "close") {
        if (this.directories.length > 1) {
          this.directories.pop();
        }
      } else {
        this.evaluate(item.command);
      }
    }
  }

  private get cwd(): string | undefined {
    return this.directories.at(-1);
  }

  private evaluate(command: Command): void {
    const words = this.withoutKeywords(command.words);
    if (this.loopBoundary(words)) {
      return;
    }
    const run = unwrap(words.slice(leadingAssignments(words)));
    const files = this.filesRead(basename(run[0]?.text ?? ""), run.slice(1), command);
    if (files === undefined) {
      return;
    }
    this.add(files);
    // A loop's list is read only when a reader takes a variable, such as `cat "$p"`.
    if (files.some((word) => !word.literal)) {
      for (const loop of this.loops) {
        loop.reads = true;
      }
    }
  }

  /** Drop leading keywords such as `if` and `do`, opening a loop for `while` and `until`. */
  private withoutKeywords(words: readonly Word[]): readonly Word[] {
    const start = words.findIndex((word) => !(word.literal && KEYWORDS.has(word.text)));
    const keywords = start === -1 ? words : words.slice(0, start);
    for (const keyword of keywords) {
      if (CONDITION_LOOPS.has(keyword.text)) {
        this.loops.push({ list: [], reads: false });
      }
    }
    return start === -1 ? [] : words.slice(start);
  }

  /** Open a loop at `for` and close one at `done`; returns whether the command was either. */
  private loopBoundary(words: readonly Word[]): boolean {
    const [first, , third] = words;
    if (first?.literal !== true) {
      return false;
    }
    if (first.text === "for") {
      const list = third?.literal === true && third.text === "in" ? words.slice(3) : [];
      this.loops.push({ list, reads: false });
      return true;
    }
    if (first.text !== "done") {
      return false;
    }
    const loop = this.loops.pop();
    if (loop?.reads === true) {
      this.add(loop.list);
    }
    return true;
  }

  /** Files the command prints, or undefined when it is not a content reader. */
  private filesRead(
    name: string,
    args: readonly Word[],
    command: Command,
  ): readonly Word[] | undefined {
    if (name === "cd" || name === "pushd") {
      this.changeDirectory(args);
      return undefined;
    }
    if (SHELLS.has(name)) {
      const script = shellScript(args, command.heredoc.body);
      if (script !== undefined) {
        analyze(script, this.cwd, this.depth + 1, this.reads);
      }
      return undefined;
    }
    const interpreter = INTERPRETERS.find((family) => family.name.test(name));
    if (interpreter !== undefined) {
      const script = inlineScript(interpreter, args, command.heredoc.body);
      return script !== undefined && SCRIPT_READ_CALL.test(script)
        ? stringLiterals(script)
        : undefined;
    }
    const files = fileArguments(name, args);
    return files === undefined ? undefined : [...files, ...command.inputs];
  }

  private changeDirectory(args: readonly Word[]): void {
    const [target] = args;
    let next: string | undefined;
    if (target === undefined) {
      next = homedir();
    } else if (target.literal && target.text !== "-") {
      next = this.resolve(target.text);
    }
    this.directories[this.directories.length - 1] = next;
  }

  private add(words: readonly Word[]): void {
    for (const word of words) {
      if (word.literal && word.text !== "" && !word.text.startsWith("-")) {
        const path = this.resolve(word.text);
        if (path !== undefined) {
          this.reads.add(path);
        }
      }
    }
  }

  private resolve(path: string): string | undefined {
    if (isAbsolute(path)) {
      return resolve(path);
    }
    return this.cwd === undefined ? undefined : resolve(this.cwd, path);
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
    const positional = parseArguments(rest, wrapper.options, true).positionals;
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

function inlineScript(
  interpreter: (typeof INTERPRETERS)[number],
  args: readonly Word[],
  heredoc: string | undefined,
): string | undefined {
  const parsed = parseArguments(args, interpreter.options);
  if (parsed.flags.has("-i")) {
    return undefined;
  }
  const inline = interpreter.script
    .map((option) => parsed.values.get(option))
    .find((script) => script !== undefined);
  if (inline !== undefined) {
    return inline;
  }
  const [first] = parsed.positionals;
  return first === undefined || first.text === "-" ? heredoc : undefined;
}

/** String literals shaped like file paths: containing a `/` or ending in a file extension. */
function stringLiterals(script: string): readonly Word[] {
  return [...script.matchAll(STRING_LITERAL)].flatMap((match) => {
    const text = match.groups?.body ?? "";
    return PATH_SHAPED.test(text) ? [{ text, literal: true }] : [];
  });
}
