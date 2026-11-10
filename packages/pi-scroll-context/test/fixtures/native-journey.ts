// Real native CLI + tmux acceptance journey. No terminal/layout mocks or model requests.
// node packages/pi-scroll-context/test/fixtures/native-journey.ts [absolute Pi package directory]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// Pi queries tmux for extended-keys after startup and adds a warning row only if it is off. That row
// would arrive at a machine-dependent moment and change the transcript height, so the server is
// configured the way Pi wants and the warning never exists.
const tmuxConfig = join(root, "tmux.conf");
writeFileSync(tmuxConfig, "set -g extended-keys on\nset -g extended-keys-format csi-u\n");
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
// A condition-based wait: the PTY is polled until the screen satisfies the step's own assertion,
// so nothing here depends on how fast the CLI, tmux or the machine happens to be. The deadline only
// bounds a hang, and the last assertion failure is what gets reported.
const WAIT_DEADLINE_MS = 120_000;
const POLL_MS = 50;
async function eventually(name: string, check: (screen: string) => void): Promise<string> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  for (;;) {
    const screen = capture(name);
    try {
      check(screen);
      return screen;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
    }
    await delay(POLL_MS);
  }
}
async function eventuallyMode(expected: string): Promise<void> {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (readMode() !== expected) {
    assert.ok(Date.now() < deadline, `settings never recorded tuiMode ${expected}`);
    await delay(POLL_MS);
  }
}
// tmux queues input into the PTY in order, so keys need no pause between them; each step then waits
// for the screen state it expects.
function key(value: string, repeat = 1): void {
  tmux("send-keys", "-t", "journey:0.0", "-N", String(repeat), value);
}
function text(value: string): void {
  tmux("send-keys", "-t", "journey:0.0", "-l", value);
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
      tmuxConfig,
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
    // CLI startup is slower under load and coverage: wait for the fixture's last line to show, then
    // for the screen to stop changing between two captures.
    let previous: string | undefined;
    return eventually(captureName, (screen) => {
      assert.match(screen, /TURN_2_LINE_085/u, "CLI fixture did not appear");
      // Startup is complete once the synchronous no-provider warning row is on screen too.
      assert.match(screen, /No models available/u, "CLI startup rows did not appear");
      assert.doesNotMatch(screen, /extended-keys/u, "tmux warning appeared despite the config");
      const unchanged = screen === previous;
      previous = screen;
      assert.ok(unchanged, "screen is still changing");
    });
  }
  const baseline = await launch(baseCommand, "baseline-without-extension");
  tmux("kill-session", "-t", "journey");
  const screen = await launch(command, "startup");
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
  text("\u001B[<64;10;5M");
  await eventually("wheel-up", (current) => {
    sticky(current, "LATEST_CONTEXT");
  });
  key("F9");
  await eventually("wheel-return-to-bottom", noSticky);
  passed.push("native SGR mouse-wheel input activates context without taking editor focus");
  key("F6");
  await eventually("one-row-up", (current) => {
    sticky(current, "LATEST_CONTEXT");
  });
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
  text("FOCUS_SENTINEL");
  await eventually("focused-history", (current) => {
    assert.match(current, /FOCUS_SENTINEL/u);
    sticky(current, "LATEST_CONTEXT");
  });
  passed.push("editor retains focus while browsing");
  key("C-u");
  await eventually("sentinel-cleared", (current) => {
    assert.doesNotMatch(current, /FOCUS_SENTINEL/u);
  });
  key("F6", 15);
  await eventually("deeper-history", (current) => {
    sticky(current, "LATEST_CONTEXT");
  });
  key("F7");
  await eventually("down-through-history", (current) => {
    sticky(current, "LATEST_CONTEXT");
  });
  passed.push("down-history retains sticky context");
  key("F6", 75);
  await eventually("older-turn", (current) => {
    sticky(current, "OLDER_CONTEXT");
    assert.match(current, /TURN_1_LINE_/u);
  });
  passed.push("older assistant uses preceding older prompt, not latest prompt");
  key("F8");
  await eventually("original-prompt-visible", (current) => {
    assert.match(current, /OLDER_CONTEXT/u);
    noSticky(current);
  });
  passed.push("original visible prompt suppresses duplicate");
  key("F9");
  await eventually("bottom-reclaimed", (current) => {
    noSticky(current);
    assert.equal(first(current), bottomFirstRow);
    assert.match(current, /TURN_2_LINE_085/u);
  });
  passed.push("bottom hides header and restores original top transcript row");
  key("F6");
  await eventually("one-row-up-before-resize", (current) => {
    sticky(current, "LATEST_CONTEXT");
  });
  tmux("resize-window", "-t", "journey:0", "-x", "34", "-y", "22");
  // Native Pi preserves numeric scrollTop during width reflow, not message identity.
  // Reflow puts this historical offset in turn one; the header must follow that view.
  await eventually("narrow-reflow-context", (current) => {
    assert.match(current, /TURN_1_LINE_/u);
    sticky(current, "OLDER_CONTEXT");
  });
  passed.push("narrow reflow selects the prompt for the actual visible native turn");
  key("F9");
  await eventually("narrow-live-bottom", noSticky);
  key("F6");
  await eventually("unicode-narrow", (current) => {
    sticky(current, "LATEST_CONTEXT");
    assert.match(first(current), /…/u);
    assert.match(first(current), /漢字/u);
  });
  passed.push("Unicode narrow viewport keeps one truncated context row");
  text("/reload");
  key("Enter");
  await eventually("reloaded", (current) => {
    assert.match(current, /Reloaded\s+keybindings/u);
  });
  key("F9");
  await eventually("reload-bottom", noSticky);
  key("F6");
  await eventually("after-reload", (current) => {
    sticky(current, "LATEST_CONTEXT");
  });
  passed.push("reload reattaches without duplicate context row");
  // The settings selector is the native supported mode-switch surface.
  tmux("resize-window", "-t", "journey:0", "-x", "90", "-y", "28");
  async function toggleTuiMode(
    expected: string,
    captureName: string,
    check: (screen: string) => void,
  ): Promise<string> {
    text("/settings");
    key("Enter");
    await eventually(`${captureName}-selector`, (current) => {
      assert.match(current, /Type to search/u);
    });
    text("TUI mode");
    await eventually(`${captureName}-filtered`, (current) => {
      assert.match(current, /> TUI mode/u);
    });
    key("Enter");
    await eventuallyMode(expected);
    key("Escape");
    return eventually(captureName, (current) => {
      assert.doesNotMatch(current, /Type to search/u);
      check(current);
    });
  }
  await toggleTuiMode("regular", "regular-mode", noSticky);
  assert.equal(readMode(), "regular");
  await toggleTuiMode("fullscreen", "fullscreen-mode", () => undefined);
  assert.equal(readMode(), "fullscreen");
  key("F9");
  await eventually("fullscreen-bottom", noSticky);
  key("F6");
  await eventually("fullscreen-restored", (current) => {
    sticky(current, "LATEST_CONTEXT");
  });
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
// Evidence is only worth keeping when the journey failed; the failure path above rethrows first.
if (process.env.PI_SCROLL_CONTEXT_KEEP_EVIDENCE === undefined) {
  // The CLI the killed tmux server hung up on may still be flushing a log into the directory, which
  // makes removal fail with ENOTEMPTY until it has exited; wait for that state instead of a pause.
  const removalDeadline = Date.now() + WAIT_DEADLINE_MS;
  for (;;) {
    try {
      rmSync(root, { recursive: true, force: true });
      break;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      assert.ok(code === "ENOTEMPTY" && Date.now() < removalDeadline, String(error));
      await delay(POLL_MS);
    }
  }
}
