import { open } from "node:fs/promises";
import { basename } from "node:path";

/**
 * The first heading of an instruction file, or "" when it has none or only repeats the file name.
 * A heading is never blank and never holds a control character: control characters become spaces,
 * and an empty heading such as `#` followed by spaces is no heading, so the search goes on.
 */
export function instructionHeading(content: string, path: string): string {
  let previous = "";
  for (const line of proseLines(content)) {
    const atx = /^ {0,3}#{1,6}[\t ]+(?<heading>.+?)(?:[\t ]+#+)?[\t ]*$/u.exec(line)?.groups
      ?.heading;
    const heading = atx === undefined ? "" : printable(atx);
    if (heading !== "") {
      return distinctHeading(heading, path);
    }
    const setext = previous !== "" && /^ {0,3}(?:=+|-+)[\t ]*$/u.test(line);
    if (setext && printable(previous) !== "") {
      return distinctHeading(printable(previous), path);
    }
    previous = /^\S/u.test(line) ? line.trim() : "";
  }
  return "";
}

/** Replace control characters with spaces, then trim. */
function printable(text: string): string {
  return text.replaceAll(/\p{Cc}/gu, " ").trim();
}

function withoutFrontmatter(content: string): readonly string[] {
  const lines = content.replace(/^\uFEFF/u, "").split(/\r\n|[\r\n]/u);
  if (lines[0] !== "---") {
    return lines;
  }
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/u.test(line));
  return end < 0 ? [] : lines.slice(end + 1);
}

function* proseLines(content: string): Generator<string> {
  let fence = "";
  let comment = false;
  for (const line of withoutFrontmatter(content)) {
    if (comment || line.includes("<!--")) {
      comment = !line.includes("-->");
      yield "";
      continue;
    }
    const marker = /^ {0,3}(?<fence>`{3,}|~{3,})/u.exec(line)?.groups?.fence;
    if (marker !== undefined) {
      if (fence === "") {
        fence = marker;
      } else if (marker.startsWith(fence.slice(0, 1)) && marker.length >= fence.length) {
        fence = "";
      }
      yield "";
      continue;
    }
    if (fence === "") {
      yield line;
    }
  }
}

function distinctHeading(heading: string, path: string): string {
  return heading.toLowerCase() === basename(path).toLowerCase() ? "" : heading;
}

export async function readInstructionHeading(path: string): Promise<string> {
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(65_536);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return instructionHeading(buffer.toString("utf8", 0, bytesRead), path);
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}
