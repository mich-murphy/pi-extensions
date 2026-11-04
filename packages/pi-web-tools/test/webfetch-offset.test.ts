import { Effect, Result } from "effect";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import type { FetchPageResult } from "../fetch-page";
import {
  projectFetchResult,
  projectProviderFetchedPage,
  STRUCTURED_OUTPUT_MAX_BYTES,
  WEB_FETCH_OUTPUT_SCHEMA,
} from "../tool-output";
import { createWebFetchTool } from "../webfetch";
import {
  UTF8,
  fakePublicWeb,
  fetchPageWith,
  liveToolOutputStore,
  publicUrl,
  redactorFor,
  settingsFrom,
  textOf,
  textWebResponse,
  toolRuntimeWith,
} from "./fakes";

const CAP = 10 * 1024 * 1024;
const END_NOTE =
  "Content stops at the 10.0MB download limit; the rest of the page cannot be fetched.";
const TRUNCATION_MARK = "\n\n[Output truncated";

function textResult(text: string): FetchPageResult {
  return {
    meta: {
      requestedUrl: publicUrl("https://example.com"),
      finalUrl: publicUrl("https://example.com/final"),
      format: "markdown",
      status: 200,
      mime: "text/plain",
      contentType: "text/plain; charset=utf-8",
      charset: UTF8,
      bytes: Buffer.byteLength(text),
    },
    body: { _tag: "Text", kind: "text", text, decoder: UTF8 },
  };
}

async function project(
  text: string,
  offset?: number,
  secrets: readonly string[] = [],
  responseTruncated = false,
) {
  const page = textResult(text);
  return Effect.runPromise(
    projectFetchResult(
      responseTruncated
        ? { ...page, meta: { ...page.meta, bytes: CAP, responseTruncated: true } }
        : page,
      {
        store: liveToolOutputStore(),
        secrets,
        ...(offset === undefined ? {} : { offset }),
      },
    ),
  );
}

type Window = { readonly offset: number; readonly shown: string; readonly next?: number };

async function readWindow(text: string, offset: number): Promise<Window> {
  const shownText = textOf(await project(text, offset));
  const cut = shownText.indexOf(TRUNCATION_MARK);
  if (cut === -1) {
    const footer = shownText.lastIndexOf("\n\n[Showing");
    return { offset, shown: offset > 0 ? shownText.slice(0, footer) : shownText };
  }
  const next = Number(/offset=(?<next>\d+) to continue\.\]$/u.exec(shownText)?.groups?.next);
  return { offset, shown: shownText.slice(0, cut), next };
}

async function readAllWindows(text: string): Promise<Window[]> {
  const windows: Window[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const window = await readWindow(text, offset);
    windows.push(window);
    offset = window.next;
  }
  return windows;
}

/** A window is exact when it is the bytes at its offset and the next one skips at most a newline. */
function windowIsExact(full: Buffer, window: Window): boolean {
  const end = window.offset + Buffer.byteLength(window.shown);
  const exact = full.subarray(window.offset, end).toString("utf8") === window.shown;
  if (window.next === undefined) {
    return exact && end === full.length;
  }
  const skipped = full.subarray(end, window.next).toString("utf8");
  return exact && (skipped === "" || skipped === "\n") && window.next > window.offset;
}

async function pageThrough(
  text: string,
): Promise<{ readonly ok: boolean; readonly count: number }> {
  const full = Buffer.from(text, "utf8");
  const windows = await readAllWindows(text);
  return { ok: windows.every((window) => windowIsExact(full, window)), count: windows.length };
}

