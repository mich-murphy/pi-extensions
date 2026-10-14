import { Result } from "effect";
import { assert, describe, expect, test } from "vitest";
import {
  BRAVE_API_KEY_ENV,
  EXA_API_KEY_ENV,
  InvalidSetting,
  EXA_ENDPOINT_ENV,
  FETCH_RESCUE_ENV,
  PROVIDERS_ENV,
  parseSettings,
} from "../settings";

describe("parseSettings", () => {
  test("defaults to exa then parallel with keyless MCP", () => {
    const settings = parseSettings({});
    assert(Result.isSuccess(settings));
    expect(settings.success.search.providers).toStrictEqual(["exa", "parallel"]);
    expect(settings.success.search.defaultProviders).toBe(true);
    expect(settings.success.fetch.rescue).toBe(true);
    expect(settings.success.fetch.allowDomains).toStrictEqual([]);
  });

  test("does not read keys or append Brave during static parsing", () => {
    const settings = parseSettings({ [BRAVE_API_KEY_ENV]: "BSA_test" });
    assert(Result.isSuccess(settings));
    expect(settings.success.search.providers).toStrictEqual(["exa", "parallel"]);
  });

  test("honors explicit provider ordering and filtering", () => {
    const settings = parseSettings({
      [PROVIDERS_ENV]: "parallel, exa",
      [EXA_API_KEY_ENV]: "exa-key",
    });
    assert(Result.isSuccess(settings));
    expect(settings.success.search.providers).toStrictEqual(["parallel", "exa"]);
    expect(settings.success.search.defaultProviders).toBe(false);
    expect(JSON.stringify(settings.success)).not.toContain("exa-key");
  });

  test("deduplicates repeated providers, keeping first-mention order", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: "parallel,exa,parallel" });
    assert(Result.isSuccess(settings));
    expect(settings.success.search.providers).toStrictEqual(["parallel", "exa"]);
  });

  test("rejects unknown providers fail-closed", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: "exa,google" });
    assert(Result.isFailure(settings));
    expect(settings.failure).toBeInstanceOf(InvalidSetting);
    expect(settings.failure.message).toContain("unknown provider");
  });

  test("rejects an empty provider list", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: " , " });
    expect(settings._tag).toBe("Failure");
  });

  test("accepts explicit Brave without inspecting credentials", () => {
    const settings = parseSettings({
      [PROVIDERS_ENV]: "exa,brave",
      [EXA_API_KEY_ENV]: "exa-\nkey",
    });
    assert(Result.isSuccess(settings));
    expect(settings.success.search.providers).toStrictEqual(["exa", "brave"]);
    expect(settings.success.search.defaultProviders).toBe(false);
    expect(JSON.stringify(settings.success)).not.toContain("key");
  });

  test("blank provider configuration retains the default chain", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: "  " });
    assert(Result.isSuccess(settings));
    expect(settings.success.search.defaultProviders).toBe(true);
  });

  test("parses the fetch rescue toggle", () => {
    const off = parseSettings({ [FETCH_RESCUE_ENV]: "off" });
    assert(Result.isSuccess(off));
    expect(off.success.fetch.rescue).toBe(false);
  });

  test("validates endpoint overrides as public URLs", () => {
    const bad = parseSettings({ [EXA_ENDPOINT_ENV]: "file:///etc/passwd" });
    expect(bad._tag).toBe("Failure");

    const good = parseSettings({ [EXA_ENDPOINT_ENV]: "https://search.internal.example/mcp" });
    assert(Result.isSuccess(good));
    expect(good.success.endpoints.exa).toBe("https://search.internal.example/mcp");
  });

  test("parses domain allow and deny lists", () => {
    const settings = parseSettings({
      PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS: "docs.example.com, Example.org , example.org",
      PI_WEB_TOOLS_FETCH_DENY_DOMAINS: "evil.example",
    });
    assert(Result.isSuccess(settings));
    expect(settings.success.fetch.allowDomains).toStrictEqual(["docs.example.com", "example.org"]);
    expect(settings.success.fetch.denyDomains).toStrictEqual(["evil.example"]);
  });
});
