import { describe, expect, test } from "vitest";
import { createAttribution } from "../owner.ts";
import type { OwnerSettings, ToolSource } from "../owner.ts";

const PACKAGES = "/repo/packages";

const tools: ReadonlyArray<ToolSource> = [
  { name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
  { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } },
  { name: "webfetch", sourceInfo: { path: `${PACKAGES}/pi-web/index.ts`, source: "local" } },
  { name: "outside", sourceInfo: { path: "/elsewhere/pi-web/index.ts", source: "local" } },
  { name: "relative", sourceInfo: { path: "pi-web/index.ts", source: "local" } },
];

const commands = [
  { name: "skills", sourceInfo: { path: `${PACKAGES}/pi-skills/index.ts` } },
  { name: "skill:tidy", sourceInfo: { path: "/home/u/.pi/agent/skills/tidy/SKILL.md" } },
];

const settings: OwnerSettings = {
  packagesDir: PACKAGES,
  ownPackages: ["pi-claude", "pi-web", "pi-skills"],
  agentDir: "/home/u/.pi/agent",
  home: "/home/u",
};

function attribution(overrides: Partial<OwnerSettings> = {}) {
  return createAttribution(
    { getAllTools: () => tools, getCommands: () => commands },
    { ...settings, ...overrides },
  );
}

describe("signal owner", () => {
  test.each([
    ["a tool our extension registered", "webfetch", "Request failed (404).", { owner: "pi-web" }],
    [
      "a Claude scratch path",
      "bash",
      "error connecting to /private/tmp/claude-501/-home-u-dev-x/abc/scratchpad/t.sock (File name too long)",
      { owner: "pi-claude" },
    ],
    [
      "a Claude project directory name",
      "bash",
      "find: unknown predicate `-home-u-dev-x'",
      { owner: "pi-claude" },
    ],
    [
      "Pi's sessions directory",
      "read",
      "ENOENT: /home/u/.pi/agent/sessions/x.jsonl",
      { owner: "unattributed", evidence: "pi-path" },
    ],
    [
      "Pi's sessions directory written from home",
      "bash",
      "ls: cannot access '~/.pi/agent/sessions/x'",
      { owner: "unattributed", evidence: "pi-path" },
    ],
    [
      "a Pi session directory name",
      "bash",
      "ls: unrecognized option '--home-u-dev-x--'",
      { owner: "unattributed", evidence: "pi-path" },
    ],
    [
      "a Pi path from a tool outside Pi",
      "outside",
      "ENOENT: /home/u/.pi/agent/sessions/x.jsonl",
      { owner: "unattributed" },
    ],
    [
      "an unknown tool",
      "missing",
      "ENOENT: /home/u/.pi/agent/sessions/x",
      { owner: "unattributed" },
    ],
    ["a relative source path", "relative", "boom", { owner: "unattributed" }],
    ["an ordinary built-in failure", "bash", "make: *** [all] Error 2", { owner: "unattributed" }],
  ])("attributes %s", (_name, tool, error, expected) => {
    expect(attribution().forSignal(tool, error)).toStrictEqual(expected);
  });

  test("leaves Claude paths unattributed when pi-claude is not installed", () => {
    const owners = attribution({ ownPackages: ["pi-web"] });
    expect(owners.forSignal("bash", "/tmp/claude-501/x/scratchpad/a: ENOENT")).toStrictEqual({
      owner: "unattributed",
    });
  });

  test("does not read an agent directory outside home as a home path", () => {
    const owners = attribution({ agentDir: "/srv/agent" });
    expect(owners.forSignal("read", "ENOENT: /srv/agent/sessions/x.jsonl")).toStrictEqual({
      owner: "unattributed",
      evidence: "pi-path",
    });
  });
});

describe("Pi paths named in an error", () => {
  test.each([
    [
      "a path under the sessions directory",
      "ENOENT: /home/u/.pi/agent/sessions/x.jsonl.",
      ["/home/u/.pi/agent/sessions/x.jsonl"],
    ],
    [
      "a path written from home",
      "ls: cannot access '~/.pi/agent/sessions/x': Permission denied",
      ["/home/u/.pi/agent/sessions/x"],
    ],
    [
      "a session directory name",
      "ls: unrecognized option '--home-u-dev-x--'",
      ["/home/u/.pi/agent/sessions/--home-u-dev-x--"],
    ],
    [
      "a session directory inside the sessions path",
      "EACCES: /home/u/.pi/agent/sessions/--home-u-dev-x--/a.jsonl",
      [
        "/home/u/.pi/agent/sessions/--home-u-dev-x--/a.jsonl",
        "/home/u/.pi/agent/sessions/--home-u-dev-x--",
      ],
    ],
    ["no Pi path", "make: *** [all] Error 2", []],
    [
      "a path that leaves the sessions directory",
      "ENOENT: /home/u/.pi/agent/sessions/../auth.json",
      [],
    ],
  ])("lists %s", (_name, text, expected) => {
    expect(attribution().piPathsIn(text)).toStrictEqual(expected);
  });
});

describe("report owner", () => {
  test.each([
    ["an extension named first", "pi-web: webfetch", "", { owner: "pi-web" }],
    ["an extension's command", "/skills", "", { owner: "pi-skills" }],
    ["an extension's command with an argument", "/skills project", "", { owner: "pi-skills" }],
    ["a bare word that is also a command name", "skills", "", { owner: "unattributed" }],
    ["a bare command word with more words", "skills menu", "", { owner: "unattributed" }],
    ["a command this repository does not own", "/skill:tidy", "", { owner: "unattributed" }],
    ["a Pi command", "/compact", "", { owner: "unattributed" }],
    ["a tool our extension registered", "webfetch", "", { owner: "pi-web" }],
    ["a skill outside this repository", "tidy", "", { owner: "unattributed" }],
    ["an instruction file", "AGENTS.md", "", { owner: "unattributed" }],
    [
      "a built-in tool and a Pi path",
      "read",
      "ENOENT: /home/u/.pi/agent/sessions/x",
      { owner: "unattributed", evidence: "pi-path" },
    ],
    [
      "a built-in tool and a Claude path",
      "bash",
      "/tmp/claude-501/x/scratchpad/a: ENOENT",
      { owner: "pi-claude" },
    ],
  ])("attributes %s", (_name, component, actual, expected) => {
    expect(attribution().forReport(component, actual)).toStrictEqual(expected);
  });
});
