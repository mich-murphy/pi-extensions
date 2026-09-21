import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { caffeinateSpawner } from "./caffeinate-process";
import { registerNoSleep } from "./no-sleep-lifecycle";

const CAFFEINATE_PATH = "/usr/bin/caffeinate";
const KILL_GRACE_MS = 1_000;

/** Register macOS sleep prevention for the periods when Pi is doing agent work. */
export default function noSleep(pi: ExtensionAPI): void {
  registerNoSleep(pi, {
    platform: process.platform,
    processId: process.pid,
    spawnCaffeinate: caffeinateSpawner(CAFFEINATE_PATH, KILL_GRACE_MS),
  });
}
