/**
 * Length of text as `text.replace(/\s+/g, " ").trim()` would produce it, measured without building
 * the collapsed string, and composable across adjacent pieces of text.
 */

function isWhitespaceCodeUnit(codeUnit: number): boolean {
  if (codeUnit <= 32) {
    return codeUnit === 32 || (codeUnit >= 9 && codeUnit <= 13);
  }
  if (codeUnit < 160) {
    return false;
  }
  return (
    codeUnit === 160 ||
    codeUnit === 5760 ||
    (codeUnit >= 8192 && codeUnit <= 8202) ||
    codeUnit === 8232 ||
    codeUnit === 8233 ||
    codeUnit === 8239 ||
    codeUnit === 8287 ||
    codeUnit === 12_288 ||
    codeUnit === 65_279
  );
}

/**
 * A running measure of text whose whitespace runs collapse to single spaces. Appending text or
 * another measure gives the measure of the concatenated text: a trailing collapsed space and a
 * leading one merge, as the two whitespace runs would.
 */
export class CollapsedTextLength {
  #length = 0;
  #leadingSpace = false;
  #trailingSpace = false;

  /**
   * Append raw text, counting its UTF-16 code units.
   *
   * @param text - Text to append.
   */
  appendText(text: string): void {
    for (let codeUnitIndex = 0; codeUnitIndex < text.length; codeUnitIndex += 1) {
      if (!isWhitespaceCodeUnit(text.charCodeAt(codeUnitIndex))) {
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
