/** Lexical facts needed by the executable-output guard, not a general shell AST. */
type Word = { text: string; discovered: boolean; quoted: boolean };
type Heredoc = { delimiter: string; quoted: boolean; tabs: boolean };
type Scope = { discovered: boolean; blocked: boolean };

const WORD_END = /[\s;&|()<>]/u;
const FILE_DESCRIPTOR = /\d+(?=[<>])/uy;
const GROUP_PREFIXES = new Set(["!", "if", "then", "elif", "else", "do", "while", "until"]);
const COMMAND_PREFIXES = new Set([
  "!",
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "time",
  "env",
  "sudo",
  "exec",
  "nohup",
]);

function commandWords(words: readonly Word[]): readonly Word[] {
  let offset = 0;
  while (offset < words.length) {
    const text = words[offset]?.text ?? "";
    const wrapped = text === "command" && words[offset + 1]?.text !== "-v";
    if (!COMMAND_PREFIXES.has(text) && !wrapped && !/^[A-Za-z_]\w*=/u.test(text)) {
      break;
    }
    offset += 1;
  }
  return words.slice(offset);
}

/**
 * Recognize cat/discovery relationships without interpreting literal shell data as commands.
 * No shell is run. Aliases, eval, variable values and arbitrary interpreter scripts are not
 * resolved; output quarantine remains the backstop for unrecognized binary output.
 *
 * @param source - Source passed to the bash tool.
 * @returns Whether a recognized executable-dump command occurs in executable shell text.
 */
export function hasExecutableCat(source: string): boolean {
  return new ShellScan(source).scan().blocked;
}

class ShellScan {
  private position = 0;
  private blocked = false;

  constructor(private readonly source: string) {}

  scan(stop = "", depth = 0): Scope {
    // Avoid recursive stack exhaustion. Do not silently exempt deeply nested shell source.
    if (depth > 100) {
      this.blocked = true;
      this.position = this.source.length;
      return { discovered: false, blocked: true };
    }
    let words: Word[] = [];
    let discovered = false;
    const heredocs: Heredoc[] = [];
    const inputs: Word[] = [];
    const finish = () => {
      const executable = commandWords(words);
      const name = executable[0]?.text.split("/").at(-1);
      discovered ||=
        name === "which" ||
        (name === "command" && executable[1]?.text === "-v") ||
        words.some((word) => word.discovered);
      this.blocked ||=
        name === "cat" && [...executable.slice(1), ...inputs].some((word) => word.discovered);
      words = [];
      inputs.length = 0;
    };
    while (this.position < this.source.length) {
      const character = this.source[this.position] ?? "";
      if (stop && character === stop) {
        this.position += 1;
        break;
      }
      if (character === "\n") {
        finish();
        this.position += 1;
        this.readHeredocs(heredocs, depth);
      } else if (character === "(") {
        finish();
        this.position += 1;
        const group = this.scan(")", depth + 1);
        discovered ||= group.discovered;
      } else if (";&|)".includes(character)) {
        finish();
        this.position += 1;
      } else if (this.skipToken(character, heredocs, inputs, depth)) {
        continue;
      } else {
        const word = this.word(depth, false, stop);
        if (!this.reservedBrace(word, words)) {
          words.push(word);
        }
      }
    }
    finish();
    return { discovered, blocked: this.blocked };
  }

  private reservedBrace(word: Word, words: readonly Word[]): boolean {
    return (
      !word.quoted &&
      word.text === "{" &&
      words.every((prefix) => !prefix.quoted && GROUP_PREFIXES.has(prefix.text))
    );
  }

  private skipToken(
    character: string,
    heredocs: Heredoc[],
    inputs: Word[],
    depth: number,
  ): boolean {
    FILE_DESCRIPTOR.lastIndex = this.position;
    const descriptor = FILE_DESCRIPTOR.exec(this.source);
    if (descriptor) {
      this.position += descriptor[0].length;
      return this.skipToken(this.source[this.position] ?? "", heredocs, inputs, depth);
    }
    if (/\s/u.test(character)) {
      this.position += 1;
    } else if (character === "#") {
      this.skipComment();
    } else if (
      this.source.startsWith("<<", this.position) &&
      !this.source.startsWith("<<<", this.position)
    ) {
      heredocs.push(this.heredocDelimiter(depth));
    } else if ("<>".includes(character)) {
      const target = this.redirect(depth);
      if (character === "<") {
        inputs.push(target);
      }
    } else {
      return false;
    }
    return true;
  }

  private skipComment(): void {
    const end = this.source.indexOf("\n", this.position);
    this.position = end < 0 ? this.source.length : end;
  }

  private skipSpace(): void {
    while (/[ \t]/u.test(this.source[this.position] ?? "")) {
      this.position += 1;
    }
  }

  private word(depth: number, delimiter = false, stop = ""): Word {
    const result: Word = { text: "", discovered: false, quoted: false };
    let quote = "";
    while (this.position < this.source.length) {
      const character = this.source[this.position] ?? "";
      if (!quote && (WORD_END.test(character) || (stop && character === stop))) {
        break;
      }
      this.position += 1;
      quote = this.piece(character, quote, result, delimiter, depth);
    }
    return result;
  }

