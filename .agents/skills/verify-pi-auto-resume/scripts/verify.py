#!/usr/bin/env python3
"""Exercise checkout-pinned Pi CLI with an entirely synthetic offline provider."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["all"], nargs="?", default="all")
    parser.parse_args()
    skill = Path(__file__).resolve().parents[1]
    repo = skill.parents[2]
    evidence = Path(tempfile.mkdtemp(prefix="pi-auto-resume-evidence-", dir="/tmp"))
    scratch = Path(tempfile.mkdtemp(prefix="pi-auto-resume-state-", dir="/tmp"))
    print(f"Evidence: {evidence}", flush=True)
    socket = str(scratch / "tmux.sock")
    node, tmux = shutil.which("node"), shutil.which("tmux")
    launches, actions, cases = [], [], {}
    result = {"status": "failed"}
    expected = None
    owned_pids = set()

    def t(*args, check=True):
        return subprocess.run([tmux, "-S", socket, *args], capture_output=True, text=True, check=check)

    def setup(name, scenario):
        state = scratch / name
        for part in ["home", "agent", "cwd", "tmp"]:
            (state / part).mkdir(parents=True)
        (state / "agent/settings.json").write_text(json.dumps({
            "packages": [], "cacheWarming": "off", "theme": "dark",
            "retry": {"enabled": False}, "compaction": {"enabled": False}}))
        env = {"HOME": str(state / "home"), "PI_CODING_AGENT_DIR": str(state / "agent"),
               "TMPDIR": str(state / "tmp"), "PATH": os.environ["PATH"], "TERM": "xterm-256color",
               "NODE_DISABLE_COMPILE_CACHE": "1", "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1",
               "PI_TELEMETRY": "0", "RESUME_SCENARIO": scenario,
               "RESUME_RECORD": str(evidence / (name + "-requests.jsonl"))}
        return state, env

    def capture(name, label):
        text = t("capture-pane", "-p", "-t", name).stdout
        (evidence / f"{name}-{label}.txt").write_text(text)
        assert "Extension errors" not in text, text
        return text

    def wait(name, label, needle, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            text = capture(name, label)
            if needle in text:
                return text
            time.sleep(.2)
        raise AssertionError(f"{name}/{label}: missing {needle!r}")

    def send(name, text):
        actions.append({"case": name, "at": time.time(), "input": text})
        t("send-keys", "-t", name, "-l", text)
        time.sleep(.2)
        if text.startswith("/"):
            t("send-keys", "-t", name, "Escape")
            time.sleep(.2)
        t("send-keys", "-t", name, "Enter")
        time.sleep(.5)

    def records(name):
        path = evidence / (name + "-requests.jsonl")
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    try:
        assert node and tmux, "Node and tmux required"
        package = "@earendil-works/pi-coding-agent"
        expected = json.loads((repo / "package.json").read_text())["devDependencies"][package]
        installed = repo / "node_modules" / package
        manifest = json.loads((installed / "package.json").read_text())
        assert manifest["version"] == expected, "Run npm install: installed Pi differs from pin"
        entry = manifest["bin"]
        cli = [node, str(installed / (entry if isinstance(entry, str) else entry["pi"]))]
        flags = ["--no-extensions", "-e", str(repo / "packages/pi-auto-resume/index.ts"),
                 "-e", str(skill / "scripts/fixture-provider.ts"), "--no-mcp", "--no-skills",
                 "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-tools",
                 "--no-approve", "--offline", "--no-session", "--model", "resume-fixture/fixture"]
        state, env = setup("doctor", "limit")
        version = subprocess.run([*cli, "--version"], env=env, capture_output=True, text=True, check=True).stdout.strip()
        assert version == expected
        for mode in ["print", "json"]:
            state, env = setup(mode, "limit")
            argv = [*cli, *flags, *(["--print"] if mode == "print" else ["--mode", "json"]), "fixture task"]
            launches.append({"name": mode, "argv": argv, "env": env, "cwd": str(state / "cwd")})
            start = time.monotonic()
            proc = subprocess.run(argv, env=env, cwd=state / "cwd", capture_output=True, text=True, timeout=20)
            (evidence / (mode + "-stdout.txt")).write_text(proc.stdout)
            (evidence / (mode + "-stderr.txt")).write_text(proc.stderr)
            assert time.monotonic() - start < 20 and len(records(mode)) == 1
            assert "Extension errors" not in proc.stdout + proc.stderr
            assert "extension_error" not in proc.stdout + proc.stderr
            assert "Synthetic terminal failure" in proc.stderr if mode == "print" else proc.returncode == 0
            if mode == "print":
                assert proc.returncode != 0 and "Usage limit resets at " in proc.stderr
            else:
                events = [json.loads(line) for line in proc.stdout.splitlines()]
                assert any(x["type"] == "message_end" and x["message"].get("stopReason") == "error" and x["message"].get("errorMessage") == "Synthetic terminal failure" for x in events)
                assert any(x["type"] == "agent_settled" for x in events)
                entries = [x["entry"] for x in events if x["type"] == "entry_appended"]
                assert any(x.get("customType") == "auto-resume" and x["data"]["resetsAt"] == records(mode)[0]["resetsAt"] for x in entries)
            cases[mode] = {"returncode": proc.returncode, "requests": 1}
        scenarios = {"resume": "limit", "off": "limit", "prompt": "limit", "new": "limit",
                     "reload": "limit", "extensionwork": "limit", "extensionuser": "limit", **{x: x for x in ["plain", "success", "error", "missing", "invalid", "nan", "past", "far", "mismatch", "date"]}}
        deadlines = []
        for name, scenario in scenarios.items():
            state, env = setup(name, scenario)
            argv = [*cli, *flags, "--verbose", "--tui-mode", "regular"]
            launches.append({"name": name, "argv": argv, "env": env, "cwd": str(state / "cwd")})
            command = shlex.join(["env", "-i", *[f"{k}={v}" for k, v in env.items()], *argv])
            t("-f", "/dev/null", "new-session", "-d", "-s", name, "-x", "130", "-y", "40", "-c", str(state / "cwd"), command)
            owned_pids.add(int(t("display-message", "-p", "-t", name, "#{pane_pid}").stdout.strip()))
            wait(name, "startup", "Extensions")
            if name == "off":
                send(name, "/auto-resume off")
                wait(name, "disabled", "Auto-resume is off")
                send(name, "/auto-resume on")
                wait(name, "enabled", "Auto-resume is on")
            send(name, "fixture task")
            end = time.monotonic() + 15
            while not records(name) and time.monotonic() < end:
                time.sleep(.2)
            assert len(records(name)) == 1, name
            time.sleep(.5)
            deadlines.append(time.monotonic() + 64)
            if scenario == "limit":
                wait(name, "waiting", "/auto-resume off to cancel")
                if name == "off":
                    send(name, "/auto-resume off")
                    wait(name, "cancelled", "Auto-resume is off")
                elif name == "prompt":
                    send(name, "replacement prompt")
                    wait(name, "cancelled", "your new prompt takes over")
                    wait(name, "replacement", "FIXTURE_OK_2")
                elif name in ["extensionwork", "extensionuser"]:
                    send(name, "/fixture-work" if name == "extensionwork" else "/fixture-user")
                    wait(name, "replacement", "FIXTURE_OK_2")
                elif name in ["new", "reload"]:
                    send(name, "/" + name)
                    wait(name, "switched", "Reloaded" if name == "reload" else "New session started")
            else:
                assert "/auto-resume off to cancel" not in capture(name, "settled"), name
        # Every case is observed beyond its own genuine 60-second interval.
        time.sleep(max(0, max(deadlines) - time.monotonic()))
        for name in scenarios:
            text = capture(name, "final")
            rows = records(name)
            expected_count = 2 if name in ["resume", "prompt", "extensionwork", "extensionuser"] else 1
            assert len(rows) == expected_count, f"{name}: expected {expected_count} requests, got {len(rows)}"
            assert "/auto-resume off to cancel" not in text, name
            if name == "resume":
                assert rows[1]["at"] >= rows[0]["resetsAt"]
                assert rows[1]["at"] - rows[0]["at"] >= 59000
                serialized = json.dumps(rows[1]["messages"])
                assert "FAILED_ATTEMPT_SENTINEL" not in serialized
                assert "Auto-resumed" not in serialized and '"customType": "auto-resume"' not in serialized
                assert "fixture task" in serialized
                assert "Auto-resumed after the usage limit reset" in text and "FIXTURE_OK_2" in text
            cases[name] = {"requests": len(rows), "observedBeyondTimer": True}
        result["status"] = "passed"
    except Exception as error:
        result["error"] = repr(error)
        raise
    finally:
        (evidence / "launch.json").write_text(json.dumps({"version": expected, "globalPiNotRun": shutil.which("pi"), "launches": launches}, indent=2))
        (evidence / "actions.json").write_text(json.dumps(actions, indent=2))
        cleanup_errors = []
        def process_tree():
            output = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, check=True).stdout
            return {int(pid): int(parent) for pid, parent in (line.split() for line in output.splitlines())}
        try:
            tree = process_tree()
            changed = True
            while changed:
                children = {pid for pid, parent in tree.items() if parent in owned_pids}
                changed = not children.issubset(owned_pids)
                owned_pids.update(children)
            result["ownedPids"] = sorted(owned_pids)
            if tmux:
                t("kill-server", check=False)
            result["serverStopped"] = not tmux or t("list-sessions", check=False).returncode != 0
            for sig in [None, signal.SIGTERM, signal.SIGKILL]:
                alive = owned_pids.intersection(process_tree())
                if not alive:
                    break
                if sig is not None:
                    for pid in alive:
                        try:
                            os.kill(pid, sig)
                        except ProcessLookupError:
                            pass
                end = time.monotonic() + 3
                while alive and time.monotonic() < end:
                    time.sleep(.1)
                    alive = owned_pids.intersection(process_tree())
            result["ownedProcessesStopped"] = not owned_pids.intersection(process_tree())
            shutil.rmtree(scratch)
            result["scratchRemoved"] = not scratch.exists()
            for key in ["serverStopped", "ownedProcessesStopped", "scratchRemoved"]:
                if not result[key]:
                    cleanup_errors.append(key + " is false")
        except Exception as error:
            cleanup_errors.append(repr(error))
        result["cleanupErrors"] = cleanup_errors
        if cleanup_errors:
            result["status"] = "failed"
        result["cases"] = cases
        (evidence / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2), flush=True)
        assert not cleanup_errors, cleanup_errors


if __name__ == "__main__":
    main()
