import { Data, Result } from "effect";
import type { PublicHttpUrl } from "./types";

/** Hostname allow/deny policy for webfetch. */
export type DomainPolicy = {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
};

/** The hostname matches a webfetch deny-list entry. */
export class DomainDenied extends Data.TaggedError("DomainDenied")<{
  readonly hostname: string;
}> {
  /** Safe user-facing description naming only the hostname. */
  override get message(): string {
    return `Fetching from ${this.hostname} is denied by the webfetch domain policy`;
  }
}

/** An allow list is configured and the hostname matches none of its entries. */
export class DomainNotAllowed extends Data.TaggedError("DomainNotAllowed")<{
  readonly hostname: string;
}> {
  /** Safe user-facing description naming only the hostname. */
  override get message(): string {
    return `Fetching from ${this.hostname} is not in the webfetch allowed domains list`;
  }
}

/** Expected failures of the domain policy check. */
export type DomainPolicyError = DomainDenied | DomainNotAllowed;

/**
 * Enforce the configured hostname policy before any network or DNS work.
 * An entry matches the hostname exactly or any subdomain of it. Deny wins over allow.
 */
export function checkDomainPolicy(
  url: PublicHttpUrl,
  policy: DomainPolicy,
): Result.Result<void, DomainPolicyError> {
  const hostname = new URL(url).hostname.toLowerCase();

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
