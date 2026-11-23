import process from "node:process";

export function writeRedirectedDiagnostic(line: string): void {
  if (process.stderr.isTTY) {
    return;
  }
  try {
    process.stderr.write(line);
  } catch {
    return undefined;
  }
}
