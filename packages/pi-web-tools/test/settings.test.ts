import { assert, describe, expect, test } from "vitest";
import {
  BRAVE_API_KEY_ENV,
  clampInteger,
  EXA_API_KEY_ENV,
  EXA_ENDPOINT_ENV,
  FETCH_RESCUE_ENV,
  PARALLEL_API_KEY_ENV,
  PROVIDERS_ENV,
  parseDomainList,
  parseOnOff,
  parseSettings,
} from "../settings";

describe("parseSettings", () => {
  test("defaults to exa then parallel with keyless MCP", () => {
    const settings = parseSettings({});
    assert(settings._tag === "ok");
    expect(settings.value.search.providers).toStrictEqual(["exa", "parallel"]);
    expect(settings.value.credentials.exaApiKey).toBeUndefined();
    expect(settings.value.fetch.rescue).toBe(true);
    expect(settings.value.fetch.allowDomains).toStrictEqual([]);
  });

  test("appends brave to the default chain when keyed", () => {
    const settings = parseSettings({ [BRAVE_API_KEY_ENV]: "BSA_test" });
    assert(settings._tag === "ok");
    expect(settings.value.search.providers).toStrictEqual(["exa", "parallel", "brave"]);
  });

  test("honors explicit provider ordering and filtering", () => {
    const settings = parseSettings({
      [PROVIDERS_ENV]: "parallel, exa",
      [EXA_API_KEY_ENV]: "exa-key",
    });
    assert(settings._tag === "ok");
    expect(settings.value.search.providers).toStrictEqual(["parallel", "exa"]);
    expect(settings.value.credentials.exaApiKey).toBe("exa-key");
  });

  test("deduplicates repeated providers", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: "exa,exa,parallel" });
    assert(settings._tag === "ok");
    expect(settings.value.search.providers).toStrictEqual(["exa", "parallel"]);
  });

  test("keeps first-mention order when deduplicating", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: "parallel,exa,parallel" });
    assert(settings._tag === "ok");
    expect(settings.value.search.providers).toStrictEqual(["parallel", "exa"]);
  });

  test("rejects unknown providers fail-closed", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: "exa,google" });
    assert(settings._tag === "err");
    expect(settings.error.message).toContain("unknown provider");
  });

  test("rejects an empty provider list", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: " , " });
    expect(settings._tag).toBe("err");
  });

  test("rejects brave without a key when explicitly listed", () => {
    const settings = parseSettings({ [PROVIDERS_ENV]: "exa,brave" });
    assert(settings._tag === "err");
    expect(settings.error.message).toContain(BRAVE_API_KEY_ENV);
  });

  test("rejects API keys containing control characters", () => {
    const settings = parseSettings({ [EXA_API_KEY_ENV]: "exa-\nkey" });
    assert(settings._tag === "err");
    expect(settings.error.message).toContain("control characters");
  });

  test("treats empty API keys as unset", () => {
    const settings = parseSettings({ [PARALLEL_API_KEY_ENV]: "   " });
    assert(settings._tag === "ok");
    expect(settings.value.credentials.parallelApiKey).toBeUndefined();
  });

  test("parses the fetch rescue toggle", () => {
    const off = parseSettings({ [FETCH_RESCUE_ENV]: "off" });
    assert(off._tag === "ok");
    expect(off.value.fetch.rescue).toBe(false);
  });

  test("validates endpoint overrides as public URLs", () => {
    const bad = parseSettings({ [EXA_ENDPOINT_ENV]: "file:///etc/passwd" });
    expect(bad._tag).toBe("err");

    const good = parseSettings({ [EXA_ENDPOINT_ENV]: "https://search.internal.example/mcp" });
    assert(good._tag === "ok");
    expect(good.value.endpoints.exa).toBe("https://search.internal.example/mcp");
  });

  test("parses domain allow and deny lists", () => {
    const settings = parseSettings({
      PI_WEB_TOOLS_FETCH_ALLOW_DOMAINS: "docs.example.com, Example.org ",
      PI_WEB_TOOLS_FETCH_DENY_DOMAINS: "evil.example",
    });
    assert(settings._tag === "ok");
    expect(settings.value.fetch.allowDomains).toStrictEqual(["docs.example.com", "example.org"]);
    expect(settings.value.fetch.denyDomains).toStrictEqual(["evil.example"]);
  });
});

describe("parseOnOff", () => {
  test("parses on and off, falling back otherwise", () => {
    expect(parseOnOff("on", false)).toBe(true);
    expect(parseOnOff("off", true)).toBe(false);
    expect(parseOnOff("maybe", true)).toBe(true);
    expect(parseOnOff(undefined, false)).toBe(false);
  });
});

describe("clampInteger", () => {
  const bounds = { default: 8, min: 1, max: 20 };

  test("rounds into the inclusive bounds", () => {
    expect(clampInteger(4.4, bounds)).toBe(4);
    expect(clampInteger(-3, bounds)).toBe(1);
    expect(clampInteger(100, bounds)).toBe(20);
  });

  test("falls back to the default for non-finite input", () => {
    expect(clampInteger(Number.NaN, bounds)).toBe(8);
    expect(clampInteger(Number.POSITIVE_INFINITY, bounds)).toBe(8);
  });
});

describe("parseDomainList", () => {
  test("normalizes and deduplicates", () => {
    expect(parseDomainList("A.com, a.com, b.org")).toStrictEqual(["a.com", "b.org"]);
    expect(parseDomainList(undefined)).toStrictEqual([]);
  });
});
