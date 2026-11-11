/** Bound untrusted resource names and local paths before displaying a diagnostic. */
export function diagnosticText(value: string): string {
  const safe = value
    .replaceAll(/https?:\/\/[^\s]+/giu, "[URL omitted]")
    .replaceAll(
      /\p{Cc}|\p{Bidi_Control}/gu,
      (character) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
    );
  return safe.length <= 512 ? safe : `${safe.slice(0, 509)}...`;
}
