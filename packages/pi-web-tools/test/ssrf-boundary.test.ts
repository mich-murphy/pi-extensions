import { afterEach, describe, expect, test } from "vitest";
import type { ApprovedAddress, PublicWebTransport } from "../public-web-transport";
import { createWebFetchTool } from "../webfetch";
import {
  fetchPageWith,
  publicWebClientOverTransport,
  settingsFrom,
  textOf,
  toolRuntimeWith,
} from "./fakes";

/**
 * The real webfetch tool over the real FetchPage and PublicWebClient. Only the two network edges
 * are faked: the resolver and the address-bound transport, which record what the client did.
 */

const PUBLIC_V4: ApprovedAddress = { address: "93.184.216.34", family: 4 };
const PAGE = `<html><body><article><p>${"Public page text. ".repeat(20)}</p></article></body></html>`;

type Dns = (hostname: string, call: number) => readonly ApprovedAddress[];

const toDispose: { dispose: () => Promise<void> }[] = [];

const LOOPBACK: readonly ApprovedAddress[] = [{ address: "127.0.0.1", family: 4 }];

/** Answer by host name; any host not listed resolves to a public address. */
function answerBy(table: Readonly<Record<string, readonly ApprovedAddress[]>>): Dns {
  return (hostname) => table[hostname] ?? [PUBLIC_V4];
}

/** A resolver that answers public on its first lookup and loopback on every later one. */
const rebinding: Dns = (_hostname, call) => (call === 1 ? [PUBLIC_V4] : LOOPBACK);

const html = () => new Response(PAGE, { headers: { "content-type": "text/html" } });

/** Redirect requests for one host to `location`; every other host serves the page. */
function redirectFrom(host: string, status: number, location: string) {
  return (url: URL) =>
    url.hostname === host ? new Response(null, { status, headers: { location } }) : html();
}

function harness(
  options: {
    readonly dns?: Dns;
    readonly respond?: (url: URL) => Response;
  } = {},
) {
  const lookups: string[] = [];
  const connections: { readonly url: string; readonly addresses: readonly ApprovedAddress[] }[] =
    [];
  const transport: PublicWebTransport["Service"] = {
    get: async (url, addresses) => {
      connections.push({ url: url.toString(), addresses });
      return (options.respond ?? html)(url);
    },
  };
  const client = publicWebClientOverTransport({
    transport,
    lookup: async (hostname) => {
      lookups.push(hostname);
      return (options.dns ?? (() => [PUBLIC_V4]))(hostname, lookups.length);
    },
  });
  const settings = settingsFrom();
  const runtime = toolRuntimeWith({ settings, fetchPage: fetchPageWith(client) });
  toDispose.push(runtime);
  const tool = createWebFetchTool({ settings, runtime, redactText: (input) => input });
  return { tool, lookups, connections };
}

