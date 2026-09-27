import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Write tool output to a private temporary file.
 * The directory is created 0700 and the file 0600: fetched web content can
 * contain sensitive material and must not be world-readable in a shared tmpdir.
 */
export async function writeTempTextFile(
  prefix: string,
  fileName: string,
  content: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  const outputPath = join(dir, fileName);
  await writeFile(outputPath, content, { encoding: "utf8", mode: 0o600 });
  return outputPath;
}
