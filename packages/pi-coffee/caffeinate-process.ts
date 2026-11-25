import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { CaffeinateNotice, CaffeinateProcessError } from "./coffee-lifecycle";
import type { CaffeinateProcess } from "./coffee-lifecycle";

function nodeSystemErrorAsFailureOrRethrow(
  operation: CaffeinateProcessError["operation"],
  cause: unknown,
): CaffeinateNotice {
  if (cause instanceof Error && "syscall" in cause && "code" in cause) {
    const error = new CaffeinateProcessError(operation, String(cause.code), cause);

    return CaffeinateNotice.failed({ error });
  }

  throw cause;
}

export function caffeinateSpawner(
  command: string,
  killGraceMs: number,
): (args: readonly string[]) => CaffeinateProcess {
  return (args) => {
    let child: ChildProcess;

    try {
      child = spawn(command, [...args], { stdio: "ignore" });
    } catch (error) {
      const end = nodeSystemErrorAsFailureOrRethrow("start", error);

      return {
        onNotice: (listener) => {
          queueMicrotask(() => {
            listener(end);
          });
        },
        stop: () => undefined,
      };
    }

    child.unref();

    return {
      onNotice: (listener) => {
        child.on("error", (cause) => {
          listener(
            nodeSystemErrorAsFailureOrRethrow(child.pid === undefined ? "start" : "stop", cause),
          );
        });
        child.once("exit", (code, signal) => {
          listener(CaffeinateNotice.exited({ code, signal }));
        });
      },
      stop: () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
        }, killGraceMs).unref();
      },
    };
  };
}
