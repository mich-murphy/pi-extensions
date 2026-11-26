import { once } from "node:events";
import { copyFile, chmod, mkdtemp, realpath, lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Schema } from "effect";
import { vi } from "vitest";
import { errnoCode } from "../../shared/errno.js";
import type { GatewayCatalog } from "../onboarding/catalog.js";
import type { DialogContext } from "../onboarding/dialog.js";
import type { Progress } from "../onboarding/menu/forms.js";
import { MenuModel } from "../onboarding/menu/model.js";
import type { Screen } from "../onboarding/menu/model.js";
import type { Outcome } from "../onboarding/menu/progress.js";

export const builtGateway = resolve("packages/pi-peers/gateway/target/debug/pi-gateway");

export async function nativeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-")));
  const executable = join(root, "pi-gateway");
  await copyFile(builtGateway, executable);
  await chmod(executable, 0o500);

  return { root, executable };
}

const LOCAL = "Local only — no remote connections (recommended)";
const CONSENT = /(?:: Ready$|^Turn off peers$|^Keep and reconnect$)/u;
const TOGGLES = ["discover", "push"];
const GRANT = /^(?:Allow|Deny)$/u;

function toggled(
  answers: Array<string | undefined>,
  options: ReadonlyArray<string>,
  seen: number,
): number {
  let index = seen;

  while (index < TOGGLES.length && GRANT.test(answers[0] ?? "")) {
    const want = answers.shift() === "Allow";
    const name = TOGGLES[index] ?? "";
    index += 1;

    if (options.includes(`${name}: ${want ? "Off" : "On"}`)) {
      answers.unshift(`${name}: ${want ? "Off" : "On"}`);

      return index;
    }
  }

  answers.unshift("Back");

  return 0;
}

function field(answer: string | undefined): readonly [string, string] | undefined {
  const at = answer?.indexOf("=") ?? -1;

  return answer === undefined || at <= 0 ? undefined : [answer.slice(0, at), answer.slice(at + 1)];
}

function setField(
  answers: Array<string | undefined>,
  options: ReadonlyArray<string>,
  state: { cycles: number },
): string | undefined {
  for (;;) {
    const wanted = field(answers[0]);

    if (wanted === undefined) {
      return undefined;
    }

    const [row, value] = wanted;

    if (options.includes(`${row}: ${value}`)) {
      answers.shift();
      state.cycles = 0;
      continue;
    }

    state.cycles += 1;

    if (state.cycles > 8) {
      throw new Error(`Fixture cannot set ${row} to ${value}`);
    }

    return options.find((option) => option.startsWith(`${row}: `));
  }
}

function togglesShown(options: ReadonlyArray<string>): boolean {
  return options.includes("discover: On") || options.includes("discover: Off");
}

function skipFormless(answers: Array<string | undefined>): void {
  while (answers[0] === LOCAL || answers[0] === "Edit choices") {
    answers.shift();
  }
}

function plainOption(
  value: string | undefined,
  form: boolean,
  options: ReadonlyArray<string>,
): string | undefined {
  if (form && value === "Permissions") {
    return options.find((option) => option.startsWith("Permissions: "));
  }

  return value === "APPLY" ? options.find((option) => CONSENT.test(option)) : value;
}

function scripted(
  answers: Array<string | undefined>,
  options: ReadonlyArray<string>,
  state: { toggles: number; cycles: number },
): string | undefined {
  if (togglesShown(options)) {
    state.toggles = toggled(answers, options, state.toggles);

    return answers.shift();
  }

  const form = options.some((option) => option.startsWith("Mode: "));

  if (form) {
    skipFormless(answers);
  }

  return setField(answers, options, state) ?? plainOption(answers.shift(), form, options);
}

export function dialog(
  answers: Array<string | undefined>,
  mode: DialogContext["mode"] = "rpc",
): DialogContext {
  const cursor = { toggles: 0, cycles: 0 };

  return {
    mode,
    signal: undefined,
    hasUI: mode === "rpc" || mode === "tui",
    ui: {
      select: vi.fn<DialogContext["ui"]["select"]>(async (_title, options) =>
        scripted(answers, options, cursor),
      ),
      input: vi.fn<DialogContext["ui"]["input"]>(async () => {
        cursor.cycles = 0;
        const answer = answers.shift();

        return field(answer)?.[1] ?? answer;
      }),
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

const isAddress = Schema.is(Schema.Struct({ address: Schema.String, port: Schema.Number }));

export async function nativeAddress(): Promise<string> {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();

  if (address === null || !isAddress(address)) {
    throw new Error("No native fixture port");
  }

  const closed = once(server, "close");
  server.close();
  await closed;

  return `127.0.0.1:${address.port}`;
}

export async function nativeIncarnation(path: string): Promise<string | undefined> {
  try {
    const value = await lstat(path, { bigint: true });

    if (!value.isSocket()) {
      throw new Error("Native fixture path is not a socket");
    }

    return `${value.dev}:${value.ino}:${value.ctimeNs}`;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export function nativeParticipants() {
  const clients = new Set<{ close: () => void }>();
  let stopping = false;
  let settled = true;

  return {
    own<T extends { close: () => void }>(client: T): T {
      if (stopping) {
        client.close();
        throw new Error("Native fixture is stopping; late participant refused");
      }

      clients.add(client);

      return client;
    },
    async run(body: () => Promise<void>): Promise<void> {
      settled = false;

      try {
        await body();
      } finally {
        settled = true;
      }
    },
    async close(): Promise<void> {
      stopping = true;

      for (const client of clients) {
        client.close();
      }

      await nativeUntil(async () => settled, 65_000);
    },
  };
}

export const noPins = { catalog: { nix: null, native: null } } satisfies {
  catalog: GatewayCatalog;
};

export async function consentOutcome(
  open: (progress: Progress) => Screen,
  id = "apply",
): Promise<Outcome | undefined> {
  let work: Promise<Outcome> | undefined;

  const screen = open((_title, _planned, run) => {
    work = run(() => undefined);
  });

  new MenuModel(screen).activate(id);

  return work;
}
