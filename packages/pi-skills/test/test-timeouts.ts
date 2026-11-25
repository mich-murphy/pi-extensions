export function timeoutOverTenfold(timeoutMs: number, slowestObservedMs: number): number {
  if (timeoutMs < slowestObservedMs * 10) {
    throw new Error(
      `timeout ${timeoutMs} ms is under ten times the slowest observed run of ${slowestObservedMs} ms`,
    );
  }

  return timeoutMs;
}
