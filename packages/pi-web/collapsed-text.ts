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

export class CollapsedTextLength {
  #length = 0;
  #leadingSpace = false;
  #trailingSpace = false;

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

  trimmedLength(): number {
    if (this.#length === 1 && this.#leadingSpace) {
      return 0;
    }

    return this.#length - (this.#leadingSpace ? 1 : 0) - (this.#trailingSpace ? 1 : 0);
  }
}

export function normalizedTextLength(text: string): number {
  const measure = new CollapsedTextLength();
  measure.appendText(text);

  return measure.trimmedLength();
}
