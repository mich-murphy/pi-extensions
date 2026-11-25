import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Option, Predicate, Schema } from "effect";
import type { BombadilFixture, BombadilLaunch, BombadilRoot } from "../test-support/bombadil.ts";
import { readManifest } from "../test-support/pi-manifest.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = join(repo, "node_modules/@earendil-works/pi-coding-agent");
const { bin } = readManifest(join(host, "package.json"));

const extensions: string[] = [];
let fixturePath: string | undefined;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
  const value = argv[index] ?? "";
  if (value === "--fixture") {
    index++;
    fixturePath = argv[index];
  } else {
    extensions.push(value);
  }
}
if (extensions.length === 0 || (argv.includes("--fixture") && fixturePath === undefined)) {
  throw new Error("Usage: bombadil-pi.ts [--fixture <file.ts>] <extension.ts>...");
}

const SHORT_TMP_PREFIX_KEEPING_SOCKETS_UNDER_UNIX_PATH_LIMIT = "/tmp/pi-bombadil-";
const base = mkdtempSync(SHORT_TMP_PREFIX_KEEPING_SOCKETS_UNDER_UNIX_PATH_LIMIT);
const root: BombadilRoot = {
  root: base,
  home: join(base, "home"),
  agent: join(base, "agent"),
  sessions: join(base, "sessions"),
  cwd: join(base, "cwd"),
  tmp: join(base, "tmp"),
};
for (const path of [root.home, root.agent, root.sessions, root.cwd, root.tmp]) {
  mkdirSync(path);
}

const decodeFixture = Schema.decodeUnknownOption(
  Schema.Struct({
    default: Schema.declare<BombadilFixture>((value): value is BombadilFixture =>
      Predicate.isFunction(value),
    ),
  }),
);

async function loadFixture(path: string | undefined): Promise<BombadilLaunch> {
  if (path === undefined) {
    return {};
  }
  const fixture = decodeFixture(await import(pathToFileURL(resolve(repo, path)).href));
  if (Option.isNone(fixture)) {
    throw new TypeError(`Fixture ${path} has no default export function`);
  }
  return fixture.value.default(root);
}

let launch: BombadilLaunch;
try {
  launch = await loadFixture(fixturePath);
} catch (error) {
  rmSync(base, { recursive: true, force: true });
  throw error;
}

const DOUBLE_ESCAPE_WOULD_OPEN_SESSION_TREE_AND_STEAL_EDITOR_FOCUS = {
  doubleEscapeAction: "none",
} as const;

writeFileSync(
  join(root.agent, "settings.json"),
  JSON.stringify({
    theme: "dark",
    quietStartup: true,
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    cacheWarming: "off",
    ...DOUBLE_ESCAPE_WOULD_OPEN_SESSION_TREE_AND_STEAL_EDITOR_FOCUS,
    ...launch.settings,
  }),
);

const omitted = new Set(launch.omitDefaults);
const defaults = [
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  omitted.has("--no-tools") ? "--no-builtin-tools" : "--no-tools",
  "--no-mcp",
].filter((flag) => !omitted.has(flag));

const writeLog = process.env.PI_TUI_WRITE_LOG;
const childEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: root.home,
  TMPDIR: root.tmp,
  TERM: process.env.TERM ?? "xterm-256color",
  SHELL: "/bin/sh",
  PI_CODING_AGENT_DIR: root.agent,
  PI_CODING_AGENT_SESSION_DIR: root.sessions,
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};
if (writeLog !== undefined && writeLog !== "") {
  childEnv.PI_TUI_WRITE_LOG = writeLog;
}
const child = spawn(
  process.execPath,
  [
    resolve(host, bin.pi),
    ...defaults,
    ...(launch.session === undefined ? ["--no-session"] : ["--session", launch.session]),
    ...extensions.flatMap((path) => ["--extension", resolve(repo, path)]),
    ...(launch.args ?? []),
  ],
  {
    cwd: root.cwd,
    stdio: "inherit",
    env: { ...childEnv, ...launch.env },
  },
);
const TERMINATION_SIGNALS_A_SHARED_TERMINAL_DOES_NOT_DELIVER = ["SIGTERM", "SIGHUP"] as const;
for (const signal of TERMINATION_SIGNALS_A_SHARED_TERMINAL_DOES_NOT_DELIVER) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  void (async () => {
    try {
      await launch.dispose?.();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  })();
});
