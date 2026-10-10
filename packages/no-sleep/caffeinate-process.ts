import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { CaffeinateProcessError } from "./no-sleep-lifecycle";
import type { CaffeinateEnd, CaffeinateProcess } from "./no-sleep-lifecycle";

/**
 * Classify a Node system error (one with `syscall` and `code`) as a caffeinate failure.
 * Anything else, such as an argument `TypeError`, is a defect and is rethrown.
 */
function failed(operation: CaffeinateProcessError["operation"], cause: unknown): CaffeinateEnd {
  if (cause instanceof Error && "syscall" in cause && "code" in cause) {
    const error = new CaffeinateProcessError(operation, String(cause.code), cause);
    return { _tag: "failed", error };
  }
  throw cause;
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
): (args: readonly string[]) => CaffeinateProcess {
  return (args) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { stdio: "ignore" });
    } catch (error) {
      // Node throws some spawn failures and emits others; callers see one asynchronous channel.
      const end = failed("start", error);
      return {
        onEnd: (listener) => {
          queueMicrotask(() => {
            listener(end);
          });
        },
        stop: () => {
          // Nothing was spawned, so there is nothing to stop.
        },
      };
    }
    // The child must never keep Pi's event loop alive.
    child.unref();

    return {
      onEnd: (listener) => {
        // Permanent, not once(): an "error" event without a listener would crash Pi.
        child.on("error", (cause) => {
          // A child without a PID never started; otherwise signalling it failed.
          listener(failed(child.pid === undefined ? "start" : "stop", cause));
        });
        child.once("exit", (code, signal) => {
          listener({ _tag: "exited", code, signal });
        });
      },
      stop: () => {
        // kill() is a no-op once the child has exited, so neither signal can hit a reused PID.
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
        }, killGraceMs).unref();
      },
    };
  };
}
