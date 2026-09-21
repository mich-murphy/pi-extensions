import { type ChildProcess, spawn } from "node:child_process";
import {
  type CaffeinateEnd,
  type CaffeinateProcess,
  CaffeinateProcessError,
} from "./no-sleep-lifecycle";

function failed(cause: unknown): CaffeinateEnd {
  return { _tag: "failed", error: new CaffeinateProcessError(cause) };
}

/**
 * Create the Node child-process adapter that runs caffeinate.
 *
 * @param command - Executable to spawn.
 * @param killGraceMs - Time a stopped child gets to honour SIGTERM before SIGKILL.
 * @returns Spawn function for the no-sleep lifecycle.
 */
export function caffeinateSpawner(
  command: string,
  killGraceMs: number,
): (args: ReadonlyArray<string>) => CaffeinateProcess {
  return (args) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { stdio: "ignore" });
    } catch (cause) {
      // Node throws some spawn failures and emits others; callers see one asynchronous channel.
      return {
        onEnd: (listener) => queueMicrotask(() => listener(failed(cause))),
        stop: () => {},
      };
    }
    // The child must never keep Pi's event loop alive.
    child.unref();

    return {
      onEnd: (listener) => {
        // Permanent, not once(): an "error" event without a listener would crash Pi.
        child.on("error", (cause) => listener(failed(cause)));
        child.once("exit", (code, signal) => listener({ _tag: "exited", code, signal }));
      },
      stop: () => {
        // kill() is a no-op once the child has exited, so neither signal can hit a reused PID.
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), killGraceMs).unref();
      },
    };
  };
}
