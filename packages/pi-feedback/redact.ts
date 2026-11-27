export const REDACTED = "<secret>";

const TOKENS: ReadonlyArray<RegExp> = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/gu,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/gu,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/gu,
  /(?<![A-Za-z0-9])xox[abeprs]-[A-Za-z0-9-]{10,}/gu,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/gu,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
  /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}/gu,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/gu,
  /(?<![A-Za-z0-9])[rs]k_(?:test|live|prod)_[A-Za-z0-9]{10,99}/gu,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/gu,
  /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{34,}/gu,
  /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/_-]{10,}/gu,
];

const KEYWORD = String.raw`(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|passw(?:or)?d|pwd|token|credentials?|auth|session[_-]?id|sessid|cookie)`;

const NAME = String.raw`(?<=^|[^A-Za-z0-9_.\\-]|\\[nrt])(?<name>[A-Za-z0-9_.-]*${KEYWORD}[A-Za-z0-9_.-]*)`;

const QUOTE = String.raw`(?:\\?["'])`;

const VALUE = String.raw`(?<value>[^\s"'\\]*[^\s"'\\,;])`;

const LINE_END = String.raw`(?=[,;]*[ \t]*(?:$|[\r\n]|\\[nr]))`;

function valueRule(label: string, after = ""): RegExp {
  return new RegExp(`(?<label>${label})${VALUE}${after}`, "giu");
}

const URL_USERINFO = valueRule(String.raw`\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@"'\\]*:`, "(?=@)");

const CURL_USER = valueRule(String.raw`(?<![\w-])(?:-u|--user)(?:[ \t]+|=)${QUOTE}?[^\s:"'\\]+:`);

const AUTHORIZATION = valueRule(
  String.raw`(?<![\w-])(?:Proxy-)?Authorization${QUOTE}?[ \t]*[:=][ \t]*${QUOTE}?(?:(?:Bearer|Basic|Token|Digest|Bot|Negotiate)[ \t]+)?`,
);

const COOKIE = /(?<label>(?<![\w-])(?:Set-)?Cookie:[ \t]*)(?<value>[^\r\n"\\]*[^\s"\\])/giu;

const BEARER = /\b(?<label>Bearer\s+)(?<value>[A-Za-z0-9._~+/=-]{12,})/giu;

const ASSIGNED = valueRule(String.raw`${NAME}[ \t]*(?::=|=(?!=))[ \t]*${QUOTE}?`);

const QUOTED_KEY = valueRule(String.raw`${QUOTE}${NAME}${QUOTE}[ \t]*(?::|=(?!=))[ \t]*${QUOTE}?`);

const COLON_QUOTED = valueRule(String.raw`${NAME}:[ \t]+${QUOTE}`);

const COLON_LINE_END = valueRule(String.raw`${NAME}:[ \t]+`, LINE_END);

const FLAG = valueRule(
  String.raw`(?<![A-Za-z0-9_.-])--(?<name>[A-Za-z0-9_.-]*${KEYWORD}[A-Za-z0-9_.-]*)[ \t]+${QUOTE}?(?!-)`,
);

const VALUE_RULES: ReadonlyArray<RegExp> = [
  URL_USERINFO,
  CURL_USER,
  AUTHORIZATION,
  COOKIE,
  BEARER,
  ASSIGNED,
  QUOTED_KEY,
  COLON_QUOTED,
  COLON_LINE_END,
  FLAG,
];

const SAFE_NAME =
  /^[-_.]*(?:max|public|csrf)|author|less$|[_.-](?:url|uri|path|file|dir|name|length|size|count|limit|type|endpoint|version|format)$|(?:secret|key)[_.-]?id$/iu;

const PLACEHOLDER =
  /^(?:<[^<>]*>|\$\{[^}]*\}?|\$[A-Za-z_]\w*|%\w+%|\{\{.*|\*{3,}|x{3,}|\.{3,}|…|\[filtered\]|redacted|null|nil|none|undefined|true|false|example|placeholder|dummy|your[-_].*|process\.env\..*|os\.environ.*|(?:os\.)?getenv\(.*)$/iu;

type ValueMatch = { label: string; value: string; name: string | undefined };

function groupsOf(rest: Array<unknown>): ValueMatch | undefined {
  const groups = rest.at(-1);

  if (
    typeof groups !== "object" ||
    groups === null ||
    !("label" in groups) ||
    !("value" in groups)
  ) {
    return undefined;
  }

  const { label, value } = groups;

  if (typeof label !== "string" || typeof value !== "string") {
    return undefined;
  }

  const name = "name" in groups && typeof groups.name === "string" ? groups.name : undefined;

  return { label, value, name };
}

function keeps(match: ValueMatch): boolean {
  return PLACEHOLDER.test(match.value) || (match.name !== undefined && SAFE_NAME.test(match.name));
}

function redactValues(text: string, pattern: RegExp): string {
  return text.replaceAll(pattern, (whole: string, ...rest: Array<unknown>) => {
    const match = groupsOf(rest);

    return match === undefined || keeps(match) ? whole : `${match.label}${REDACTED}`;
  });
}

export function redact(text: string): string {
  let current = text;

  for (const pattern of TOKENS) {
    current = current.replaceAll(pattern, REDACTED);
  }

  for (const pattern of VALUE_RULES) {
    current = redactValues(current, pattern);
  }

  return current;
}
