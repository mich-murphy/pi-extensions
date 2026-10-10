import { Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import { checkDomainPolicy, DomainDenied, DomainNotAllowed } from "../domain-policy";
import { parsePublicHttpUrl } from "../types";

function publicUrl(input: string) {
  const parsed = parsePublicHttpUrl(input);
  if (Result.isFailure(parsed)) {
    throw new Error("bad test url");
  }
  return parsed.success;
}

describe("checkDomainPolicy", () => {
  test("allows everything when no policy is configured", () => {
    expect(
      checkDomainPolicy(publicUrl("https://anything.example"), { allow: [], deny: [] })._tag,
    ).toBe("Success");
  });

  test("deny entries match subdomains and win over allow", () => {
    const policy = { allow: ["example.com"], deny: ["evil.example.com"] };
    expect(checkDomainPolicy(publicUrl("https://evil.example.com"), policy)._tag).toBe("Failure");
    expect(checkDomainPolicy(publicUrl("https://sub.evil.example.com"), policy)._tag).toBe(
      "Failure",
    );
    expect(checkDomainPolicy(publicUrl("https://docs.example.com"), policy)._tag).toBe("Success");
  });

  test("allow lists match exactly and by subdomain", () => {
    const policy = { allow: ["example.com"], deny: [] };
    expect(checkDomainPolicy(publicUrl("https://example.com"), policy)._tag).toBe("Success");
    expect(checkDomainPolicy(publicUrl("https://docs.example.com"), policy)._tag).toBe("Success");
    expect(checkDomainPolicy(publicUrl("https://notexample.com"), policy)._tag).toBe("Failure");
  });

  test("names the hostname and which list rejected it", () => {
    const denied = checkDomainPolicy(publicUrl("https://evil.example.com/a?b"), {
      allow: [],
      deny: ["evil.example.com"],
    });
    assert(Result.isFailure(denied));
    expect(denied.failure).toBeInstanceOf(DomainDenied);
    expect(denied.failure.message).toBe(
      "Fetching from evil.example.com is denied by the webfetch domain policy",
    );

    const notAllowed = checkDomainPolicy(publicUrl("https://other.example"), {
      allow: ["example.com"],
      deny: [],
    });
    assert(Result.isFailure(notAllowed));
    expect(notAllowed.failure).toBeInstanceOf(DomainNotAllowed);
    expect(notAllowed.failure.message).toBe(
      "Fetching from other.example is not in the webfetch allowed domains list",
    );
  });
});
