/** Explicit evaluation runner (never run by the test gate). Writes a JSON artifact only to the given path.
 *  node --import jiti/register test/codemode/run.ts <out.json> [trials=3]
 *  Offline: SIMULATED gateway + scripted recorder; elapsedMs is CPU/roundtrip, not live latency. */
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Metrics } from "./trial.js";

const execute = promisify(execFile);
const trial = fileURLToPath(new URL("./trial.ts", import.meta.url));
const MAX_CONCURRENCY = 2;
const MAX_TRIALS = 20;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("Trial result is not an object");
  }
  return Object.fromEntries(Object.entries(value));
}
function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`Trial result field ${key} is not a string`);
  }
  return value;
}
function count(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Trial result field ${key} is not a finite number`);
  }
  return value;
}
function flag(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") {
    throw new TypeError(`Trial result field ${key} is not a boolean`);
  }
  return value;
}
function parseMetrics(line: string): Metrics {
  const row = record(JSON.parse(line));
  const tools = row.activeTools;
  return {
    scenario: text(row, "scenario"),
    arm: text(row, "arm"),
    rounds: count(row, "rounds"),
    modelToolCalls: count(row, "modelToolCalls"),
    gatewayOps: count(row, "gatewayOps"),
    toolResultBytes: count(row, "toolResultBytes"),
    cumulativeRequestBytes: count(row, "cumulativeRequestBytes"),
    firstRequestBytes: count(row, "firstRequestBytes"),
    correct: flag(row, "correct"),
    finalAnswer: text(row, "finalAnswer"),
    elapsedMs: count(row, "elapsedMs"),
    activeTools: Array.isArray(tools) ? tools.map(String) : [],
    traceOk: flag(row, "traceOk"),
  };
}
async function runOne(scenario: string, arm: string): Promise<Metrics> {
  const { stdout, stderr } = await execute(
    process.execPath,
    ["--import", "jiti/register", trial, scenario, arm],
    {
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, RAYON_NUM_THREADS: "2", UV_THREADPOOL_SIZE: "2", GOMAXPROCS: "2" },
    },
  );
  const noise = stderr
    .split("\n")
    .filter((l) => l.trim() !== "" && !/Deprecation|trace-deprecation/u.test(l));
  if (noise.length > 0) {
    throw new Error(`Unexpected stderr for ${scenario}/${arm}: ${noise.join(" | ")}`);
  }
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (line === undefined) {
    throw new Error(`No result for ${scenario}/${arm}`);
  }
  return parseMetrics(line.slice(7));
}
export async function runAll(scenarios: string[], trials: number): Promise<Metrics[]> {
  if (!Number.isInteger(trials) || trials < 1 || trials > MAX_TRIALS) {
    throw new RangeError(`trials must be an integer from 1 to ${MAX_TRIALS}`);
  }
  const jobs = scenarios.flatMap((s) =>
    ["direct", "codemode"].flatMap((a) => Array.from({ length: trials }, () => [s, a] as const)),
  );
  const results: Metrics[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      if (job !== undefined) {
        results.push(await runOne(job[0], job[1]));
      }
    }
  };
  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, worker));
  if (results.length !== jobs.length) {
    throw new Error(`Expected ${jobs.length} results, got ${results.length}`);
  }
  return results;
}
if (process.argv[1]?.endsWith("run.ts") === true) {
  const out = process.argv[2];
  const trials = Number(process.argv[3] ?? 3);
  if (out === undefined) {
    throw new Error("usage: run.ts <out.json> [trials]");
  }
  const results = await runAll(["single_read", "aggregate"], trials);
  await writeFile(
    out,
    JSON.stringify(
      { simulatedGateway: true, offlineScriptedRecorder: true, trials, results },
      null,
      2,
    ),
  );
}
