#!/usr/bin/env python3
"""Drive only an owned, isolated real Pi TUI; never submit a model prompt."""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import traceback


REPO = Path(__file__).resolve().parents[4]
EXTENSION = REPO / "packages/pi-skill-toggle/index.ts"
# Verify the exact Pi the package is developed and type-checked against (the pinned devDependency),
# not whichever global `pi` happens to be on PATH.
PI_PACKAGE = REPO / "node_modules/@earendil-works/pi-coding-agent"
FEATURES = ["menu", "changes", "scope"]
HELP = "Esc clear search, then close"
# The single key hint replaces SettingsList's own "Esc to cancel" hint; it must never reappear.
HINT = "Enter toggle \u00b7 " + HELP + " \u00b7 type to search \u00b7 Space toggle (empty search)"
STALE_HINT = "Esc to cancel"


def pinned_pi_version():
    """The exact root devDependency pin, so a dependency bump needs no edit here."""
    pinned = json.loads((REPO / "package.json").read_text())["devDependencies"]["@earendil-works/pi-coding-agent"]
    assert pinned and pinned[0].isdigit() and all(part.isdigit() for part in pinned.split(".")), \
        f"Root devDependency must pin an exact Pi version, got {pinned!r}"
    return pinned


def clean_env(home, agent, temporary):
    return {"HOME": str(home), "PI_CODING_AGENT_DIR": str(agent),
            "TMPDIR": str(temporary), "PATH": os.environ["PATH"],
            "SHELL": "/bin/sh", "TERM": "xterm-256color",
            "NODE_DISABLE_COMPILE_CACHE": "1", "PI_OFFLINE": "1",
            "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"}


def pi_command():
    """argv prefix for the checkout's pinned Pi CLI, run by Node (no global `pi`)."""
    manifest = json.loads((PI_PACKAGE / "package.json").read_text())
    entry = (PI_PACKAGE / manifest["bin"]["pi"]).resolve()
    assert entry.is_file(), f"Missing Pi CLI entry {entry}; run npm install"
    return [shutil.which("node"), str(entry)], manifest["version"]


def doctor():
    """Read-only: no sessions, fixture directories, package installs, or settings writes."""
    tools = {name: shutil.which(name) for name in ["python3", "node", "git", "tmux"]}
    assert all(tools.values()), f"Missing dependencies: {tools}"
    assert (PI_PACKAGE / "package.json").is_file(), "Run npm install first (Pi devDependency missing)"
    command, declared = pi_command()
    env = clean_env("/var/empty", "/var/empty/pi-verification-unused", "/tmp")
    version = subprocess.run([*command, "--version"], env=env, text=True,
                             capture_output=True, check=True, timeout=20).stdout.strip()
    pinned = pinned_pi_version()
    assert version == declared == pinned, \
        f"Expected the pinned Pi {pinned}; CLI reports {version}, installed package {declared}; run npm install"
    assert EXTENSION.is_file(), str(EXTENSION)
    assert (REPO / "node_modules/@earendil-works/pi-tui").is_dir(), "Run npm install first"
    # A global `pi` is reported only so a version mismatch is visible; it is never executed.
    return {"version": version, "pinnedVersion": pinned, "piCommand": command, "globalPiOnPathNotUsed": shutil.which("pi"),
            "tools": tools, "extension": str(EXTENSION), "readOnly": True, "modelRequests": "not issued"}


