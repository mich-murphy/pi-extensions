const MAX_BODY_BYTES = 32_764;

/** Structural failures must close the affected connection; never expose hostile input. */
export class ProtocolError extends Error {
  constructor() {
    super("Invalid session communication frame");
    this.name = "ProtocolError";
  }
}

function requireValid(condition: boolean): void {
  if (!condition) {
    throw new ProtocolError();
  }
}

export type ObjectBytesVisitor = (path: readonly (string | number)[], byteLength: number) => void;

/** Bounded evidence pass BEFORE JSON.parse: keys, numeric lexemes and container limits. */
class JsonEvidence {
  private position = 0;
  constructor(
    private readonly text: string,
    private readonly onObject?: ObjectBytesVisitor,
  ) {}

  private whitespace(): void {
    while (/[\t\n\r ]/u.test(this.text[this.position] ?? "!")) {
      this.position++;
    }
  }

  private consume(expected: string): void {
    this.whitespace();
    requireValid(this.text[this.position++] === expected);
  }

  private string(): string {
    this.whitespace();
    const start = this.position;
    requireValid(this.text[this.position++] === '"');
    while (this.position < this.text.length) {
      const character = this.text[this.position++];
      if (character === '"') {
        const value: unknown = JSON.parse(this.text.slice(start, this.position));
        requireValid(typeof value === "string" && value.isWellFormed());
        if (typeof value === "string") {
          return value;
        }
      }
      if (character === "\\") {
        this.position++;
      }
    }
    throw new ProtocolError();
  }

  private object(depth: number, path: readonly (string | number)[]): void {
    const start = this.position;
    this.consume("{");
    const keys = new Set<string>();
    this.whitespace();
    if (this.text[this.position] !== "}") {
      do {
        const key = this.string();
        requireValid(!keys.has(key));
        keys.add(key);
        this.consume(":");
        this.value(depth, [...path, key]);
        this.whitespace();
      } while (this.text[this.position] === "," && ++this.position > 0);
    }
    this.consume("}");
    this.onObject?.(path, Buffer.byteLength(this.text.slice(start, this.position), "utf8"));
  }

  private array(depth: number, path: readonly (string | number)[]): void {
    this.consume("[");
    let count = 0;
    this.whitespace();
    if (this.text[this.position] !== "]") {
      do {
        requireValid(++count <= 64);
        this.value(depth, [...path, count - 1]);
        this.whitespace();
      } while (this.text[this.position] === "," && ++this.position > 0);
    }
    this.consume("]");
  }

  private scalar(): void {
    const remainder = this.text.slice(this.position);
    const token = /^(?:true|false|0|[1-9][0-9]*)/u.exec(remainder)?.[0];
    requireValid(token !== undefined);
    if (token === undefined) {
      throw new ProtocolError();
    }
    if (token !== "true" && token !== "false") {
      requireValid(Number.isSafeInteger(Number(token)));
    }
    this.position += token.length;
  }

  private value(parentDepth: number, path: readonly (string | number)[]): void {
    this.whitespace();
    const next = this.text[this.position];
    if (next === "{" || next === "[") {
      requireValid(parentDepth < 16);
      if (next === "{") {
        this.object(parentDepth + 1, path);
      } else {
        this.array(parentDepth + 1, path);
      }
    } else if (next === '"') {
      this.string();
    } else {
      this.scalar();
    }
  }

  check(): void {
    this.whitespace();
    requireValid(this.text[this.position] === "{");
    this.value(0, []);
    this.whitespace();
    requireValid(this.position === this.text.length);
  }
}

/** Strict UTF8, one object, no null, max depth16/array64 and lexical safe naturals. */
export function decodeJson(bytes: Uint8Array, onObject?: ObjectBytesVisitor): unknown {
  try {
    requireValid(bytes.length > 0 && bytes.length <= MAX_BODY_BYTES);
    // ignoreBOM preserves U+FEFF so the JSON evidence pass rejects it.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    new JsonEvidence(text, onObject).check();
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new ProtocolError();
  }
}
