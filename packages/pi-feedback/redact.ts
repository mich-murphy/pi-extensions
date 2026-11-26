export const REDACTED = "<secret>";

const TOKENS: ReadonlyArray<RegExp> = [
  /(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/gu,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/gu,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/gu,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
];

const BEARER = /\b(?<label>Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/giu;

const ASSIGNED =
  /\b(?<label>\w*(?:api[_-]?key|token|secret|password|passwd)\w*["']?\s*[=:]\s*["']?)[^\s"',;]{8,}/giu;

export function redact(text: string): string {
  let current = text;

  for (const pattern of TOKENS) {
    current = current.replaceAll(pattern, REDACTED);
  }

  return current
    .replaceAll(BEARER, `$<label>${REDACTED}`)
    .replaceAll(ASSIGNED, `$<label>${REDACTED}`);
}
