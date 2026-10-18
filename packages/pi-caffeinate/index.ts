import process from "node:process";
import { caffeinateSpawner } from "./caffeinate-process";
import type { NoSleepRegistration } from "./no-sleep-lifecycle";
import { registerNoSleep } from "./no-sleep-lifecycle";

const CAFFEINATE_PATH = "/usr/bin/caffeinate";
const KILL_GRACE_MS = 1000;

/** Register macOS sleep prevention for the periods when Pi is doing agent work. */
export default function noSleep(pi: NoSleepRegistration): void {
  registerNoSleep(pi, {
    platform: process.platform,
    processId: process.pid,
    spawnCaffeinate: caffeinateSpawner(CAFFEINATE_PATH, KILL_GRACE_MS),
  });
}
