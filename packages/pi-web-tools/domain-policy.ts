import { err, ok } from "./result";
import type { Result } from "./result";
import type { PublicHttpUrl } from "./types";

/** Hostname allow/deny policy for webfetch. */
export type DomainPolicy = {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
};

/** Expected failures of the domain policy check. */
export type DomainPolicyError =
  | { readonly _tag: "DomainDenied"; readonly hostname: string }
  | { readonly _tag: "DomainNotAllowed"; readonly hostname: string };

/**
 * Enforce the configured hostname policy before any network or DNS work.
 * An entry matches the hostname exactly or any subdomain of it. Deny wins over allow.
 */
export function checkDomainPolicy(
  url: PublicHttpUrl,
  policy: DomainPolicy,
): Result<void, DomainPolicyError> {
  const hostname = new URL(url).hostname.toLowerCase();

  if (policy.deny.some((entry) => matchesDomainEntry(hostname, entry))) {
    return err({ _tag: "DomainDenied", hostname });
  }
  if (
    policy.allow.length > 0 &&
    !policy.allow.some((entry) => matchesDomainEntry(hostname, entry))
  ) {
    return err({ _tag: "DomainNotAllowed", hostname });
  }
  return ok(undefined);
}

function matchesDomainEntry(hostname: string, entry: string): boolean {
  return hostname === entry || hostname.endsWith(`.${entry}`);
}
