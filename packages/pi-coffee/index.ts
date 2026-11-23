import process from "node:process";
import { caffeinateSpawner } from "./caffeinate-process";
import type { CoffeeRegistration } from "./coffee-lifecycle";
import { registerCoffee } from "./coffee-lifecycle";

const CAFFEINATE_PATH = "/usr/bin/caffeinate";
const KILL_GRACE_MS = 1000;

export default function coffee(pi: CoffeeRegistration): void {
  registerCoffee(pi, {
    platform: process.platform,
    processIdCaffeinateExitsWith: process.pid,
    spawnCaffeinate: caffeinateSpawner(CAFFEINATE_PATH, KILL_GRACE_MS),
  });
}
