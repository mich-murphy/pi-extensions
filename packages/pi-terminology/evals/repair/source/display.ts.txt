const FIRST_BIDI_EMBEDDING = "\u202A".codePointAt(0) ?? 0;
const LAST_BIDI_OVERRIDE = "\u202E".codePointAt(0) ?? 0;
const FIRST_BIDI_ISOLATE = "\u2066".codePointAt(0) ?? 0;
const LAST_BIDI_ISOLATE = "\u2069".codePointAt(0) ?? 0;
const LINE_SEPARATOR = "\u2028".codePointAt(0) ?? 0;
const PARAGRAPH_SEPARATOR = "\u2029".codePointAt(0) ?? 0;
const LAST_BASIC_MULTILINGUAL_PLANE = "\uFFFF".codePointAt(0) ?? 0;

export function escapeForDisplay(value: string): string {
  let escaped = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    escaped += isUnsafeForDisplayCode(code) ? escapeCodePoint(code) : char;
  }
  return escaped;
}

export function isUnsafeForDisplay(value: string): boolean {
  for (const char of value) {
    if (isUnsafeForDisplayCode(char.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

function isUnsafeForDisplayCode(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= FIRST_BIDI_EMBEDDING && code <= LAST_BIDI_OVERRIDE) ||
    (code >= FIRST_BIDI_ISOLATE && code <= LAST_BIDI_ISOLATE) ||
    code === LINE_SEPARATOR ||
    code === PARAGRAPH_SEPARATOR
  );
}

function escapeCodePoint(code: number): string {
  const hex = code.toString(16).toUpperCase();
  return code <= LAST_BASIC_MULTILINGUAL_PLANE ? `\\u${hex.padStart(4, "0")}` : `\\u{${hex}}`;
}