describe("webfetch SSRF boundary", () => {
  afterEach(async () => {
    await Promise.all(toDispose.splice(0).map(async (runtime) => runtime.dispose()));
  });

  describe("webfetch refuses private targets", () => {
    test.each([
      "http://127.0.0.1:8080/admin",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fd00::1]/",
      "http://localhost/",
      "http://api.localhost/",
    ])("%s", async (url) => {
      const { tool, lookups, connections } = harness();
      await expect(tool.execute("t1", { url })).rejects.toThrow(/^Blocked private or local/u);
      expect(connections).toStrictEqual([]);
      expect(lookups).toStrictEqual([]);
    });

    test.each([
      ["decimal", "http://2130706433/"],
      ["hex integer", "http://0x7f000001/"],
      ["octal integer", "http://017700000001/"],
      ["octal dotted", "http://0177.0.0.1/"],
      ["hex dotted", "http://0x7f.0.0.1/"],
      ["short two-part", "http://127.1/"],
      ["short three-part", "http://127.0.1/"],
      ["zero", "http://0/"],
      ["decimal link-local metadata", "http://2852039166/"],
    ])("numeric IPv4 spelling: %s", async (_name, url) => {
      const { tool, lookups, connections } = harness();
      await expect(tool.execute("t1", { url })).rejects.toThrow("Blocked private or local IP");
      expect(connections).toStrictEqual([]);
      expect(lookups).toStrictEqual([]);
    });

    test.each(["http://localhost./", "http://api.localhost./"])(
      "trailing-dot localhost name %s never reaches the transport",
      async (url) => {
        // A system resolver answers these with loopback; the address check must still refuse them.
        const { tool, connections } = harness({ dns: () => LOOPBACK });
        await expect(tool.execute("t1", { url })).rejects.toThrow(/^Blocked private or local/u);
        expect(connections).toStrictEqual([]);
      },
    );

    test.each([
      ["only a private answer", [{ address: "10.0.0.1", family: 4 }]],
      ["a private address among public ones", [PUBLIC_V4, { address: "192.168.0.9", family: 4 }]],
      ["a private IPv6 answer", [{ address: "fe80::1", family: 6 }]],
    ] as const)("a public-looking name resolving to %s", async (_name, answer) => {
      const { tool, connections } = harness({ dns: () => answer });
      await expect(tool.execute("t1", { url: "http://internal.example/" })).rejects.toThrow(
        "Blocked private or local IP",
      );
      expect(connections).toStrictEqual([]);
    });

    test("a redirect to a name that resolves privately is refused after the first hop", async () => {
      const { tool, connections } = harness({
        dns: answerBy({ "internal.example": LOOPBACK }),
        respond: redirectFrom("front.example", 302, "http://internal.example/"),
      });
      await expect(tool.execute("t1", { url: "http://front.example/" })).rejects.toThrow(
        "Blocked private or local IP",
      );
      expect(connections.map((connection) => connection.url)).toStrictEqual([
        "http://front.example/",
      ]);
    });
  });

  describe("webfetch pins the connection to the validated addresses", () => {
    test("connects to exactly the addresses it approved, in resolver order", async () => {
      const answer: readonly ApprovedAddress[] = [
        PUBLIC_V4,
        { address: "2606:2800:220:1::1", family: 6 },
      ];
      const { tool, lookups, connections } = harness({ dns: () => answer });
      const result = await tool.execute("t1", { url: "http://example.com/page" });
      expect(textOf(result)).toContain("Public page text.");
      expect(lookups).toStrictEqual(["example.com"]);
      expect(connections).toStrictEqual([{ url: "http://example.com/page", addresses: answer }]);
    });

    test("a rebinding resolver cannot change the target: one lookup per hop, and its answer is used", async () => {
      const { tool, lookups, connections } = harness({ dns: rebinding });
      await tool.execute("t1", { url: "http://rebind.example/" });
      expect(lookups).toStrictEqual(["rebind.example"]);
      expect(connections.map((connection) => connection.addresses)).toStrictEqual([[PUBLIC_V4]]);
    });

    test("every redirect hop validates and pins its own addresses", async () => {
      const second: readonly ApprovedAddress[] = [{ address: "151.101.1.69", family: 4 }];
      const { tool, lookups, connections } = harness({
        dns: answerBy({ "b.example": second }),
        respond: redirectFrom("a.example", 301, "http://b.example/final"),
      });
      await tool.execute("t1", { url: "http://a.example/" });
      expect(lookups).toStrictEqual(["a.example", "b.example"]);
      expect(connections).toStrictEqual([
        { url: "http://a.example/", addresses: [PUBLIC_V4] },
        { url: "http://b.example/final", addresses: second },
      ]);
    });

    test("a bracketed public IPv6 literal is pinned to itself without a DNS lookup", async () => {
      const { tool, lookups, connections } = harness();
      await tool.execute("t1", { url: "http://[2001:4860:4860::8888]/" });
      expect(lookups).toStrictEqual([]);
      expect(connections.map((connection) => connection.addresses)).toStrictEqual([
        [{ address: "2001:4860:4860::8888", family: 6 }],
      ]);
    });
  });
});
