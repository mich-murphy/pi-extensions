import process from "node:process";
import type { AutoResumeRegistration } from "./auto-resume";
import { registerAutoResume } from "./auto-resume";

const clockTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Register automatic resume after provider usage limits reset. */
export default function autoResume(pi: AutoResumeRegistration): void {
  registerAutoResume(pi, {
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
