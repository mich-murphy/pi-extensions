// Real native CLI + tmux acceptance journey. No terminal/layout mocks or model requests.
// node packages/pi-scroll-context/test/fixtures/native-journey.ts [absolute Pi package directory]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const host = resolve(process.argv[2] ?? join(repo, "node_modules/@earendil-works/pi-coding-agent"));
const rawManifest: unknown = JSON.parse(readFileSync(join(host, "package.json"), "utf8"));
assert.ok(
  typeof rawManifest === "object" &&
    rawManifest !== null &&
    "version" in rawManifest &&
    typeof rawManifest.version === "string" &&
    "bin" in rawManifest,
);
const manifest = rawManifest;
const bin = manifest.bin;
assert.ok(typeof bin === "object" && bin !== null && "pi" in bin && typeof bin.pi === "string");
const root = mkdtempSync(join(tmpdir(), "pi-scroll-context-native-"));
const socket = join(root, "tmux.sock");
for (const part of ["home", "agent", "sessions", "cwd", "tmp"]) {
  mkdirSync(join(root, part));
}
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  PI_CODING_AGENT_DIR: join(root, "agent"),
  PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
  TMPDIR: join(root, "tmp"),
  TERM: "xterm-256color",
  SHELL: "/bin/sh",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_TUI_WRITE_LOG: join(root, "terminal-writes.log"),
};
const settings = {
  theme: "dark",
  quietStartup: true,
  defaultProjectTrust: "never",
  enableInstallTelemetry: false,
  tuiMode: "fullscreen",
  fullscreenScrollbar: "hidden",
  cacheWarming: "off",
};
writeFileSync(join(root, "agent/settings.json"), JSON.stringify(settings));
writeFileSync(
  join(root, "agent/keybindings.json"),
  JSON.stringify({
    "tui.altScreen.lineUp": "f6",
    "tui.altScreen.lineDown": "f7",
    "tui.altScreen.top": "f8",
    "tui.altScreen.bottom": "f9",
  }),
);
const prompts = [
  "OLDER_CONTEXT alpha",
  `LATEST_CONTEXT 漢字 👩‍💻 é ${"narrow Unicode context ".repeat(7)}`,
];
const timestamp = 1_700_000_000_000;
const entries: Record<string, unknown>[] = [
  {
    type: "session",
    version: 3,
    id: "scroll-context-native",
    timestamp: new Date(timestamp).toISOString(),
    cwd: join(root, "cwd"),
  },
];
let parentId: string | null = null;
function message(value: Record<string, unknown>): void {
  const id = String(entries.length).padStart(8, "0");
  entries.push({
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: { ...value, timestamp },
  });
  parentId = id;
}
for (const [turn, prompt] of prompts.entries()) {
  message({ role: "user", content: prompt });
  message({
    role: "assistant",
    content: [
      {
        type: "text",
        text: Array.from(
          { length: 85 },
          (_, line) =>
            `TURN_${turn + 1}_LINE_${String(line + 1).padStart(3, "0")} deterministic transcript`,
        ).join("\n"),
      },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}
const session = join(root, "sessions/fixture.jsonl");
writeFileSync(session, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
const quote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;
const baseCommand = [
  process.execPath,
  resolve(host, bin.pi),
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-tools",
  "--no-mcp",
  "--session",
  session,
  "--tui-mode",
  "fullscreen",
];
const command = [...baseCommand, "--extension", join(repo, "packages/pi-scroll-context/index.ts")];
const actions: string[][] = [];
function tmux(...args: string[]): string {
  actions.push(args);
  return execFileSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 10_000 });
}
function capture(name: string): string {
  const screen = tmux("capture-pane", "-p", "-t", "journey:0.0");
  writeFileSync(join(root, `${name}.txt`), screen);
  writeFileSync(join(root, `${name}.ansi`), tmux("capture-pane", "-p", "-e", "-t", "journey:0.0"));
  return screen;
}
async function settled() {
  await delay(250);
}
async function key(value: string, repeat = 1): Promise<void> {
  tmux("send-keys", "-t", "journey:0.0", "-N", String(repeat), value);
  await settled();
}
async function text(value: string): Promise<void> {
  tmux("send-keys", "-t", "journey:0.0", "-l", value);
  await settled();
}
function readMode(): unknown {
  const value: unknown = JSON.parse(readFileSync(join(root, "agent/settings.json"), "utf8"));
  assert.ok(typeof value === "object" && value !== null && "tuiMode" in value);
  return value.tuiMode;
}
const first = (screen: string): string => screen.split("\n")[0] ?? "";
const sticky = (screen: string, prompt: string): void => {
  assert.match(first(screen), new RegExp(`^❯ ${prompt}`, "u"));
};
const noSticky = (screen: string): void => {
  assert.doesNotMatch(first(screen), /^❯ /u);
};
const passed: string[] = [];
let bottomFirstRow: string;
try {
  process.stdout.write(`Native evidence: ${root}\n`);
  async function launch(argv: string[], captureName: string): Promise<string> {
    tmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "journey",
      "-x",
      "90",
      "-y",
      "28",
      "-c",
      join(root, "cwd"),
      argv.map((value) => quote(value)).join(" "),
    );
    // CLI startup is slower under coverage; wait for visible fixture, not a fixed startup sleep.
    let screen = "";
    for (let attempt = 0; attempt < 120; attempt++) {
      await settled();
      screen = capture(captureName);
      if (screen.includes("TURN_2_LINE_085")) {
        await delay(750);
        return capture(captureName);
      }
    }
    throw new Error(`CLI fixture did not appear: ${screen}`);
  }
  const baseline = await launch(baseCommand, "baseline-without-extension");
  tmux("kill-session", "-t", "journey");
  let screen = await launch(command, "startup");
  assert.equal(
    first(screen),
    first(baseline),
    "extension must not permanently reserve a transcript row at live bottom",
  );
  passed.push("live-bottom transcript top row exactly matches unloaded-extension native baseline");
  assert.match(screen, /TURN_2_LINE_085/u);
  noSticky(screen);
  bottomFirstRow = first(screen);
  passed.push(
    "long transcript live bottom has no sticky row (positive offset inferred from 170 transcript lines)",
  );
  // Send the terminal's SGR wheel-up report through the real PTY input path.
  await text("\u001B[<64;10;5M");
  sticky(capture("wheel-up"), "LATEST_CONTEXT");
  await key("F9");
  noSticky(capture("wheel-return-to-bottom"));
  passed.push("native SGR mouse-wheel input activates context without taking editor focus");
  await key("F6");
  screen = capture("one-row-up");
  sticky(screen, "LATEST_CONTEXT");
  const styledHeader = first(readFileSync(join(root, "one-row-up.ansi"), "utf8"));
  assert.ok(
    styledHeader.includes("\u001B[38;2;") || styledHeader.includes("\u001B[38;5;"),
    "header has themed foreground",
  );
  assert.ok(
    styledHeader.includes("\u001B[48;2;") || styledHeader.includes("\u001B[48;5;"),
    "header has themed background",
  );
  passed.push(
    "one-row scroll up activates contextual latest prompt with themed foreground/background",
  );
  await text("FOCUS_SENTINEL");
  screen = capture("focused-history");
  assert.match(screen, /FOCUS_SENTINEL/u);
  sticky(screen, "LATEST_CONTEXT");
  passed.push("editor retains focus while browsing");
  await key("C-u");
  await key("F6", 15);
  screen = capture("deeper-history");
  sticky(screen, "LATEST_CONTEXT");
  await key("F7");
  sticky(capture("down-through-history"), "LATEST_CONTEXT");
  passed.push("down-history retains sticky context");
  await key("F6", 75);
  screen = capture("older-turn");
  sticky(screen, "OLDER_CONTEXT");
  assert.match(screen, /TURN_1_LINE_/u);
  passed.push("older assistant uses preceding older prompt, not latest prompt");
  await key("F8");
  screen = capture("original-prompt-visible");
  assert.match(screen, /OLDER_CONTEXT/u);
  noSticky(screen);
  passed.push("original visible prompt suppresses duplicate");
  await key("F9");
  screen = capture("bottom-reclaimed");
  noSticky(screen);
  assert.equal(first(screen), bottomFirstRow);
  assert.match(screen, /TURN_2_LINE_085/u);
  passed.push("bottom hides header and restores original top transcript row");
  await key("F6");
  tmux("resize-window", "-t", "journey:0", "-x", "34", "-y", "22");
  await settled();
  // Native Pi preserves numeric scrollTop during width reflow, not message identity.
  // Reflow puts this historical offset in turn one; the header must follow that view.
  screen = capture("narrow-reflow-context");
  assert.match(screen, /TURN_1_LINE_/u);
  sticky(screen, "OLDER_CONTEXT");
  passed.push("narrow reflow selects the prompt for the actual visible native turn");
  await key("F9");
  noSticky(capture("narrow-live-bottom"));
  await key("F6");
  screen = capture("unicode-narrow");
  sticky(screen, "LATEST_CONTEXT");
  assert.match(first(screen), /…/u);
  assert.match(first(screen), /漢字/u);
  passed.push("Unicode narrow viewport keeps one truncated context row");
  await text("/reload");
  await key("Enter");
  await delay(1500);
  await key("F9");
  await key("F6");
  sticky(capture("after-reload"), "LATEST_CONTEXT");
  passed.push("reload reattaches without duplicate context row");
  // The settings selector is the native supported mode-switch surface.
  tmux("resize-window", "-t", "journey:0", "-x", "90", "-y", "28");
  await settled();
  await text("/settings");
  await key("Enter");
  await text("TUI mode");
  screen = capture("settings-mode");
  assert.match(screen, /TUI mode/u);
  await key("Enter");
  await key("Escape");
  screen = capture("regular-mode");
  noSticky(screen);
  assert.equal(readMode(), "regular");
  await text("/settings");
  await key("Enter");
  await text("TUI mode");
  await key("Enter");
  await key("Escape");
  assert.equal(readMode(), "fullscreen");
  await key("F9");
  await key("F6");
  sticky(capture("fullscreen-restored"), "LATEST_CONTEXT");
  passed.push("native regular/fullscreen switches detach and reattach correctly");
} catch (error) {
  writeFileSync(
    join(root, "failure.txt"),
    error instanceof Error ? String(error.stack) : String(error),
  );
  throw error;
} finally {
  writeFileSync(
    join(root, "result.json"),
    JSON.stringify(
      {
        version: manifest.version,
        evidence: root,
        command,
        environment: env,
        passed,
        providerSafety:
          "fixture replay only; no model prompts submitted; requests not instrumented",
        terminal: "real tmux PTY + native CLI",
        actions,
      },
      null,
      2,
    ),
  );
  try {
    tmux("kill-server");
  } catch {
    /* already exited */
  }
}
process.stdout.write(
  JSON.stringify(
    {
      version: manifest.version,
      evidence: root,
      providerSafety: "fixture replay only; no model prompts submitted; requests not instrumented",
      passed,
    },
    null,
    2,
  ),
);
