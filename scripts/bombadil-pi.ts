// Starts the pinned Pi CLI in a throwaway home with only the given extensions, for Bombadil's
// terminal driver. Offline, no model, no tools, no user files: only what the extension draws.
// node --experimental-strip-types scripts/bombadil-pi.ts packages/pi-vim/index.ts
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = join(repo, "node_modules/@earendil-works/pi-coding-agent");
const manifest: unknown = JSON.parse(readFileSync(join(host, "package.json"), "utf8"));
const bin =
  typeof manifest === "object" && manifest !== null && "bin" in manifest ? manifest.bin : undefined;
if (typeof bin !== "object" || bin === null || !("pi" in bin) || typeof bin.pi !== "string") {
  throw new Error("Missing Pi executable in the pinned pi-coding-agent package");
}
const extensions = process.argv.slice(2);
if (extensions.length === 0) {
  throw new Error("Usage: bombadil-pi.ts <extension.ts>...");
}

// /tmp rather than os.tmpdir(): on macOS that is a long /var/folders path, which would push the
// gateway's default socket under the throwaway home past the 100-byte Unix socket limit.
const root = mkdtempSync("/tmp/pi-bombadil-");
for (const part of ["home", "agent", "sessions", "cwd", "tmp"]) {
  mkdirSync(join(root, part));
}
writeFileSync(
  join(root, "agent/settings.json"),
  JSON.stringify({
    theme: "dark",
    quietStartup: true,
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    cacheWarming: "off",
    // Two Escapes within 500 ms would open the session tree and take focus from the editor.
    doubleEscapeAction: "none",
  }),
);

const writeLog = process.env.PI_TUI_WRITE_LOG;
const child = spawn(
  process.execPath,
  [
    resolve(host, bin.pi),
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-tools",
    "--no-mcp",
    "--no-session",
    ...extensions.flatMap((path) => ["--extension", resolve(repo, path)]),
  ],
  {
    cwd: join(root, "cwd"),
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      TERM: process.env.TERM ?? "xterm-256color",
      SHELL: "/bin/sh",
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      // Opt-in log of every byte Pi writes to the terminal, for diagnosing a violation.
      ...(writeLog === undefined || writeLog === "" ? {} : { PI_TUI_WRITE_LOG: writeLog }),
    },
  },
);
// The child shares this terminal, so it gets SIGINT/SIGWINCH directly; forward only termination.
for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  rmSync(root, { recursive: true, force: true });
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  // Nothing else holds the event loop once the child has gone, so Node exits with this code.
  process.exitCode = code ?? 1;
});
