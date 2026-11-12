import { once } from "node:events";
import { copyFile, chmod, mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { vi } from "vitest";
import type { DialogContext } from "../onboarding/dialog.js";

export const builtGateway = resolve("packages/pi-comms/gateway/target/debug/pi-gateway");
export async function nativeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-")));
  const executable = join(root, "pi-gateway");
  await copyFile(builtGateway, executable);
  await chmod(executable, 0o500);
  return { root, executable };
}
export function dialog(
  answers: (string | undefined)[],
  mode: DialogContext["mode"] = "rpc",
): DialogContext {
  return {
    mode,
    signal: undefined,
    hasUI: mode === "rpc" || mode === "tui",
    ui: {
      select: vi.fn<DialogContext["ui"]["select"]>(async (_title, options) => {
        const value = answers.shift();
        return value === "APPLY" ? options.find((item) => item.startsWith("Apply —")) : value;
      }),
      input: vi.fn<DialogContext["ui"]["input"]>(async () => answers.shift()),
      notify: vi.fn<DialogContext["ui"]["notify"]>(),
    },
  };
}
export async function nativeUntil(check: () => Promise<boolean>, deadlineMs = 5000): Promise<void> {
  const end = performance.now() + deadlineMs;
  while (!(await check())) {
    if (performance.now() >= end) {
      throw new Error("Native fixture deadline exceeded");
    }
    await delay(25);
  }
}

export async function nativeAddress(): Promise<string> {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("No native fixture port");
  }
  const closed = once(server, "close");
  server.close();
  await closed;
  return `127.0.0.1:${address.port}`;
}
