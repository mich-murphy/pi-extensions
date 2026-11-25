import type { Credential } from "@earendil-works/pi-ai";
import { Result } from "effect";
import { describe, expect, test, vi } from "vitest";
import { effectiveCredential, WEB_AUTH_PROVIDERS } from "../authentication";
import type { LegacyCredentialReader } from "../authentication";
import { parseSettings } from "../settings";

function settings(environment: Record<string, string>) {
  const parsed = parseSettings(environment);

  if (Result.isFailure(parsed)) {
    throw new Error(parsed.failure.message);
  }

  return parsed.success;
}

const stored = (key: string): Credential => ({ type: "api_key", key });

describe("renamed environment variables", () => {
  test("reads the new names", () => {
    const parsed = settings({
      PI_WEB_PROVIDERS: "brave",
      PI_WEB_FETCH_RESCUE: "off",
      PI_WEB_FETCH_ALLOW_DOMAINS: "example.com",
      PI_WEB_FETCH_DENY_DOMAINS: "bad.example",
    });

    expect(parsed.search.providers).toStrictEqual(["brave"]);
    expect(parsed.fetch.rescue).toBe(false);
    expect(parsed.fetch.allowDomains).toStrictEqual(["example.com"]);
    expect(parsed.fetch.denyDomains).toStrictEqual(["bad.example"]);
  });

  test("falls back to the PI_WEB_TOOLS_ names when the new names are unset", () => {
    const parsed = settings({
      PI_WEB_TOOLS_PROVIDERS: "parallel",
      PI_WEB_TOOLS_EXA_ENDPOINT: "https://exa.example/mcp",
      PI_WEB_TOOLS_PARALLEL_ENDPOINT: "https://parallel.example/mcp",
      PI_WEB_TOOLS_FETCH_RESCUE: "off",
      PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS: "example.com",
      PI_WEB_TOOLS_FETCH_DENY_DOMAINS: "bad.example",
    });

    expect(parsed.search.providers).toStrictEqual(["parallel"]);
    expect(parsed.search.defaultProviders).toBe(false);
    expect(parsed.endpoints.exa).toContain("exa.example");
    expect(parsed.endpoints.parallel).toContain("parallel.example");
    expect(parsed.fetch.rescue).toBe(false);
    expect(parsed.fetch.allowDomains).toStrictEqual(["example.com"]);
    expect(parsed.fetch.denyDomains).toStrictEqual(["bad.example"]);
  });

  test("prefers the new name when both are set", () => {
    const parsed = settings({
      PI_WEB_PROVIDERS: "brave",
      PI_WEB_TOOLS_PROVIDERS: "not-a-provider",
      PI_WEB_FETCH_RESCUE: "on",
      PI_WEB_TOOLS_FETCH_RESCUE: "off",
    });

    expect(parsed.search.providers).toStrictEqual(["brave"]);
    expect(parsed.fetch.rescue).toBe(true);
  });

  test("names the new variable in errors from an old one", () => {
    expect(() => settings({ PI_WEB_TOOLS_PROVIDERS: "nope" })).toThrow("PI_WEB_PROVIDERS");
  });
});

describe("legacy stored credentials", () => {
  test("keeps each old provider id as the fallback for its new id", () => {
    expect(
      Object.values(WEB_AUTH_PROVIDERS).map(({ id, legacyId }) => [id, legacyId]),
    ).toStrictEqual([
      ["pi-web-exa", "pi-web-tools-exa"],
      ["pi-web-parallel", "pi-web-tools-parallel"],
      ["pi-web-brave", "pi-web-tools-brave"],
    ]);
  });

  test("uses the key stored under the new id when both ids have one", () => {
    const read = vi.fn<LegacyCredentialReader>().mockReturnValue(stored("old"));
    expect(
      effectiveCredential({ type: "api_key", key: "new" }, "pi-web-tools-exa", read),
    ).toStrictEqual({ type: "api_key", key: "new" });
    expect(read).not.toHaveBeenCalled();
  });

  test("falls back to a literal key stored under the old id", () => {
    const read = vi.fn<LegacyCredentialReader>().mockReturnValue(stored(" old "));
    expect(effectiveCredential(undefined, "pi-web-tools-exa", read)).toStrictEqual({
      type: "api_key",
      key: "old",
    });
    expect(read).toHaveBeenCalledWith("pi-web-tools-exa");
  });

  test("finds nothing when neither id has a key", () => {
    expect(effectiveCredential(undefined, "pi-web-tools-exa", () => undefined)).toBeUndefined();
  });

  test("ignores an old OAuth credential", () => {
    const oauth: Credential = { type: "oauth", access: "a", refresh: "r", expires: 0 };
    expect(effectiveCredential(undefined, "pi-web-tools-exa", () => oauth)).toBeUndefined();
  });

  test.each(["!op read exa", "$EXA_SECRET"])("ignores an old key Pi would resolve: %s", (key) => {
    expect(effectiveCredential(undefined, "pi-web-tools-exa", () => stored(key))).toBeUndefined();
  });
});
