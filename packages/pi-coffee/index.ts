import process from "node:process";
import { caffeinateSpawner } from "./caffeinate-process";
import type { CoffeeRegistration } from "./coffee-lifecycle";
import { registerCoffee } from "./coffee-lifecycle";

const CAFFEINATE_PATH = "/usr/bin/caffeinate";
const KILL_GRACE_MS = 1000;

/** Register macOS sleep prevention for the periods when Pi is doing agent work, and `/coffee`. */
export default function coffee(pi: CoffeeRegistration): void {
  registerCoffee(pi, {
    platform: process.platform,
    processId: process.pid,
    spawnCaffeinate: caffeinateSpawner(CAFFEINATE_PATH, KILL_GRACE_MS),
  });
}
