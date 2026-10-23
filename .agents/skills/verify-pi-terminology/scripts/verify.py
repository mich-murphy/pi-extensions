#!/usr/bin/env python3
"""Wrapper for the pi-terminology isolated real-TUI verifiers.

  verify.py doctor
  verify.py drive --feature all|commands|preview [--synthetic-ui-fixture]

Launches only packages/pi-terminology/scripts/verify-tui.py and verify-preview-tui.py,
captures the evidence directory each prints, and asserts result.json, counters and
cleanup. A missing artifact or file is a failure, never a pass. No provider calls.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
PACKAGE = REPO / "packages/pi-terminology"
COMMANDS = PACKAGE / "scripts/verify-tui.py"
PREVIEW = PACKAGE / "scripts/verify-preview-tui.py"
PI = "@earendil-works/pi-coding-agent"
LEGACY = re.compile(r"/terms\b|terms-")
ALLOWED = re.compile(r"^/terminology(-status|-auth-refresh|-hide|-restore|-preview)?( |$)")


def need(cond, message):
    if not cond:
        raise SystemExit("FAIL: " + message)


def load(path):
    need(path.is_file(), f"missing evidence file {path}")
    return json.loads(path.read_text())


def doctor():
    pin = json.loads((REPO / "package.json").read_text())["devDependencies"][PI]
    manifest_path = REPO / "node_modules" / PI / "package.json"
    need(manifest_path.is_file(), "pinned Pi not installed; run npm install")
    version = json.loads(manifest_path.read_text())["version"]
    need(version == pin, f"installed Pi {version} != pinned {pin}")
    for tool in ("node", "tmux"):
        need(shutil.which(tool), tool + " is required")
    for script in (COMMANDS, PREVIEW):
        need(script.is_file(), f"missing {script}")
        text = script.read_text()
        compile(text, str(script), "exec")
        need(not re.search(r'command\([\"\x27]/terms(?:-|[\"\x27 ])', text),
             f"{script.name} still invokes a legacy command")
        need("/terminology" in text, f"{script.name} has no /terminology commands")
    print(f"doctor ok: repo={REPO} pi={version} (pinned, local) node/tmux present; "
          "scripts compile and invoke the terminology command family")


def run_child(script, extra=()):
    proc = subprocess.run([sys.executable, "-I", str(script), *extra], text=True,
                          capture_output=True, cwd=REPO)
    paths = [l.strip() for l in proc.stdout.splitlines() if l.strip().startswith("/tmp/")]
    need(paths, f"{script.name} printed no evidence path (exit {proc.returncode})\n{proc.stderr[-2000:]}")
    evidence = Path(paths[-1])
    print(f"{script.name}: exit {proc.returncode}; evidence {evidence}")
    need(evidence.is_dir(), f"evidence directory missing: {evidence}")
    return proc, evidence


def common(name, proc, evidence):
    result = load(evidence / "result.json")
    need(result.get("result") == "passed", f"{name}: result={result.get('result')!r} "
         f"failure={result.get('failure')!r} (waiting/missing artifact is not a pass)")
    need(proc.returncode == 0, f"{name}: exit {proc.returncode}")
    need(not (evidence / "failure.txt").exists(), f"{name}: failure.txt present")
    need(result.get("scratchRemoved") is True, f"{name}: scratch not removed")
    need(result.get("passed"), f"{name}: empty passed list")
    need(result.get("commandPrefix") == "/terminology", f"{name}: wrong command prefix")
    need(result.get("legacyCommandsAbsent") is True, f"{name}: legacy commands not proven absent")
    need(result.get("viewports") == {"normal": "180x50", "narrow": "60x28"}, f"{name}: viewport metadata")
    need(result.get("warnings"), f"{name}: narrow-terminal warning metadata missing")
    catalogs = load(evidence / "command-catalog.json")
    expected = sorted(["terminology", *["terminology-" + suffix for suffix in
                      ("preview", "status", "approve", "auth-refresh", "hide", "restore", "dismiss")]])
    need(catalogs and all(sorted(c) == expected for c in catalogs),
         f"{name}: actual SDK command registry differs from the eight canonical commands")
    discovery = (evidence / "command-discovery.txt")
    need(discovery.is_file(), f"{name}: command-discovery capture missing")
    text = discovery.read_text()
    need("terminology-" in text and not LEGACY.search(text), f"{name}: completion shows wrong commands")
    actions = load(evidence / "actions.json")
    commands = [a["value"] for a in actions if a["kind"] in ("command", "slash-command")]
    need(commands, f"{name}: no commands recorded")
    bad = [c for c in commands if not ALLOWED.match(c)]
    need(not bad, f"{name}: non-terminology commands sent: {bad[:3]}")
    need(any(a["kind"] == "resize" and a["value"].startswith("60x28") for a in actions),
         f"{name}: narrow 60x28 never exercised")
    return result, actions


def drive_commands():
    proc, evidence = run_child(COMMANDS)
    result, actions = common("commands", proc, evidence)
    counters = load(evidence / "counters.json")
    need(counters.get("guardInstallations", 0) >= 1, "commands: guard never installed")
    need(all(counters.get(k) == 0 for k in ("classifierCalls", "modelInputs", "networkCalls")),
         "commands: forbidden provider/input/network activity")
    joined = "\n".join(result["passed"])
    for needle in ("41 new canonical queries", "hide/restore commands persist", "invalid JSON",
                   "root manifest loads all seven extensions"):
        need(needle in joined, f"commands: missing passed item {needle!r}")
    need(any(a["kind"] == "command" and a["value"] == "/terminology-hide core:deep-module" for a in actions),
         "commands: hide command not driven")
    return evidence


def drive_preview(synthetic):
    proc, evidence = run_child(PREVIEW, ["--synthetic-ui-fixture"] if synthetic else [])
    result, actions = common("preview", proc, evidence)
    source = "synthetic-offline-ui-fixture" if synthetic else "actual-bundled-artifact"
    need(result.get("artifactSource") == source, f"preview: artifact source {result.get('artifactSource')!r}")
    need(result.get("native") is False, "preview: native must be explicitly false")
    artifact = load(evidence / "artifact.json")
    need(artifact.get("exists") is True and artifact.get("native") is False, "preview: artifact not present/false-native")
    counters = load(evidence / "counters.json")
    for key in ("slashClassifierCalls", "realProviderRequests", "fetchCalls"):
        need(counters.get(key) == 0, f"preview: {key}={counters.get(key)!r}, expected 0")
    need(counters.get("nativeInferenceVerified") is False, "preview: nativeInferenceVerified must be false")
    need(counters.get("interceptedFakeClassifierCalls") == 2, "preview: expected exactly 2 allowed fake classify calls")
    need(counters.get("offlineSyntheticInputs") == 3, "preview: expected 3 synthetic inputs")
    slash = load(evidence / "slash-counters.json")
    need(all(slash.get(k) == 0 for k in ("classifierCalls", "modelInputs", "networkCalls")), "preview: slash counters nonzero")
    joined = "\n".join(result["passed"])
    for needle in ("cancel, invalid 0/101", "mutation fail-closed", "confirmation warning and cost visible",
                   "OFFLINE fake journey", "allowance 2->1->0", "no context injection"):
        need(needle in joined, f"preview: missing passed item {needle!r}")
    for label in ("cancel-remains-off", "enabled", "explicit-off", "restart-off-no-saved-preview",
                  "mutated-fail-closed", "fake-exhausted", "cancel-confirm-60x28"):
        need((evidence / (label + ".txt")).is_file(), f"preview: missing capture {label}.txt")
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("doctor")
    drive = sub.add_parser("drive")
    drive.add_argument("--feature", choices=["all", "commands", "preview"], required=True)
    drive.add_argument("--synthetic-ui-fixture", action="store_true",
                       help="preview only: scratch fake artifact; never native evidence")
    args = parser.parse_args()
    doctor()
    if args.mode == "doctor":
        return
    done = []
    if args.feature in ("all", "commands"):
        done.append(("commands", drive_commands()))
    if args.feature in ("all", "preview"):
        done.append(("preview", drive_preview(args.synthetic_ui_fixture)))
    for name, path in done:
        print(f"PASS {name}: {path}")


if __name__ == "__main__":
    main()
