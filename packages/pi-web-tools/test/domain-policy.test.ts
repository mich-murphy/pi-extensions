import { describe, expect, test } from "vitest";
import { checkDomainPolicy } from "../domain-policy";
import { parsePublicHttpUrl } from "../types";

function publicUrl(input: string) {
  const parsed = parsePublicHttpUrl(input);
  if (parsed._tag !== "ok") {
    throw new Error("bad test url");
  }
  return parsed.value;
}

describe("checkDomainPolicy", () => {
  test("allows everything when no policy is configured", () => {
    expect(
      checkDomainPolicy(publicUrl("https://anything.example"), { allow: [], deny: [] })._tag,
    ).toBe("ok");
  });

  test("deny entries match subdomains and win over allow", () => {
    const policy = { allow: ["example.com"], deny: ["evil.example.com"] };
    expect(checkDomainPolicy(publicUrl("https://evil.example.com"), policy)._tag).toBe("err");
    expect(checkDomainPolicy(publicUrl("https://sub.evil.example.com"), policy)._tag).toBe("err");
    expect(checkDomainPolicy(publicUrl("https://docs.example.com"), policy)._tag).toBe("ok");
  });

  test("allow lists match exactly and by subdomain", () => {
    const policy = { allow: ["example.com"], deny: [] };
    expect(checkDomainPolicy(publicUrl("https://example.com"), policy)._tag).toBe("ok");
    expect(checkDomainPolicy(publicUrl("https://docs.example.com"), policy)._tag).toBe("ok");
    expect(checkDomainPolicy(publicUrl("https://notexample.com"), policy)._tag).toBe("err");
  });
});
