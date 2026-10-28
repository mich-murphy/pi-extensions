import process from "node:process";

/** Write diagnostics only to redirected stderr, never into Pi's terminal UI. */
export function writeRedirectedDiagnostic(line: string): void {
  // stderr and stdout normally share a terminal. Out-of-band writes would move
  // its cursor without updating Pi's differential renderer's screen state.
  if (process.stderr.isTTY) {
    return;
  }
  try {
    process.stderr.write(line);
  } catch {
    // Diagnostics are best effort. A closed or broken stderr (EPIPE, closed fd) must never
    // escape here: callers run on turn-finalization paths where a throw would leave Pi's
    // stream open and hang the turn.
  }
}