describe("webfetch offset paging", () => {
  test("continues with no gap or overlap across multi-line windows (line limit)", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i} é`).join("\n");
    const paged = await pageThrough(text);
    expect(paged.ok).toBe(true);
    expect(paged.count).toBeGreaterThan(2);
  });

  test("continues with no gap or overlap across multi-line windows (byte limit)", async () => {
    const text = Array.from({ length: 600 }, (_, i) => `${i} ${"€".repeat(100)}`).join("\n");
    const paged = await pageThrough(text);
    expect(paged.ok).toBe(true);
    expect(paged.count).toBeGreaterThan(2);
  });

  test("continues with no gap or overlap through one long line", async () => {
    const paged = await pageThrough("€".repeat(60_000));
    expect(paged.ok).toBe(true);
    expect(paged.count).toBeGreaterThan(2);
  });

  test("names the window and the next offset in the notice", async () => {
    const text = "€".repeat(60_000);
    const first = textOf(await project(text));
    expect(first).toMatch(
      / Showing bytes 0–51198 of 180000\. Full output saved to: \S+\. Call webfetch again with offset=51198 to continue\.\]$/u,
    );
    const second = textOf(await project(text, 51_198));
    expect(second).toContain("Showing bytes 51198–102396 of 180000.");
    expect(second.endsWith("offset=102396 to continue.]")).toBe(true);
  });

  test("the last window has no continuation notice", async () => {
    const text = `${"a".repeat(100)}\nend`;
    const result = textOf(await project(text, 50));
    expect(result).toBe(`${"a".repeat(50)}\nend\n\n[Showing bytes 50–104 of 104]`);
  });

  test("moves an offset inside a character to the next boundary and reports it", async () => {
    const result = await project("€abc", 1);
    expect(textOf(result)).toBe("abc\n\n[Showing bytes 3–6 of 6]");
    expect(result.structuredContent).toMatchObject({ content: "abc", offset: 3 });
  });

  test("offsets at or past the end succeed with an empty window", async () => {
    for (const offset of [3, 99]) {
      const result = await project("abc", offset);
      expect(textOf(result)).toBe(`[offset ${offset} is at or past the end of the content (3)]`);
      expect(result.details.truncated).toBe(false);
      expect(result.structuredContent).toMatchObject({ content: "", truncated: false, offset });
      expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
    }
  });

  test("offset 0 and an omitted offset give identical results", async () => {
    const small = { text: "small page" };
    await expect(project(small.text, 0)).resolves.toStrictEqual(await project(small.text));
    const large = "line\n".repeat(30_000);
    const withPath = async (offset?: number) => {
      const result = await project(large, offset);
      const path = String(result.details.fullOutputPath);
      return JSON.parse(JSON.stringify(result).replaceAll(path, "PATH")) as unknown;
    };
    await expect(withPath(0)).resolves.toStrictEqual(await withPath());
    expect(JSON.stringify(await project(large))).not.toContain('"offset"');
  });

  test("structured content is a 1 MiB window from the offset with next_offset", async () => {
    const text = "a".repeat(STRUCTURED_OUTPUT_MAX_BYTES + 100);
    const firstResult = await project(text);
    const first = firstResult.structuredContent;
    expect(first).toMatchObject({ truncated: true, next_offset: STRUCTURED_OUTPUT_MAX_BYTES });
    expect(first).not.toHaveProperty("offset");
    const restResult = await project(text, STRUCTURED_OUTPUT_MAX_BYTES);
    const rest = restResult.structuredContent;
    expect(rest).toMatchObject({
      content: "a".repeat(100),
      truncated: false,
      offset: STRUCTURED_OUTPUT_MAX_BYTES,
    });
    expect(rest).not.toHaveProperty("next_offset");
    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, first)).toBe(true);
    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, rest)).toBe(true);
  });

  test("the spill file still holds the full converted text", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = "line\n".repeat(30_000);
    const result = await project(text, 100);
    const path = result.details.fullOutputPath;
    expect(typeof path).toBe("string");
    await expect(readFile(String(path), "utf8")).resolves.toBe(text);
  });

  test("redacts secrets in windows and counts offsets in redacted text", async () => {
    const result = await project(`SECRET${"x".repeat(60_000)}`, 20, ["SECRET"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(textOf(result)).toContain("Showing bytes 20–");
    expect(textOf(result)).toContain("of 60010.");
  });

  test("ignores the offset for images", async () => {
    const image: FetchPageResult = {
      meta: {
        requestedUrl: publicUrl("https://example.com/i.png"),
        finalUrl: publicUrl("https://example.com/i.png"),
        format: "markdown",
        status: 200,
        mime: "image/png",
        contentType: "image/png",
        bytes: 4,
      },
      body: { _tag: "Image", data: Buffer.from([1, 2, 3, 4]) },
    };
    const options = { store: liveToolOutputStore(), secrets: [] };
    await expect(
      Effect.runPromise(projectFetchResult(image, { ...options, offset: 99 })),
    ).resolves.toStrictEqual(await Effect.runPromise(projectFetchResult(image, options)));
  });

  test("provider-rescued pages page the markdown after the note", async () => {
    const markdown = "m".repeat(60_000);
    const page = { provider: "exa", url: publicUrl("https://blocked.example"), markdown };
    const options = { store: liveToolOutputStore(), secrets: [] };
    const first = textOf(await Effect.runPromise(projectProviderFetchedPage(page, options)));
    expect(first).toMatch(/^\[Direct fetch was blocked/u);
    expect(first).toContain("offset=51200 to continue.]");
    const second = await Effect.runPromise(
      projectProviderFetchedPage(page, { ...options, offset: 51_200 }),
    );
    expect(textOf(second)).toMatch(
      /^\[Direct fetch was blocked.*\n\nm{8800}\n\n\[Showing bytes 51200–60000 of 60000\]$/su,
    );
    expect(second.structuredContent).toMatchObject({ content: "m".repeat(8800), offset: 51_200 });
  });
});

describe("webfetch tool offset parameter", () => {
  const SECRET = "sekrit-key";
  const settings = settingsFrom({ EXA_API_KEY: SECRET });
  const tool = (text: string) =>
    createWebFetchTool({
      settings,
      redactText: redactorFor(SECRET),
      runtime: toolRuntimeWith({
        settings,
        secret: SECRET,
        fetchPage: fetchPageWith(
          fakePublicWeb(Result.succeed(textWebResponse(text, "text/plain"))).client,
        ),
        fetchProviders: [],
      }),
    });

  test("accepts non-negative integers only", () => {
    const { parameters } = tool("x");
    const check = (offset: unknown) =>
      Value.Check(parameters, { url: "https://example.com", offset });
    expect(check(0)).toBe(true);
    expect(check(1234)).toBe(true);
    expect(check(-1)).toBe(false);
    expect(check(1.5)).toBe(false);
    expect(check("3")).toBe(false);
  });

  test("pages through execute and re-fetches on every call", async () => {
    const text = "line\n".repeat(30_000).trimEnd();
    const webfetch = tool(text);
    const first = await webfetch.execute("t", { url: "https://example.com/page" });
    const next = Number(/offset=(?<next>\d+) to continue/u.exec(textOf(first))?.groups?.next);
    const second = await webfetch.execute("t", { url: "https://example.com/page", offset: next });
    expect(textOf(second)).toContain(`Showing bytes ${next}–`);
    expect(textOf(second).startsWith("line")).toBe(true);
    const omitted = await webfetch.execute("t", { url: "https://example.com/page", offset: 0 });
    expect(omitted.details.fullOutputPath).toBeDefined();
  });
});

describe("webfetch offset paging over a response-truncated page", () => {
  const text = "€".repeat(60_000);

  test("pages through the partial body, each window carrying the notice and the next offset", async () => {
    const first = textOf(await project(text, undefined, [], true));
    expect(first.startsWith("[Response truncated: ")).toBe(true);
    expect(first).toContain("Showing bytes 0–51198 of 180000.");
    expect(first.endsWith("Call webfetch again with offset=51198 to continue.]")).toBe(true);
    const middle = textOf(await project(text, 51_198, [], true));
    expect(middle.startsWith("[Response truncated: ")).toBe(true);
    expect(middle).toContain("Showing bytes 51198–102396 of 180000.");
    expect(middle.endsWith("offset=102396 to continue.]")).toBe(true);
    expect(middle).not.toContain(END_NOTE);
  });

  test("the last window says the content stops at the download limit", async () => {
    const result = await project(text, 153_594, [], true);
    const shown = textOf(result);
    expect(shown.startsWith("[Response truncated: ")).toBe(true);
    expect(shown.endsWith(`[Showing bytes 153594–180000 of 180000. ${END_NOTE}]`)).toBe(true);
    expect(shown).not.toContain("to continue");
    expect(result.structuredContent).toMatchObject({
      response_truncated: true,
      truncated: true,
      offset: 153_594,
    });
    expect(result.structuredContent).not.toHaveProperty("next_offset");
  });

  test("a one-line tail window says the content stops at the download limit", async () => {
    const shown = textOf(await project("a".repeat(60_000), 20_000, [], true));
    expect(shown.endsWith(`[Showing bytes 20000–60000 of 60000. ${END_NOTE}]`)).toBe(true);
  });

  test("a short first page of a truncated fetch does not imply the page ended", async () => {
    const shown = textOf(await project("short", undefined, [], true));
    expect(shown.endsWith(`short\n\n[${END_NOTE}]`)).toBe(true);
  });

  test("an offset past the end says the content stops at the download limit", async () => {
    const result = await project(text, 999_999, [], true);
    expect(textOf(result).endsWith(`(180000). ${END_NOTE}]`)).toBe(true);
    expect(textOf(result).startsWith("[Response truncated: ")).toBe(true);
    expect(result.structuredContent).toMatchObject({ response_truncated: true, offset: 999_999 });
    expect(result.structuredContent).not.toHaveProperty("next_offset");
    expect(Value.Check(WEB_FETCH_OUTPUT_SCHEMA, result.structuredContent)).toBe(true);
  });

  test("a page that was not truncated keeps the plain end-of-content messages", async () => {
    expect(textOf(await project("abc", 99))).toBe(
      "[offset 99 is at or past the end of the content (3)]",
    );
  });
});
