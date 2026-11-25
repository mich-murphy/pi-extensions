import { describe, expect, test } from "vitest";
import { REDACTED, redact } from "../redact.ts";

describe("redact", () => {
  test.each([
    ["an Anthropic key", `key sk-ant-${"a".repeat(32)} end`, `key ${REDACTED} end`],
    ["a GitHub token", `ghp_${"b".repeat(36)}`, REDACTED],
    ["a fine-grained GitHub token", `github_pat_${"c".repeat(40)}`, REDACTED],
    ["a Slack token", "xoxb-1234567890-abcdef", REDACTED],
    ["an AWS access key", "AKIAABCDEFGHIJKLMNOP", REDACTED],
    ["a JWT", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", REDACTED],
  ])("removes %s", (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  test("keeps the label of a bearer header", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  test("keeps the name of an assigned secret", () => {
    expect(redact('TYPESAFE_API_KEY="0123456789abcdef" next')).toBe(
      `TYPESAFE_API_KEY="${REDACTED}" next`,
    );
  });

  test("removes a private key block", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(`before ${key} after`)).toBe(`before ${REDACTED} after`);
  });

  test("leaves ordinary error text alone", () => {
    const text = "ENOENT: no such file or directory, access '/tmp/x/token.txt'";
    expect(redact(text)).toBe(text);
  });
});