class Run:
    def __init__(self, feature):
        self.feature = feature
        self.evidence = Path(tempfile.mkdtemp(prefix="pi-skill-toggle-evidence-", dir="/tmp"))
        self.scratch = Path(tempfile.mkdtemp(prefix="pi-skill-toggle-state-", dir="/tmp")).resolve()
        self.socket = str(self.scratch / "tmux.sock")
        self.actions = []
        self.pids = set()
        self.session = None
        self.counter = 0
        self.wide = True  # The full hint fits (and is asserted verbatim) only at 120 columns.
        self.results = {name: "not executed" for name in [*FEATURES, "guard"]}
        self.results["guard"] = "not executed: no model prompts/tool calls; see feature map"
        self.failure = None
        self.env = clean_env(self.scratch / "home", self.scratch / "agent", self.scratch / "tmp")
        self.manifest = {"scratch": str(self.scratch), "socket": self.socket,
                         "evidence": str(self.evidence), "launches": [], "environment": self.env}
        self.hashes = {}

    def save(self, name, value):
        (self.evidence / name).write_text(json.dumps(value, indent=2) + "\n")

    def action(self, kind, value):
        self.actions.append({"time": time.time(), "session": self.session, "action": kind, "value": value})
        self.save("actions.json", self.actions)

    def tmux(self, *args, check=True):
        return subprocess.run([shutil.which("tmux"), "-S", self.socket, *args],
                              env=self.env, text=True, capture_output=True, check=check, timeout=20)

    def git(self, cwd, *args):
        # Never load host Git config, signing programs, hooks, credentials, or package sources.
        env = {**self.env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        return subprocess.run([shutil.which("git"), "-c", "core.hooksPath=/dev/null", "-C", str(cwd), *args],
                              env=env, text=True, capture_output=True, check=True, timeout=20).stdout.strip()

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def fixture(self):
        for name in ["home", "agent", "tmp", "main", "other"]:
            (self.scratch / name).mkdir()
        self.write(self.scratch / "agent/settings.json", json.dumps({
            "packages": [], "cacheWarming": "off", "theme": "dark",
            "defaultProjectTrust": "never", "enableInstallTelemetry": False}))
        self.write(self.scratch / "agent/AGENTS.md", "# Verification global instructions\nGlobal fixture; do not call any provider.\n")
        self.seed_skill(self.scratch / "agent/skills", "verify-global")
        for name in ["main", "other"]:
            root = self.scratch / name
            self.git(root, "init", "-b", "verification")
            for path in ["AGENTS.md", "web/agent/AGENTS.md", "api/CLAUDE.md"]:
                self.write(root / path, f"# Verification instructions: {path}\nDisposable fixture.\n")
            self.seed_skill(root / ".agents/skills", "verify-project")
            self.seed_skill(root / ".agents/skills", "verify-manual", manual=True)
            self.git(root, "add", ".")
            self.git(root, "-c", "user.name=Verification", "-c", "user.email=verification@example.invalid",
                     "-c", "commit.gpgsign=false", "commit", "-m", "Disposable verification fixture")
        self.git(self.scratch / "main", "worktree", "add", "-b", "verification-linked", str(self.scratch / "linked"))
        self.common = Path(self.git(self.scratch / "main", "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()
        for ancestor in self.scratch.parents:
            for name in ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]:
                assert not (ancestor / name).exists(), f"Unexpected ancestor context: {ancestor / name}"
        for root in [self.scratch / "agent", *(self.scratch / n for n in ["main", "linked", "other"])]:
            for path in root.rglob("*.md"):
                self.hashes[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.save("fixture.json", {"commonGitDir": str(self.common), "resourceHashes": self.hashes,
                                   "setup": "Two disposable Git repositories; one linked worktree; synthetic instructions and skills"})
        self.save("source.json", {str(path.relative_to(REPO)): hashlib.sha256(path.read_bytes()).hexdigest()
                  for path in [Path(__file__).resolve(), *sorted(EXTENSION.parent.glob("*.ts"))]})

    def seed_skill(self, root, name, manual=False):
        self.write(root / name / "SKILL.md", f"---\nname: {name}\ndescription: Verification {name} skill fixture.\n" +
                   ("disable-model-invocation: true\n" if manual else "") + "---\n\n# Fixture\nNever call a provider.\n")
        self.write(root / name / "references/fixture.md", "# Reference fixture\nDisposable supporting file.\n")

    def screen(self, label):
        text = self.tmux("capture-pane", "-p", "-t", self.session).stdout
        ansi = self.tmux("capture-pane", "-e", "-p", "-t", self.session).stdout
        (self.evidence / (label + ".txt")).write_text(text)
        (self.evidence / (label + ".ansi.txt")).write_text(ansi)
        # A portable image of actual captured cells, not a claim of an OS screenshot.
        lines = text.splitlines()
        width = max([len(line) for line in lines] + [60]) * 9 + 24
        svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{len(lines)*18+24}">',
               '<rect width="100%" height="100%" fill="#151515"/>',
               '<g font-family="monospace" font-size="14" fill="#eeeeee" xml:space="preserve">']
        svg.extend(f'<text x="12" y="{20+i*18}">{html.escape(line)}</text>' for i, line in enumerate(lines))
        (self.evidence / (label + ".svg")).write_text("\n".join([*svg, "</g></svg>"]))
        assert "Extension errors" not in text and "TypeError:" not in text, text
        return text

    def wait(self, label, needle, timeout=25):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            text = self.screen(label)
            if needle in text:
                return text
            time.sleep(.15)
        raise AssertionError(f"{label}: missing {needle!r}; evidence: {self.evidence}")

    def key(self, key):
        self.action("key", key)
        self.tmux("send-keys", "-t", self.session, key)
        time.sleep(.25)

    def type(self, text):
        self.action("literal", text)
        self.tmux("send-keys", "-t", self.session, "-l", text)
        time.sleep(.25)

    def command(self, text):
        assert text in ["/skill-toggle", "/skill-toggle unexpected", "/reload", "/quit"], "No prompts allowed"
        self.type(text)
        self.key("Escape")  # Dismiss slash-command completion before submitting.
        self.key("Enter")
        time.sleep(.35)
        if text != "/quit":
            pane = self.tmux("capture-pane", "-p", "-t", self.session).stdout
            if any(line.rstrip() == text for line in pane.splitlines()):
                self.key("Enter")

    def launch(self, directory="main", width=120, height=45):
        self.counter += 1
        self.wide = width >= 120
        self.session = "verify" + str(self.counter)
        argv = [*pi_command()[0], "--no-extensions", "-e", str(EXTENSION), "--no-mcp",
                "--no-prompt-templates", "--no-themes", "--approve", "--offline",
                "--no-session", "--verbose", "--tui-mode", "regular"]
        self.manifest["launches"].append({"session": self.session, "cwd": str(self.scratch / directory),
                                          "argv": argv, "size": [width, height]})
        self.save("launch.json", self.manifest)
        self.tmux("-f", "/dev/null", "new-session", "-d", "-s", self.session,
                  "-x", str(width), "-y", str(height), "-c", str(self.scratch / directory),
                  "env", "-i", *[k + "=" + v for k, v in self.env.items()], *argv)
        self.pids.add(int(self.tmux("display-message", "-p", "-t", self.session, "#{pane_pid}").stdout))
        self.tmux("set-option", "-t", self.session, "history-limit", "20000")
        self.tmux("pipe-pane", "-o", "-t", self.session,
                  "exec /bin/cat >> " + str(self.evidence / (self.session + ".terminal.log")))
        startup = self.wait(self.session + "-startup", "Extensions")
        assert "pi-skill-toggle" in startup, startup
        # Instance doctor reads only pane metadata and state. It cannot fix or toggle anything.
        before = self.state_bytes()
        metadata = self.tmux("list-panes", "-t", self.session, "-F", "#{pane_pid} #{pane_current_command} #{pane_dead}").stdout
        assert metadata.rstrip().endswith(" 0"), metadata
        self.save(self.session + "-doctor.json", {"dependencyDoctor": doctor(), "pane": metadata,
                  "cwd": str(self.scratch / directory), "stateUnchanged": before == self.state_bytes()})
        assert before == self.state_bytes(), "Doctor mutated state"
        return startup

    def open(self, label):
        self.command("/skill-toggle")
        return self.wait(label, "Skill Toggle")

    def filter(self, query, label):
        self.key("C-u")
        self.type(query)
        return self.screen(label)

    def row(self, text, label, value):
        lines = [line for line in text.splitlines() if label in line and value in line]
        assert lines, f"Expected row {label!r} with {value!r}:\n{text}"
        return lines[0]

    def state_bytes(self):
        path = self.scratch / "agent/pi-skill-toggle.json"
        return path.read_bytes() if path.exists() else b""

    def state(self, label):
        raw = self.state_bytes()
        data = json.loads(raw) if raw else None
        self.save(label + ".state.json", {"path": str(self.scratch / "agent/pi-skill-toggle.json"), "state": data})
        return data

    def policy(self, label, *, project=None, instruction=None, global_skill=None):
        state = self.state(label)
        assert state and state["version"] == 7, f"Expected repository-wide v7 state, got {state}"
        assert "overrides" not in state, state
        files = state["files"]
        repositories = state["repositories"]
        entries = repositories.get(str(self.common), {})
        for relative, value in [(".agents/skills/verify-project/SKILL.md", project),
                                 ("web/agent/AGENTS.md", instruction)]:
            if value is not None:
                assert entries.get(relative) == value, (relative, value, state)
        if global_skill is not None:
            path = str(self.scratch / "agent/skills/verify-global/SKILL.md")
            assert files.get(path) == global_skill, state
        # No worktree-discovery paths masquerading as separate policies.
        assert not any(str(self.scratch / "linked") in key or str(self.scratch / "main") in key for key in files), state
        return state

    def scope_line(self, text, expected):
        """The selected row's description carries exactly one scope line (old duplicate is gone)."""
        lines = [line.strip() for line in text.splitlines()]
        assert expected in lines, f"Expected scope line {expected!r}:\n{text}"
        assert "Repository-wide: all worktrees" not in text, "Duplicated legacy scope line"
        return expected

    def clear_search(self, label, query, hidden):
        """Esc on a nonempty query must clear it and keep the menu open (not close)."""
        before = self.screen(label + "-before")
        rows = self.menu_lines(before)
        assert any(line.strip() == "> " + query for line in rows), f"Query {query!r} not active:\n{before}"
        assert not any(hidden in line for line in rows), f"Query was not filtering:\n{before}"
        self.key("Escape")
        text = self.screen(label)
        assert "Skill Toggle" in text, "Esc with an active search closed the menu instead of clearing it"
        rows = self.menu_lines(text)
        assert not any(line.strip() == "> " + query for line in rows), f"Query still present:\n{text}"
        # Every row returns, so the filtered-out row is visible again inside the menu.
        assert any(hidden in line for line in rows), f"Search was not cleared:\n{text}"
        assert STALE_HINT not in text, f"Contradictory {STALE_HINT!r} hint shown:\n{text}"
        if self.wide:
            self.single_hint(text)
        else:
            # Truncated at narrow width, but Enter and Esc lead the hint so they stay visible.
            assert "Enter toggle \u00b7 " + HELP in text, f"Narrow hint lost Esc:\n{text}"
        return text

    def single_hint(self, text):
        """Exactly one key-hint line inside the open menu, the accurate one; no 'Esc to cancel'."""
        rows = [line.strip() for line in self.menu_lines(text)]
        hints = [line for line in rows if "Esc" in line]
        assert hints == [HINT], f"Expected exactly one hint {HINT!r}, got {hints}:\n{text}"
        assert STALE_HINT not in text, f"Contradictory {STALE_HINT!r} hint shown:\n{text}"
        return hints[0]

    def menu_lines(self, text):
        """Only the open menu's cells: Pi's startup header also lists skill names."""
        lines = text.splitlines()
        starts = [i for i, line in enumerate(lines) if line.strip() == "Skill Toggle"]
        assert starts, f"Menu not open:\n{text}"
        region = lines[starts[-1]:]
        ends = [i for i, line in enumerate(region) if HELP in line]
        return region[:ends[0] + 1] if ends else region

    def close(self, label):
        """Esc with an empty query closes the menu."""
        self.key("Escape")
        text = self.screen(label)
        assert "Skill Toggle" not in text, "Escape did not return to the editor"

    def stop(self):
        self.command("/quit")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.tmux("has-session", "-t", self.session, check=False).returncode:
                self.session = None
                return
            time.sleep(.1)
        raise AssertionError("Owned Pi did not exit after /quit")

    def menu(self):
        self.launch()
        before = self.state_bytes()
        self.command("/skill-toggle unexpected")
        self.wait("menu-usage", "Usage: /skill-toggle")
        text = self.open("menu-normal")
        for label, value in [("AGENTS.md", "enabled"), ("verify-global", "enabled"),
                             ("verify-project", "disabled"), ("verify-manual", "manual only"),
                             ("web/agent/AGENTS.md", "enabled"), ("api/CLAUDE.md", "enabled")]:
            self.row(text, label, value)
        # Plain captured cells must communicate type and scope without ANSI colors.
        for kind in ["instruction", "skill"]:
            for scope in ["global", "project"]:
                assert any(scope in line.lower() and kind in line.lower() for line in text.splitlines()), (scope, kind, text)
        assert "worktree" in text.lower() or "repository" in text.lower(), "Missing repository-wide scope help"
        for word in ["enter", "space", "search", "esc"]:
            assert word in text.lower(), (word, text)
        self.single_hint(text)
        # The selected (first) row is the global instruction: one scope line, no duplicate.
        self.scope_line(text, "Global instruction \u00b7 this path only")
        line = self.row(text, "web/agent/AGENTS.md", "enabled")
        assert str(self.scratch) not in line, "Instruction label must be repository relative"
        text = self.filter("verify-project", "menu-search-match")
        self.row(text, "verify-project", "disabled")
        self.single_hint(text)
        self.scope_line(text, "Project skill \u00b7 repository-wide (all worktrees)")
        text = self.filter("web/agent/AGENTS.md", "menu-search-instruction")
        self.scope_line(text, "Project instruction \u00b7 repository-wide (all worktrees)")
        text = self.filter("verify-global", "menu-search-global-skill")
        self.scope_line(text, "Global skill \u00b7 this path only")
        text = self.filter("verify-manual", "menu-search-manual")
        self.scope_line(text, "Project skill \u00b7 repository-wide (all worktrees) \u00b7 Manual only (read-only)")
        assert not any("verify-global" in line and "enabled" in line for line in text.splitlines()), text
        text = self.filter("no-such-fixture-zzzz", "menu-search-empty")
        assert "No matching" in text, text
        self.single_hint(text)
        self.key("C-u")
        self.row(self.screen("menu-search-clear"), "verify-global", "enabled")
        self.close("menu-escape")
        assert before == self.state_bytes(), "Navigation or Escape wrote state"
        self.open("menu-before-resize")
        self.action("resize", [60, 28])
        self.tmux("resize-window", "-t", self.session, "-x", "60", "-y", "28")
        self.wide = False
        time.sleep(.6)
        text = self.screen("menu-narrow")
        self.row(text, "verify-project", "disabled")
        self.row(text, "verify-manual", "manual only")
        assert "Skill Toggle" in text and "esc" in text.lower(), text
        assert STALE_HINT not in text, f"Contradictory {STALE_HINT!r} hint shown:\n{text}"
        assert "Enter toggle \u00b7 " + HELP in text, f"Narrow hint lost Esc:\n{text}"
        self.filter("web/agent/AGENTS.md", "menu-narrow-instruction")
        self.row(self.screen("menu-narrow-instruction-result"), "web/agent/AGENTS.md", "enabled")
        text = self.filter("verify-manual", "menu-narrow-manual")
        self.row(text, "verify-manual", "manual only")
        assert "read-only" in text.lower(), "Selected narrow manual row must explain immutability"
        # Esc with an active query clears it and keeps the menu open; a second Esc closes.
        self.clear_search("menu-narrow-escape-clears-search", "verify-manual", hidden="verify-global")
        assert before == self.state_bytes(), "Esc clearing search changed state"
        self.close("menu-narrow-escape")
        assert before == self.state_bytes(), "Resize/search changed state"
        self.stop()
        self.results["menu"] = "passed: normal 120x45 and narrow 60x28, plain-text semantic labels"

    def changes(self):
        self.launch()
        self.open("changes-menu")
        original = self.state_bytes()
        text = self.filter("verify-manual", "changes-manual-before")
        self.row(text, "verify-manual", "manual only")
        self.key("Enter")
        self.row(self.screen("changes-manual-enter"), "verify-manual", "manual only")
        assert original == self.state_bytes(), "Manual-only Enter wrote state"
        # Space is a toggle only with empty search. Clear query, then find the row by visible selection.
        self.key("C-u")
        self.select_unfiltered("verify-manual", "manual only", "changes-manual-selected")
        self.key("Space")
        self.row(self.screen("changes-manual-space"), "verify-manual", "manual only")
        assert original == self.state_bytes(), "Manual-only Space wrote state"
        self.filter("verify-project", "changes-project-before")
        self.key("Enter")
        self.row(self.screen("changes-project-enter"), "verify-project", "enabled")
        self.policy("changes-project-immediate", project="enabled")
        # Observe persistence while the menu remains open, then Space on an unfiltered row.
        self.key("C-u")
        self.select_unfiltered("verify-global", "enabled", "changes-global-selected")
        self.key("Space")
        self.row(self.screen("changes-global-space"), "verify-global", "disabled")
        self.policy("changes-global-immediate", project="enabled", global_skill="disabled")
        self.filter("web/agent/AGENTS.md", "changes-instruction-before")
        self.key("Enter")
        self.row(self.screen("changes-instruction-enter"), "web/agent/AGENTS.md", "disabled")
        self.policy("changes-instruction-immediate", project="enabled", instruction="disabled", global_skill="disabled")
        self.clear_search("changes-escape-clears-search", "web/agent/AGENTS.md", hidden="verify-global")
        self.close("changes-escape")
        self.command("/reload")
        self.wait("changes-reload-result", "Reloaded")
        text = self.open("changes-after-reload")
        for label, value in [("verify-project", "enabled"), ("verify-global", "disabled"),
                             ("web/agent/AGENTS.md", "disabled")]:
            self.row(text, label, value)
        self.policy("changes-after-reload", project="enabled", instruction="disabled", global_skill="disabled")
        self.close("changes-reload-escape")
        self.stop()
        self.launch()
        text = self.open("changes-restart")
        for label, value in [("verify-project", "enabled"), ("verify-global", "disabled"),
                             ("web/agent/AGENTS.md", "disabled"), ("verify-manual", "manual only")]:
            self.row(text, label, value)
        self.policy("changes-restart", project="enabled", instruction="disabled", global_skill="disabled")
        self.close("changes-restart-escape")
        self.stop()
        self.results["changes"] = "passed: Enter/Space, manual-only immutable, immediate file persistence, reload, fresh-process restart"

    def select_unfiltered(self, label, value, artifact):
        for _ in range(20):
            text = self.screen(artifact)
            for line in text.splitlines():
                if label in line and value in line and (line.lstrip().startswith("→") or line.lstrip().startswith("❯") or line.lstrip().startswith(">")):
                    return
            self.key("Down")
        raise AssertionError(f"Could not select unfiltered {label}: {text}")

    def scope(self):
        # A scope-only drive still seeds mutations through the real menu, never an internal setter.
        if not self.results["changes"].startswith("passed"):
            self.changes()
        self.launch("linked")
        text = self.open("scope-linked-inherited")
        for label, value in [("verify-project", "enabled"), ("verify-global", "disabled"), ("web/agent/AGENTS.md", "disabled")]:
            self.row(text, label, value)
        self.filter("verify-project", "scope-linked-project-before")
        self.key("Enter")
        self.row(self.screen("scope-linked-project-reset"), "verify-project", "disabled")
        state = self.policy("scope-linked-project-immediate", instruction="disabled", global_skill="disabled")
        assert ".agents/skills/verify-project/SKILL.md" not in state["repositories"].get(str(self.common), {}), state
        self.filter("web/agent/AGENTS.md", "scope-linked-instruction-before")
        self.key("Enter")
        self.row(self.screen("scope-linked-instruction-reset"), "web/agent/AGENTS.md", "enabled")
        state = self.policy("scope-linked-reset-immediate", global_skill="disabled")
        assert not state["repositories"].get(str(self.common)), "Reset must remove policy, not leave a worktree override"
        self.clear_search("scope-linked-escape-clears-search", "web/agent/AGENTS.md", hidden="verify-global")
        self.close("scope-linked-escape")
        self.stop()
        self.launch("main")
        text = self.open("scope-main-after-linked-reset")
        for label, value in [("verify-project", "disabled"), ("verify-global", "disabled"), ("web/agent/AGENTS.md", "enabled")]:
            self.row(text, label, value)
        self.close("scope-main-escape")
        self.stop()
        self.launch("other")
        text = self.open("scope-unrelated-repository")
        self.row(text, "verify-project", "disabled")
        self.row(text, "verify-global", "disabled")
        self.row(text, "web/agent/AGENTS.md", "enabled")
        # Enable same relative path in another repo: it must not affect the original repository.
        self.filter("verify-project", "scope-other-project-before")
        self.key("Enter")
        self.row(self.screen("scope-other-project-enabled"), "verify-project", "enabled")
        state = self.policy("scope-other-immediate", global_skill="disabled")
        other_common = str(Path(self.git(self.scratch / "other", "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve())
        assert state["repositories"][other_common][".agents/skills/verify-project/SKILL.md"] == "enabled", state
        assert not state["repositories"].get(str(self.common)), state
        self.clear_search("scope-other-escape-clears-search", "verify-project", hidden="verify-global")
        self.close("scope-other-escape")
        self.stop()
        self.launch("main")
        text = self.open("scope-main-after-other-change")
        self.row(text, "verify-project", "disabled")
        self.row(text, "verify-global", "disabled")
        self.close("scope-main-final-escape")
        self.stop()
        self.results["scope"] = "passed: one canonical repository policy, linked reset propagates, unrelated repo isolated, globals shared"

    def check_side_effects(self):
        after = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in self.hashes}
        assert after == self.hashes, "Instruction or skill fixture was modified"
        auth = self.scratch / "agent/auth.json"
        assert not auth.exists() or json.loads(auth.read_text()) == {}, "Unexpected stored credentials"
        assert not (self.scratch / "agent/trust.json").exists(), "One-run approval must not save trust"
        self.save("side-effects.json", {"resourceHashesUnchanged": True, "credentialsAbsentOrEmpty": True,
                  "trustFileAbsent": True, "home": str(self.scratch / "home"), "agentDir": str(self.scratch / "agent"),
                  "note": "No user home inventory/read; clean environment and explicit paths prevent user settings access"})
        self.save("storage-metadata.json", [{"path": str(p.relative_to(self.scratch)), "bytes": p.stat().st_size,
                   "mode": oct(p.stat().st_mode & 0o777)} for p in sorted(self.scratch.rglob("*")) if p.is_file()])
        self.state("final")

    def cleanup(self):
        # Snapshot descendants of this run's panes only. No process-name kills or default socket.
        pairs = [tuple(map(int, line.split())) for line in subprocess.run(
            ["ps", "-axo", "pid=,ppid="], text=True, capture_output=True, check=True).stdout.splitlines()]
        while True:
            children = {pid for pid, parent in pairs if parent in self.pids}
            if children <= self.pids:
                break
            self.pids.update(children)
        self.tmux("kill-server", check=False)
        def alive():
            live = []
            for pid in self.pids:
                result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], text=True, capture_output=True)
                if result.returncode == 0 and result.stdout.strip() and not result.stdout.strip().startswith("Z"):
                    live.append(pid)
            return live
        for sig in [None, signal.SIGTERM, signal.SIGKILL]:
            if sig:
                for pid in alive():
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + 5
            while alive() and time.monotonic() < deadline:
                time.sleep(.1)
            if not alive():
                break
        stopped = self.tmux("list-sessions", check=False).returncode != 0
        errors = []
        processes_stopped = not alive()
        if stopped and processes_stopped:
            for attempt in range(5):
                try:
                    shutil.rmtree(self.scratch)
                    break
                except FileNotFoundError:
                    break
                except OSError as error:
                    if attempt == 4:
                        errors.append(str(error))
                    time.sleep(.3)
        if not stopped or not processes_stopped:
            errors.append("Owned tmux server or descendants remain")
        if self.scratch.exists():
            errors.append("Scratch remains: " + str(self.scratch))
        self.save("result.json", {"status": "failed" if self.failure or errors else "passed", "feature": self.feature,
                  "features": self.results, "failure": self.failure, "serverStopped": stopped,
                  "ownedProcessesStopped": processes_stopped, "ownedPids": sorted(self.pids),
                  "scratchRemoved": not self.scratch.exists(), "cleanupErrors": errors})
        # Evidence lives outside scratch; explicitly prove it survives teardown.
        assert (self.evidence / "result.json").is_file() and (self.evidence / "launch.json").is_file()
        assert not errors, errors

    def drive(self):
        print(self.evidence, flush=True)
        self.save("launch.json", self.manifest)
        try:
            self.save("dependency-doctor.json", doctor())
            self.fixture()
            for feature in FEATURES if self.feature == "all" else [self.feature]:
                self.results[feature] = "running"
                getattr(self, feature)()
            self.check_side_effects()
        except BaseException as error:
            self.failure = f"{type(error).__name__}: {error}"
            for feature, result in self.results.items():
                if result == "running":
                    self.results[feature] = "failed: " + self.failure
            (self.evidence / "failure.txt").write_text(traceback.format_exc())
            if self.session:
                try:
                    self.screen("failure-screen")
                    self.state("failure")
                except Exception:
                    pass
            raise
        finally:
            self.cleanup()
            print("Evidence survives cleanup: " + str(self.evidence), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["doctor", "drive"])
    parser.add_argument("--feature", choices=["all", *FEATURES], default="all")
    args = parser.parse_args()
    if args.mode == "doctor":
        print(json.dumps(doctor(), indent=2))
    else:
        Run(args.feature).drive()


if __name__ == "__main__":
    main()
