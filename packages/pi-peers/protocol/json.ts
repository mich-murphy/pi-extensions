import { Schema } from "effect";

const decodeObject = Schema.decodeUnknownSync(Schema.JsonObject);

export const MAX_BODY_BYTES = 32_764;
export const MAX_ARRAY_ITEMS = 64;
export const MAX_NESTING_DEPTH = 16;

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

export type ObjectBytesVisitor = (path: ReadonlyArray<string | number>, byteLength: number) => void;

class JsonEvidence {
  private position = 0;
  constructor(
    private readonly text: string,
    private readonly onObject?: ObjectBytesVisitor,
  ) {}

  private whitespace(): void {
    let code = this.text.codePointAt(this.position);

    while (code === 32 || code === 10 || code === 13 || code === 9) {
      this.position++;
      code = this.text.codePointAt(this.position);
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

        if (typeof value === "string" && value.isWellFormed()) {
          return value;
        }

        throw new ProtocolError();
      }

      if (character === "\\") {
        this.position++;
      }
    }

    throw new ProtocolError();
  }

  private object(depth: number, path: ReadonlyArray<string | number>): void {
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

  private array(depth: number, path: ReadonlyArray<string | number>): void {
    this.consume("[");
    let count = 0;
    this.whitespace();

    if (this.text[this.position] !== "]") {
      do {
        requireValid(++count <= MAX_ARRAY_ITEMS);
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

  private value(parentDepth: number, path: ReadonlyArray<string | number>): void {
    this.whitespace();
    const next = this.text[this.position];

    if (next === "{" || next === "[") {
      requireValid(parentDepth < MAX_NESTING_DEPTH);

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

export function decodeJson(bytes: Uint8Array, onObject?: ObjectBytesVisitor): Schema.JsonObject {
  try {
    requireValid(bytes.length > 0 && bytes.length <= MAX_BODY_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    new JsonEvidence(text, onObject).check();

    return decodeObject(JSON.parse(text));
  } catch {
    throw new ProtocolError();
  }
}