  private piece(
    character: string,
    quote: string,
    result: Word,
    delimiter: boolean,
    depth: number,
  ): string {
    if (
      delimiter &&
      !quote &&
      character === "$" &&
      /['"]/u.test(this.source[this.position] ?? "")
    ) {
      result.quoted = true;
      result.text += this.dollarDelimiter();
      return "";
    }
    if (delimiter && !quote && this.isExpansion(character)) {
      // Delimiter words aren't expanded. Refuse unsupported substitution-shaped spelling
      // instead of guessing a terminator and silently exempting executable trailing source.
      this.blocked = true;
    }
    if (character === quote) {
      return "";
    }
    if (!quote && (character === "'" || character === '"')) {
      result.quoted = true;
      return character;
    }
    if (character === "\\" && quote !== "'") {
      result.quoted ||= this.source[this.position] !== "\n";
      result.text += this.escape(quote);
    } else if (!delimiter && quote !== "'" && this.isExpansion(character)) {
      const expansion = this.expansion(character, depth);
      result.discovered ||= expansion.discovered;
      result.text += "\0";
    } else {
      result.text += character;
    }
    return quote;
  }

  private dollarDelimiter(): string {
    const quote = this.source[this.position] ?? "";
    this.position += 1;
    // Locale-quoted delimiters may be translated by Bash; no locale catalog is read here.
    this.blocked ||= quote === '"';
    let text = "";
    while (this.position < this.source.length) {
      const character = this.source[this.position] ?? "";
      this.position += 1;
      if (character === quote) {
        return text;
      }
      if (character === "\\") {
        // ANSI-C escapes and locale-dependent translation are not evaluated. Refuse
        // escaped spellings rather than risk assigning the wrong heredoc terminator.
        this.blocked = true;
      }
      text += character;
    }
    this.blocked = true;
    return text;
  }

  private escape(quote: string): string {
    const next = this.source[this.position] ?? "";
    if (quote === '"' && !'$`"\\\n'.includes(next)) {
      return "\\";
    }
    this.position += 1;
    return next === "\n" ? "" : next;
  }

  private heredocDelimiter(depth: number): Heredoc {
    this.position += 2;
    const tabs = this.source[this.position] === "-";
    if (tabs) {
      this.position += 1;
    }
    this.skipSpace();
    const delimiter = this.word(depth, true);
    return { delimiter: delimiter.text, quoted: delimiter.quoted, tabs };
  }

  private redirect(depth: number): Word {
    this.position += 1;
    // Targets aren't command words, but their expansions still execute.
    while ("<>&|".includes(this.source[this.position] ?? "\0")) {
      this.position += 1;
    }
    this.skipSpace();
    return this.word(depth);
  }

  private isExpansion(character: string): boolean {
    return character === "`" || (character === "$" && this.source[this.position] === "(");
  }

  private expansion(character: string, depth: number): Scope {
    if (character === "$") {
      this.position += 1;
      if (this.source[this.position] === "(") {
        this.position += 1;
        return this.arithmetic(depth + 1);
      }
    }
    return this.scan(character === "`" ? "`" : ")", depth + 1);
  }

  private arithmetic(depth: number): Scope {
    if (depth > 100) {
      this.blocked = true;
      this.position = this.source.length;
      return { discovered: false, blocked: true };
    }
    let parentheses = 0;
    let discovered = false;
    while (this.position < this.source.length) {
      const character = this.source[this.position] ?? "";
      this.position += 1;
      if (character === "\\") {
        this.position += 1;
      } else if (this.isExpansion(character)) {
        const nested = this.expansion(character, depth);
        discovered ||= nested.discovered;
      } else if (character === "(") {
        parentheses += 1;
      } else if (character === ")") {
        if (parentheses === 0 && this.source[this.position] === ")") {
          this.position += 1;
          break;
        }
        parentheses -= 1;
      }
    }
    return { discovered, blocked: this.blocked };
  }

  private readHeredocs(heredocs: Heredoc[], depth: number): void {
    for (const heredoc of heredocs.splice(0)) {
      const body = this.heredocBody(heredoc);
      if (!heredoc.quoted) {
        this.heredocExpansions(body, depth);
      }
    }
  }

  private line(): string {
    const end = this.source.indexOf("\n", this.position);
    const next = end < 0 ? this.source.length : end + 1;
    const line = this.source.slice(this.position, end < 0 ? next : end);
    this.position = next;
    return line;
  }

  private heredocBody(heredoc: Heredoc): string {
    const lines: string[] = [];
    while (this.position < this.source.length) {
      let line = this.line();
      while (
        !heredoc.quoted &&
        /(?:^|[^\\])(?:\\\\)*\\$/u.test(line) &&
        this.position < this.source.length
      ) {
        line = line.slice(0, -1) + this.line();
      }
      const stripped = heredoc.tabs ? line.replace(/^\t+/u, "") : line;
      if (stripped === heredoc.delimiter) {
        break;
      }
      lines.push(stripped);
    }
    return lines.join("\n");
  }

  private heredocExpansions(body: string, depth: number): void {
    const scanner = new ShellScan(body);
    // Here-doc quotes are data, but backslash can suppress $, backtick and backslash.
    while (scanner.position < body.length) {
      const character = body[scanner.position] ?? "";
      scanner.position += 1;
      if (character === "\\" && /[$`\\\n]/u.test(body[scanner.position] ?? "")) {
        scanner.position += 1;
      } else if (scanner.isExpansion(character)) {
        scanner.expansion(character, depth);
      }
    }
    this.blocked ||= scanner.blocked;
  }
}
