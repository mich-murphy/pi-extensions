import { copyFile, chmod, mkdir, mkdtemp, realpath, lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { vi } from "vitest";
import { errnoCode } from "../../shared/errno.js";
import type { GatewayCatalog } from "../onboarding/catalog.js";
import type { DialogContext } from "../onboarding/dialog.js";

export const builtGateway = resolve("packages/pi-peers/gateway/target/debug/pi-gateway");

export async function nativeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-")));
  const executable = join(root, "pi-gateway");
  await copyFile(builtGateway, executable);
  await chmod(executable, 0o500);

  return { root, executable };
}

const TAILSCALE_GATEWAY_VERSION = JSON.stringify({
  name: "pi-gateway",
  version: "0.4.0",
  wireVersions: [2],
  capabilities: [
    "managed-on-demand-v1",
    "gateway-control-v1",
    "setup-lock-v1",
    "config-generation-v1",
    "tailscale-identity-v1",
  ],
});

export const TAILNET = {
  self: ["100.64.0.1", "fd7a:115c:a1e0::1"],
  other: "dev-01",
  otherAddress: "100.64.0.2",
  ipOnly: "build-box",
  ipOnlyAddress: "100.64.0.3",
  unknownAddress: "100.64.0.9",
} as const;

function whois(name: string, address: string, stableId: string): string {
  return JSON.stringify({
    Node: {
      ID: 7,
      StableID: stableId,
      Name: `${name.toUpperCase()}.tail0000.ts.net.`,
      Addresses: [`${address}/32`],
      Tags: ["tag:dev"],
    },
    UserProfile: { LoginName: "tagged-devices" },
    CapMap: {},
  });
}

function gatewayWrapper(real: string, diagnose: string): string {
  return [
    "#!/bin/sh",
    `if [ "$1" = "--version" ] && [ "$2" = "--json" ]; then echo '${TAILSCALE_GATEWAY_VERSION}'; exit 0; fi`,
    `if [ "$1" = "--diagnose" ] && [ -f ${JSON.stringify(diagnose)} ]; then cat ${JSON.stringify(diagnose)}; exit 0; fi`,
    `exec ${JSON.stringify(real)} "$@"`,
    "",
  ].join("\n");
}

function fakeTailscale(machine: string, backend: string): string {
  const status = JSON.stringify({
    BackendState: backend,
    Self: { DNSName: `${machine}.tail0000.ts.net.`, TailscaleIPs: TAILNET.self },
  });

  return [
    "#!/bin/sh",
    `if [ "$1" = "status" ]; then echo '${status}'; exit 0; fi`,
    `if [ "$1" = "ip" ] && [ "$3" = "${TAILNET.other}" ]; then echo ${TAILNET.otherAddress}; exit 0; fi`,
    `if [ "$1" = "ip" ] && [ "$3" = "${TAILNET.other}.tail0000.ts.net." ]; then echo ${TAILNET.otherAddress}; exit 0; fi`,
    `if [ "$1" = "whois" ] && [ "$2" = "--json" ] && [ "$3" = "${TAILNET.otherAddress}" ]; then echo '${whois(TAILNET.other, TAILNET.otherAddress, "nDev")}'; exit 0; fi`,
    `if [ "$1" = "whois" ] && [ "$2" = "--json" ] && [ "$3" = "${TAILNET.ipOnlyAddress}" ]; then echo '${whois(TAILNET.ipOnly, TAILNET.ipOnlyAddress, "nBuild")}'; exit 0; fi`,
    `if [ "$1" = "whois" ]; then echo 'peer not found' >&2; exit 1; fi`,
    "echo 'no such host' >&2",
    "exit 1",
    "",
  ].join("\n");
}

export async function tailscaleGateway(native: { root: string; executable: string }) {
  const real = join(native.root, "pi-gateway-built");
  await copyFile(native.executable, real);
  await chmod(real, 0o500);
  const diagnose = join(native.root, "diagnose.json");
  const executable = join(native.root, "pi-gateway-tailscale");
  await writeFile(executable, gatewayWrapper(real, diagnose), { mode: 0o500 });

  return { executable, diagnose };
}

export async function tailscaleFixture(machine: string, backend = "Running") {
  const native = await nativeFixture();
  const gateway = await tailscaleGateway(native);
  const bin = join(native.root, "tailscale-bin");
  await mkdir(bin, { mode: 0o700 });
  const tailscale = join(bin, "tailscale");
  await writeFile(tailscale, fakeTailscale(machine, backend), { mode: 0o700 });

  return { root: native.root, ...gateway, tailscale };
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

  const form = options.some((option) => option.startsWith("Label: "));

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
