import process from "node:process";

/** Write diagnostics only to redirected stderr, never into Pi's terminal UI. */
export function writeRedirectedDiagnostic(line: string): void {
  // stderr and stdout normally share a terminal. Out-of-band writes would move
  // its cursor without updating Pi's differential renderer's screen state.
  if (!process.stderr.isTTY) {
    process.stderr.write(line);
  }
}
