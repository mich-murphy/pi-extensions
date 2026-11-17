// Starts the pinned Pi CLI in a throwaway home with only the given extensions, for Bombadil's
// terminal driver. Offline, no tools, no user files: only what the extensions draw.
//
//   node --experimental-strip-types scripts/bombadil-pi.ts [--fixture <file.ts>] <extension.ts>...
//
// A fixture module's default export (see test-support/bombadil.ts) receives the throwaway
// directories before Pi starts. It can write files there and return extra Pi arguments,
// environment, settings, a session file to open, and a dispose hook.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BombadilFixture, BombadilLaunch, BombadilRoot } from "../test-support/bombadil.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = join(repo, "node_modules/@earendil-works/pi-coding-agent");
const manifest: unknown = JSON.parse(readFileSync(join(host, "package.json"), "utf8"));
const bin =
  typeof manifest === "object" && manifest !== null && "bin" in manifest ? manifest.bin : undefined;
if (typeof bin !== "object" || bin === null || !("pi" in bin) || typeof bin.pi !== "string") {
  throw new Error("Missing Pi executable in the pinned pi-coding-agent package");
}

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

// /tmp rather than os.tmpdir(): on macOS that is a long /var/folders path, which would push the
// gateway's default socket under the throwaway home past the 100-byte Unix socket limit.
const base = mkdtempSync("/tmp/pi-bombadil-");
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

/** The fixture contract is the BombadilFixture type; a fixture module is trusted test code. */
function isFixture(value: unknown): value is BombadilFixture {
  return typeof value === "function";
}

async function loadFixture(path: string | undefined): Promise<BombadilLaunch> {
  if (path === undefined) {
    return {};
  }
  const module: unknown = await import(pathToFileURL(resolve(repo, path)).href);
  const run: unknown =
    typeof module === "object" && module !== null && "default" in module
      ? module.default
      : undefined;
  if (!isFixture(run)) {
    throw new TypeError(`Fixture ${path} has no default export function`);
  }
  return run(root);
}

let launch: BombadilLaunch;
try {
  launch = await loadFixture(fixturePath);
} catch (error) {
  rmSync(base, { recursive: true, force: true });
  throw error;
}

writeFileSync(
  join(root.agent, "settings.json"),
  JSON.stringify({
    theme: "dark",
    quietStartup: true,
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    cacheWarming: "off",
    // Two Escapes within 500 ms would open the session tree and take focus from the editor.
    doubleEscapeAction: "none",
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
    env: {
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
      // Opt-in log of every byte Pi writes to the terminal, for diagnosing a violation.
      ...(writeLog === undefined || writeLog === "" ? {} : { PI_TUI_WRITE_LOG: writeLog }),
      ...launch.env,
    },
  },
);
// The child shares this terminal, so it gets SIGINT/SIGWINCH directly; forward only termination.
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
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
    // Nothing else holds the event loop once the child has gone, so Node exits with this code.
    process.exitCode = code ?? 1;
  })();
});
