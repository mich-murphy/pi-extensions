import process from "node:process";
import type { RetryRegistration } from "./retry";
import { registerRetry } from "./retry";

const clockTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export default function retry(pi: RetryRegistration): void {
  registerRetry(pi, {
    now: Date.now,
    every: (intervalMs, tick) => {
      const timer = setInterval(tick, intervalMs);
      return () => {
        clearInterval(timer);
      };
    },
    formatTime: (epochMs) => clockTime.format(epochMs),
    writeStderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}
