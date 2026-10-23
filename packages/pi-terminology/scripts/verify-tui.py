#!/usr/bin/env python3
"""Isolated real pinned-Pi TUI verification. Slash commands only; no model prompts.

Evidence is retained in /tmp; the owned tmux server and disposable profile are removed.
Does not load or score recognition/answer fixtures. Requires Node, tmux, installed deps.
"""
import hashlib
import json
import re
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time
import traceback

REPO = Path(__file__).resolve().parents[3]
PACKAGE = REPO / "packages/pi-terminology"


def main():
    evidence = Path(tempfile.mkdtemp(prefix="pi-terminology-evidence-", dir="/tmp"))
    scratch = Path(tempfile.mkdtemp(prefix="pi-terminology-state-", dir="/tmp"))
    socket = str(scratch / "tmux.sock")
    actions, launches, passed = [], [], []
    env = {"HOME": str(scratch / "home"), "PI_CODING_AGENT_DIR": str(scratch / "agent"),
           "TMPDIR": str(scratch / "tmp"), "PATH": os.environ["PATH"], "SHELL": "/bin/sh",
           "TERM": "xterm-256color", "NODE_DISABLE_COMPILE_CACHE": "1", "PI_OFFLINE": "1",
           "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"}
    tmux, node = shutil.which("tmux"), shutil.which("node")
    session = "verify"
    counter = 0
    failure = None
    root_mode = False

    def save(name, data):
        (evidence / name).write_text(json.dumps(data, indent=2) + "\n")

    def t(*args, check=True):
        return subprocess.run([tmux, "-S", socket, *args], env=env, text=True,
                              capture_output=True, check=check, timeout=20)

    def record(kind, value):
        actions.append({"time": time.time(), "session": session, "kind": kind, "value": value})
        save("actions.json", actions)

    def capture(label):
        text = t("capture-pane", "-p", "-t", session + ":0.0").stdout
        (evidence / (label + ".txt")).write_text(text)
        assert "Extension errors" not in text, text
        assert "Unhandled" not in text, text
        return text

    def wait(label, needles, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            text = capture(label)
            if all(needle in text for needle in needles):
                return text
            time.sleep(.15)
        raise AssertionError(f"{label}: missing {needles!r}; see {evidence}")

    def key(name):
        record("key", name)
        t("send-keys", "-t", session + ":0.0", name)
        time.sleep(.22)

    def command(text):
        assert text.startswith("/terminology"), "Only terminology slash commands are allowed"
        record("command", text)
        t("send-keys", "-t", session + ":0.0", "-l", text)
        time.sleep(.18)
        key("Escape")  # Dismiss completion, not the editor text.
        key("Enter")
        pane = capture("latest-command")
        if any(line.rstrip() == text for line in pane.splitlines()):
            key("Enter")

    def launch(label):
        nonlocal session, counter
        counter += 1
        session = "verify" + str(counter)
        record("launch", label)
        launches.append({"label": label, "argv": argv, "cwd": str(scratch / "cwd")})
        save("launches.json", launches)
        shell = shlex.join(["env", "-i", *[k + "=" + v for k, v in env.items()], *argv])
        t("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "180", "-y", "50",
          "-c", str(scratch / "cwd"), shell)
        wait(label + "-startup", ["Extensions", "pi-terminology"])

    def stop():
        record("stop-owned-session", session)
        t("kill-session", "-t", session, check=False)

    def discover(label):
        # Real completion search: only types text and clears it; never submits an unknown command.
        record("completion-search", "/terminology-")
        t("send-keys", "-t", session + ":0.0", "-l", "/terminology-")
        time.sleep(.5)
        pane = capture(label)
        assert "terminology-" in pane, "Completion must offer terminology-* commands\n" + pane
        assert not re.search(r"/terms|terms-", pane), "Legacy terms commands must not be offered\n" + pane
        key("Escape")
        if root_mode:
            # The bundled Vim editor enters Normal mode and moves left on Escape.
            # Clear the complete line via real Vim keys, then return to Insert.
            key("0")
            key("D")
            key("i")
        else:
            key("C-u")

    def status(label):
        command("/terminology-status")
        return wait(label, ["51 concepts", "automatic reminders disabled", "Mode: tui",
                            "not configured", "not ready"])

    state = scratch / "agent/pi-terminology.json"
    try:
        assert tmux and node, "Node and tmux are required"
        for directory in ["home", "agent", "tmp", "cwd"]:
            (scratch / directory).mkdir()
        (scratch / "agent/settings.json").write_text(json.dumps(
            {"packages": [], "cacheWarming": "off", "theme": "dark"}))
        name = "@earendil-works/pi-coding-agent"
        pin = json.loads((REPO / "package.json").read_text())["devDependencies"][name]
        manifest = json.loads((REPO / "node_modules" / name / "package.json").read_text())
        assert pin == manifest["version"] == "1.3.0", "This journey requires pinned Pi 1.3.0"
        cli = (REPO / "node_modules" / name / manifest["bin"]["pi"]).resolve()
        guard = scratch / "000-guard.ts"
        env["TERMINOLOGY_GUARD_LOG"] = str(evidence / "guard.jsonl")
        guard.write_text(r'''import { appendFileSync } from "node:fs";
export default function(pi: any) {
  const log = (kind: string, detail?: any) => appendFileSync(process.env.TERMINOLOGY_GUARD_LOG!, JSON.stringify({kind, detail})+"\n");
  const deny = (kind: string) => (..._args: any[]) => { log(kind); throw new Error("Offline command verification forbids " + kind); };
  globalThis.fetch = deny("fetch") as any;
  pi.on("session_start", (_event: any, ctx: any) => {
    for (const method of ["classify", "stream", "streamSimple", "complete", "completeSimple", "generateImages"]) {
      Object.defineProperty(ctx.modelRegistry, method, {value: deny(method), writable:false, configurable:false});
    }
    log("installed", {commands: pi.getCommands().map((c:any)=>c.name).filter((n:string)=>/^(term|terms|terminology)($|-)/.test(n))});
  });
  pi.on("input", () => { log("model-input-blocked"); return {action:"handled"}; });
  pi.on("before_provider_request", deny("provider-request"));
  pi.on("cache_warming_decision", () => ({action:"stop"}));
}
''')
        (evidence / "guard.ts").write_bytes(guard.read_bytes())
        argv = [node, str(cli), "--no-extensions", "-e", str(guard), "-e", str(PACKAGE / "index.ts"),
                "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates",
                "--no-themes", "--approve", "--offline", "--no-session", "--verbose",
                "--tui-mode", "regular"]
        version = subprocess.run([node, str(cli), "--version"], env=env, text=True,
                                 capture_output=True, check=True, timeout=20).stdout.strip()
        assert version == pin, version
        save("environment.json", env)
        sources = [*PACKAGE.glob("*.ts"), *PACKAGE.glob("glossary/*.json"), Path(__file__),
                   REPO / "package.json", cli]
        hashes = {str(p.relative_to(REPO)) if p.is_relative_to(REPO) else str(p):
                  hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(sources)}
        save("source-hashes.json", hashes)
        concepts = json.loads((PACKAGE / "glossary/core.json").read_text())["concepts"]
        assert len(concepts) == 51
        # Definitions-only metadata; baseline is the ten concepts preceding deep-module.
        baseline = next(i for i, c in enumerate(concepts) if c["id"] == "core:deep-module")
        expanded = concepts[baseline:]
        assert len(expanded) == 41
        launch("fresh")
        discover("command-discovery")
        status("fresh-status")
        command("/terminology-auth-refresh")
        wait("missing-auth", ["Terminology classifier authentication is not ready."])
        command("/terminology")
        wait("all-entries", ["Terminology browser", "All entries: 51 of 51.", "Domain:", "Source:"])
        key("Down")
        wait("arrow-down", ["accidental complexity (core:accidental-complexity)"])
        key("Up")
        wait("arrow-up", ["ablation study (core:ablation-study)"])
        key("Escape")
        for i, concept in enumerate(expanded):
            command("/terminology " + concept["label"])
            label = f"term-{i+1:02d}"
            pane = wait(label, ["Terminology browser", "of 51."])
            target = concept["label"] + " (" + concept["id"] + ")"
            for _ in range(51):
                if any(line.startswith(target) for line in pane.splitlines()):
                    break
                key("Down")
                pane = capture(label)
            else:
                raise AssertionError(f"Canonical query did not offer {target}")
            pane = wait(label, [target, "Domain: " + concept["domain"]])
            assert "0 of 51." not in pane, pane
            key("C-End")
            pane = wait(label + "-source", ["Source:"])
            assert " ".join(concept["references"][0]["title"].split()) in " ".join(pane.split()), pane
            key("Escape")  # clear
            wait("clear-search", ["All entries: 51 of 51."])
            key("Escape")  # close
        passed.append("41 new canonical queries: positive counts, exact ID, domain and source title")
        aliases = [(c, a) for c in expanded for a in c.get("alternativeLabels", [])]
        for i, (concept, alias) in enumerate(aliases):
            command("/terminology " + alias)
            wait(f"alias-{i+1:02d}", [concept["id"], "of 51.", "Aliases:"])
            key("Escape")
            key("Escape")
        save("queried-aliases.json", [{"id": c["id"], "alias": a} for c, a in aliases])
        passed.append(f"all {len(aliases)} actually published new aliases")
        command("/terminology deep module")
        wait("related-before", ["deep module (core:deep-module)"])
        key("Enter")
        wait("related-after", ["information hiding (core:information-hiding)", "All entries: 51 of 51."])
        key("Escape")
        wait("related-back", ["deep module (core:deep-module)", "Matches for"])
        key("Escape")
        wait("related-clear", ["All entries: 51 of 51."])
        record("resize", "60x28")
        t("resize-window", "-t", session, "-x", "60", "-y", "28")
        wait("narrow-all", ["All entries: 51 of 51.", "Terminology browser"])
        key("Escape")
        command("/terminology deep module")
        wait("narrow-query", ["core:deep-module", "Domain: software design"])
        key("C-Down")
        capture("narrow-scroll-down")
        key("C-End")
        wait("narrow-source", ["Source: John Ousterhout: Method length"])
        key("C-Home")
        wait("narrow-details-home", ["deep module (core:deep-module)", "Domain: software design"])
        key("Escape")
        key("Escape")
        record("resize", "180x50")
        t("resize-window", "-t", session, "-x", "180", "-y", "50")
        passed.append("real arrow navigation, Enter related, Escape back/clear/close, resize 60x28")
        record("resize", "60x28 all new concepts")
        t("resize-window", "-t", session, "-x", "60", "-y", "28")
        for i, concept in enumerate(expanded):
            command("/terminology " + concept["label"])
            label = f"narrow-term-{i+1:02d}"
            pane = wait(label, ["Terminology browser", "of 51."])
            target = concept["label"] + " (" + concept["id"] + ")"
            for _ in range(51):
                if target in " ".join(pane.split()):
                    break
                key("Down")
                pane = capture(label)
            else:
                raise AssertionError(f"Narrow canonical query did not offer {target}")
            assert "Domain: " + concept["domain"] in pane, pane
            key("C-End")
            pane = wait(label + "-source", ["Source:"])
            assert " ".join(concept["references"][0]["title"].split()) in " ".join(pane.split()), pane
            key("Escape")
            key("Escape")
        passed.append("all 41 new concepts also at 60x28: domain and Ctrl+End source title")
        record("resize", "180x50")
        t("resize-window", "-t", session, "-x", "180", "-y", "50")
        command("/terminology-hide core:deep-module")
        capture("hidden")
        assert "core:deep-module" in json.loads(state.read_text())["hiddenConceptIds"]
        save("hidden-state.json", json.loads(state.read_text()))
        stop()
        launch("hidden-restart")
        assert "core:deep-module" in json.loads(state.read_text())["hiddenConceptIds"]
        before = state.read_bytes()
        status("hidden-restart-status")
        assert state.read_bytes() == before, "Status must preserve preference bytes"
        command("/terminology-restore core:deep-module")
        capture("restored")
        assert "core:deep-module" not in json.loads(state.read_text())["hiddenConceptIds"]
        restored = state.read_bytes()
        save("restored-state.json", json.loads(restored))
        stop()
        launch("restored-restart")
        status("restored-restart-status")
        assert state.read_bytes() == restored
        passed.append("hide/restore commands persist across fresh processes; status preserves preference bytes")
        stop()
        # Deliberately corrupt ONLY the disposable profile; never any real user state.
        corrupt = b"{deliberately invalid JSON\n"
        assert scratch in state.parents
        state.write_bytes(corrupt)
        launch("corrupt")
        status("corrupt-status")
        wait("corrupt-warning", ["state could not be read", "has not been overwritten"])
        command("/terminology")
        wait("corrupt-browser", ["All entries: 51 of 51.", "Domain:", "Source:"])
        key("Escape")
        assert state.read_bytes() == corrupt, "Corrupt state bytes must not be reset"
        auth_path = scratch / "agent/auth.json"
        auth = json.loads(auth_path.read_text()) if auth_path.exists() else {}
        assert auth == {}, "Journey must not persist credentials"
        save("auth-storage.json", {"exists": auth_path.exists(), "credentials": auth})
        passed.append("invalid JSON: warning, disabled status, built-in 51 browser; exact bad bytes untouched")
        stop()
        record("fixture-state", "restore known healthy state in disposable profile only")
        state.write_bytes(restored)
        argv = [str(REPO) if arg == str(PACKAGE / "index.ts") else arg for arg in argv]
        root_mode = True
        launch("root-package")
        wait("root-package-loaded", ["pi-terminology", "pi-claude-sdk", "pi-auto-resume",
                                     "pi-caffeinate", "pi-skill-toggle", "pi-vim", "pi-web-tools"])
        discover("root-command-discovery")
        status("root-package-status")
        command("/terminology")
        wait("root-package-browser", ["Terminology browser", "All entries: 51 of 51."])
        key("Escape")
        save("root-package-manifest.json", json.loads((REPO / "package.json").read_text())["pi"])
        passed.append("root manifest loads all seven extensions; terminology browser/status work with preview off and zero classifier calls")
        rows = [json.loads(line) for line in (evidence / "guard.jsonl").read_text().splitlines()]
        assert rows and all(r["kind"] == "installed" for r in rows), "Forbidden provider/input/network activity"
        catalogs = [r["detail"]["commands"] for r in rows]
        expected = sorted(["terminology", *["terminology-" + suffix for suffix in
                          ("preview", "status", "approve", "auth-refresh", "hide", "restore", "dismiss")]])
        assert all(sorted(c) == expected for c in catalogs), catalogs
        save("command-catalog.json", catalogs)
        save("counters.json", {"guardInstallations": len(rows), "classifierCalls": 0,
                              "modelInputs": 0, "networkCalls": 0, "nativeInferenceVerified": False})
        changed = [str(p) for p in sources if hashes[str(p.relative_to(REPO)) if p.is_relative_to(REPO)
                   else str(p)] != hashlib.sha256(p.read_bytes()).hexdigest()]
        assert not changed, f"Sources changed during run; rerun frozen sources: {changed}"
    except Exception:
        failure = traceback.format_exc()
        (evidence / "failure.txt").write_text(failure)
    finally:
        if tmux:
            t("kill-server", check=False)
        shutil.rmtree(scratch)
        save("result.json", {"viewports": {"normal": "180x50", "narrow": "60x28"}, "commandPrefix": "/terminology", "legacyCommandsAbsent": failure is None,
             "warnings": ["Narrow 60x28 metadata is only as strong as the passed list; a failure invalidates both viewports."], "result": "failed" if failure else "passed", "passed": passed,
             "failure": failure, "scratchRemoved": not scratch.exists(),
             "limitations": ["No model prompts, classifier evaluation or HTTP traffic capture.",
                             "No held-out fixtures read; offline CLI plus allowlisted credential-free profile.",
                             "Source visibility verified via real Ctrl+End; narrow checks include source and Ctrl+Home reset."]})
        print(str(evidence), flush=True)
    if failure:
        raise SystemExit(failure)


if __name__ == "__main__":
    main()
