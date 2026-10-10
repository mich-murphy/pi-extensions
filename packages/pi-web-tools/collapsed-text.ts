/**
 * Length of text as `text.replace(/\s+/g, " ").trim()` would produce it, measured without building
 * the collapsed string, and composable across adjacent pieces of text.
 */

/** Returns true for the code points JavaScript's `\s` matches (the same set `trim` removes). */
function isWhitespaceCode(code: number): boolean {
  if (code <= 32) {
    return code === 32 || (code >= 9 && code <= 13);
  }
  if (code < 160) {
    return false;
  }
  return (
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12_288 ||
    code === 65_279
  );
}

/**
 * A running measure of text whose whitespace runs collapse to single spaces. Appending text or
 * another measure gives the measure of the concatenated text: a trailing collapsed space and a
 * leading one merge, as the two whitespace runs would.
 */
export class CollapsedTextLength {
  /** Length of the collapsed, untrimmed text. */
  #length = 0;
  /** Whether the collapsed text starts with a space. */
  #leadingSpace = false;
  /** Whether the collapsed text ends with a space. */
  #trailingSpace = false;

  /**
   * Append raw text.
   *
   * @param text - Text to append.
   */
  appendText(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      // Each unit of a surrogate pair reads as a non-space code point, so the pair counts as two
      // units, as it does in the collapsed string's length.
      if (!isWhitespaceCode(text.codePointAt(index) ?? 0)) {
        this.#length += 1;
        this.#trailingSpace = false;
      } else if (this.#length === 0) {
        this.#length = 1;
        this.#leadingSpace = true;
        this.#trailingSpace = true;
      } else if (!this.#trailingSpace) {
        this.#length += 1;
        this.#trailingSpace = true;
      }
    }
  }

  /**
   * Append the measure of the text that follows this one.
   *
   * @param next - Measure of the following text.
   */
  append(next: CollapsedTextLength): void {
    if (next.#length === 0) {
      return;
    }
    if (this.#length === 0) {
      this.#leadingSpace = next.#leadingSpace;
    }
    this.#length += next.#length - (this.#trailingSpace && next.#leadingSpace ? 1 : 0);
    this.#trailingSpace = next.#trailingSpace;
  }

  /**
   * Length of the collapsed text once trimmed.
   *
   * @returns The normalized length.
   */
  trimmedLength(): number {
    // A lone collapsed space is both the leading and the trailing space.
    if (this.#length === 1 && this.#leadingSpace) {
      return 0;
    }
    return this.#length - (this.#leadingSpace ? 1 : 0) - (this.#trailingSpace ? 1 : 0);
  }
}

/**
 * Length of `text.replace(/\s+/g, " ").trim()`.
 *
 * @param text - Raw text.
 * @returns The normalized length.
 */
export function normalizedTextLength(text: string): number {
  const measure = new CollapsedTextLength();
  measure.appendText(text);
  return measure.trimmedLength();
}
