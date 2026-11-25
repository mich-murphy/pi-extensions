import { Result, Schema } from "effect";
import type { PublicHttpUrl } from "./types";

export type DomainPolicy = {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
};

export class DomainDenied extends Schema.TaggedError<DomainDenied>()("DomainDenied", {
  hostname: Schema.String,
}) {
  override get message(): string {
    return `Fetching from ${this.hostname} is denied by the webfetch domain policy (\`PI_WEB_FETCH_DENY_DOMAINS\`).`;
  }
}

export class DomainNotAllowed extends Schema.TaggedError<DomainNotAllowed>()("DomainNotAllowed", {
  hostname: Schema.String,
}) {
  override get message(): string {
    return `Fetching from ${this.hostname} is not in the webfetch allowed domains list (\`PI_WEB_FETCH_ALLOW_DOMAINS\`).`;
  }
}

export type DomainPolicyError = DomainDenied | DomainNotAllowed;

export function checkDomainPolicy(
  url: PublicHttpUrl | URL,
  policy: DomainPolicy,
): Result.Result<void, DomainPolicyError> {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/u, "");

  if (policy.deny.some((entry) => matchesDomainEntry(hostname, entry))) {
    return Result.fail(new DomainDenied({ hostname }));
  }

  if (
    policy.allow.length > 0 &&
    !policy.allow.some((entry) => matchesDomainEntry(hostname, entry))
  ) {
    return Result.fail(new DomainNotAllowed({ hostname }));
  }

  return Result.succeed(undefined);
}

function matchesDomainEntry(hostname: string, entry: string): boolean {
  return hostname === entry || hostname.endsWith(`.${entry}`);
}
