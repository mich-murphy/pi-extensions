import { describe, expect, test } from "vitest";
import { MessageAliases } from "../adapter/aliases.js";

describe("MessageAliases", () => {
  test("an alias is a stable 4-hex prefix that resolves back to the id", () => {
    const aliases = new MessageAliases();
    const id = "3f2a".padEnd(32, "0");
    expect(aliases.alias(id)).toBe("m-3f2a");
    expect(aliases.alias(id)).toBe("m-3f2a");
    expect(aliases.resolve("m-3f2a")).toBe(id);
  });
  test("a colliding prefix grows, and both ids keep resolving", () => {
    const aliases = new MessageAliases();
    const first = "abcd".padEnd(32, "1");
    const second = "abcd".padEnd(32, "2");
    expect(aliases.alias(first)).toBe("m-abcd");
    expect(aliases.alias(second)).toBe("m-abcd22");
    expect(aliases.resolve("m-abcd")).toBe(first);
    expect(aliases.resolve("m-abcd22")).toBe(second);
  });
  test("a full 32-hex id resolves to itself; unknown aliases and junk do not", () => {
    const aliases = new MessageAliases();
    expect(aliases.resolve("e".repeat(32))).toBe("e".repeat(32));
    expect(aliases.resolve("m-ffff")).toBeUndefined();
    expect(aliases.resolve("not-an-id")).toBeUndefined();
  });
  test("an evicted alias is retired: never reassigned to another id", () => {
    const aliases = new MessageAliases(1);
    const old = "1234".padEnd(32, "a");
    const next = "1234".padEnd(32, "b");
    expect(aliases.alias(old)).toBe("m-1234");
    aliases.alias("9".repeat(32));
    expect(aliases.resolve("m-1234")).toBeUndefined();
    expect(aliases.alias(next)).toBe("m-1234bb");
    expect(aliases.resolve("m-1234")).toBeUndefined();
  });
});
