#!/usr/bin/env python3
"""Pinned Pi 1.3.0 preview UI proof; FAKE auth, offline recorder, intercepted classifier.

Run after glossary/preview-policy.json is published and runtime sources are frozen.
Missing artifact runs the fail-closed branch and exits 2 (WAITING), never invents one.
Evidence is retained in /tmp; disposable profile/copy and owned tmux server removed.
This is NOT native inference, precision, calibration, or paid measurement proof.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time
import traceback

REPO = Path(__file__).resolve().parents[3]
PACKAGE = REPO / "packages/pi-terminology"
PROMPTS = ["Please inspect the toy blue box and report its shape.",
           "Please inspect the toy green disk and report its size.",
           "Please inspect the toy red ball and report its weight."]
FAKE_KEY = "FAKE-UI-ONLY-DO-NOT-USE-NOT-A-REAL-TYPESAFE-KEY"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--synthetic-ui-fixture", action="store_true",
                        help="Explicit scratch-only 51-cutoff fixture; offline UI proof, NOT native or paid evidence")
    args = parser.parse_args()
    artifact_source = "synthetic-offline-ui-fixture" if args.synthetic_ui_fixture else "actual-bundled-artifact"
    evidence = Path(tempfile.mkdtemp(prefix="pi-preview-evidence-", dir="/tmp"))
    scratch = Path(tempfile.mkdtemp(prefix="pi-preview-owned-", dir="/tmp"))
    tmux, node, sandbox = (shutil.which(x) for x in ("tmux", "node", "sandbox-exec"))
    socket = str(scratch / "tmux.sock")
    env = {"HOME": str(scratch / "home"), "PI_CODING_AGENT_DIR": str(scratch / "agent"),
           "TMPDIR": str(scratch / "tmp"), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
           "SHELL": "/bin/sh", "TERM": "xterm-256color", "NODE_DISABLE_COMPILE_CACHE": "1",
           "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0",
           "TYPESAFE_API_KEY": FAKE_KEY, "PREVIEW_GUARD_LOG": str(evidence / "guard.jsonl")}
    actions, launches, passed = [], [], []
    session, sequence, failure, waiting = "verify", 0, None, False
    fake_mode = False
    sources = sorted([*PACKAGE.glob("*.ts"), *PACKAGE.glob("glossary/*.json"),
                      Path(__file__), REPO / "package.json"])
    hashes = {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}

    def save(name, data):
        (evidence / name).write_text(json.dumps(data, indent=2) + "\n")

    def record(kind, value):
        actions.append({"time": time.time(), "session": session, "kind": kind, "value": value})
        save("actions.json", actions)

    def t(*args, check=True):
        return subprocess.run([tmux, "-S", socket, *args], env=env, text=True,
                              capture_output=True, check=check, timeout=20)

    def guard_zero():
        log = evidence / "guard.jsonl"
        rows = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        assert rows and any(row["kind"] == "installed" for row in rows), "Guard never installed"
        assert all(row["kind"] in ("installed", "fake-input", "fake-classify", "fake-wire", "fake-agent") for row in rows), f"Forbidden operation: {rows}"
        catalogs = [row["detail"]["commands"] for row in rows if row["kind"] == "installed"]
        expected = sorted(["terminology", *["terminology-" + suffix for suffix in
                          ("preview", "status", "approve", "auth-refresh", "hide", "restore", "dismiss")]])
        assert catalogs and all(sorted(c) == expected for c in catalogs), catalogs
        save("command-catalog.json", catalogs)
        if not fake_mode:
            assert all(row["kind"] == "installed" for row in rows), "Slash journey must classify zero times"
        return rows

    def capture(label):
        text = t("capture-pane", "-p", "-t", session + ":0.0").stdout
        (evidence / (label + ".txt")).write_text(text)
        assert not any(x in text for x in ("Extension errors", "Unhandled", "Error loading extension")), text
        return text

    def wait(label, needles, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            text = capture(label)
            normalized = " ".join(text.split())
            if all(needle in normalized for needle in needles):
                guard_zero()
                return text
            time.sleep(.15)
        raise AssertionError(f"{label}: missing {needles!r}; see {evidence}")

    def key(name):
        record("key", name)
        t("send-keys", "-t", session + ":0.0", name)
        time.sleep(.25)

    def command(text):
        assert text in ("/terminology", "/terminology-status", "/terminology-auth-refresh") or text.startswith("/terminology-preview ")
        record("slash-command", text)
        t("send-keys", "-t", session + ":0.0", "-l", text)
        time.sleep(.2)
        key("Escape")
        key("Enter")
        if any(line.rstrip() == text for line in capture("latest-command").splitlines()):
            key("Enter")

    def launch(label):
        nonlocal session, sequence
        sequence += 1
        session = "preview" + str(sequence)
        previous_installations = sum(row["kind"] == "installed" for row in guard_zero()) if sequence > 1 else 0
        record("launch", label)
        launches.append({"label": label, "argv": argv, "cwd": str(scratch / "cwd")})
        save("launches.json", launches)
        launch_env = {**env, "PREVIEW_FAKE_MODE": "1" if fake_mode else "0"}
        launch_argv = [*argv, *(["-e", str(recorder), "--model", "recorder/codex-like"] if fake_mode else [])]
        launches[-1].update({"argv": launch_argv, "fakeMode": fake_mode})
        save("launches.json", launches)
        shell = shlex.join(["env", "-i", *[k + "=" + v for k, v in launch_env.items()], *launch_argv])
        t("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "180", "-y", "50",
          "-c", str(scratch / "cwd"), shell)
        pane = wait(label + "-startup", ["v1.3.0", "Extensions", "000-guard.ts"])
        assert sum(row["kind"] == "installed" for row in guard_zero()) == previous_installations + 1, "Each process must install its guard"
        assert pane.index("000-guard.ts") < pane.index(str(scratch / "extension")), "Guard must load first"
        command("/terminology-auth-refresh")  # local FAKE env snapshot resolution, not login/auth CLI
        wait(label + "-fake-auth", ["Terminology classifier authentication is ready."])

    def discover(label):
        # Real completion search: only types text and clears it; never submits an unknown command.
        record("completion-search", "/terminology-")
        t("send-keys", "-t", session + ":0.0", "-l", "/terminology-")
        time.sleep(.5)
        pane = capture(label)
        assert "terminology-" in pane, "Completion must offer terminology-* commands\n" + pane
        assert not re.search(r"/terms|terms-", pane), "Legacy terms commands must not be offered\n" + pane
        key("Escape")
        key("C-u")

    def stop():
        guard_zero()
        record("stop-owned-session", session)
        t("kill-session", "-t", session, check=False)

    def status(label, on=False, remaining=None):
        command("/terminology-preview status")
        return wait(label, [f"Experimental preview: {'on' if on else 'off'}; calls remaining: {remaining if remaining is not None else 2 if on else 0}"])

    def confirm(label, narrow=False):
        command("/terminology-preview on 2")
        pane = wait(label, ["Enable EXPERIMENTAL terminology preview?", "TypeSafe", "unvalidated",
                            "$0.0056", "Gaps", "main Pi model usage additional"])
        if narrow:
            record("resize", "60x28")
            t("resize-window", "-t", session, "-x", "60", "-y", "28")
            wait(label + "-60x28", ["EXPERIMENTAL", "TypeSafe", "$0.0056", "unvalidated"])
            record("resize", "180x50")
            t("resize-window", "-t", session, "-x", "180", "-y", "50")
            wait(label + "-restored", ["unvalidated"])
        return pane

    try:
        assert tmux and node, "Node and tmux required"
        for directory in ("home", "agent", "tmp", "cwd", "extension"):
            (scratch / directory).mkdir()
        copy = scratch / "extension"
        for source in sources:
            if source.parent == PACKAGE or source.parent == PACKAGE / "glossary":
                target = copy / source.relative_to(PACKAGE)
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(source.read_bytes())
        (scratch / "agent/settings.json").write_text(json.dumps({"packages": [], "cacheWarming": "off",
            "theme": "dark", "enableInstallTelemetry": False, "enableAnalytics": False,
            "compaction": {"enabled": False}, "retry": {"enabled": False}}))
        (scratch / "agent/auth.json").write_text("{}\n")
        guard = scratch / "000-guard.ts"
        guard.write_text(r'''import { appendFileSync } from "node:fs";
export default function(pi: any) {
  const fake = process.env.PREVIEW_FAKE_MODE === "1";
  const prompts = JSON.parse(process.env.PREVIEW_ALLOWED_PROMPTS!);
  const log = (kind: string, detail?: any) => appendFileSync(process.env.PREVIEW_GUARD_LOG!, JSON.stringify({kind, detail, pid:process.pid, time:Date.now()})+"\n");
  const deny = (kind: string) => (..._args: any[]) => { log(kind); throw new Error("UI verification forbids "+kind); };
  globalThis.fetch = deny("fetch") as any;
  pi.on("session_start", (_event: any, ctx: any) => {
    const classify = async (model: any, context: any, options: any) => {
      if (!fake || model.provider !== "typesafe" || model.id !== "jev-1.13.0" || options.maxRetries !== 0 || !prompts.includes(context.state.prompt)) return deny("invalid-classifier")();
      const ids = Object.keys(context.questions);
      if (ids.length !== 51) return deny("invalid-question-count")();
      const payload = {model:model.id, state:context.state, questions:Object.fromEntries(Object.entries(context.questions).map(([id,q]:any)=>[id,{...q,type:"noul"}]))};
      log("fake-classify", {model:model.id, provider:model.provider, state:context.state, ids, maxRetries:options.maxRetries, timeoutMs:options.timeoutMs});
      const wire = await options.onPayload?.(payload, model) ?? payload;
      log("fake-wire", wire);
      await new Promise(resolve=>setTimeout(resolve,150));
      return {api:model.api, provider:model.provider, model:model.id, answers:Object.fromEntries(ids.map((id,i)=>[id,{type:"bool",probability:i<6?1:0}])),stopReason:"stop",timestamp:Date.now()};
    };
    Object.defineProperty(ctx.modelRegistry, "classify", {value:fake?classify:deny("classify"), writable:false, configurable:false});
    for (const method of ["stream", "streamSimple", "complete", "completeSimple", "generateImages"]) {
      const original = ctx.modelRegistry[method]?.bind(ctx.modelRegistry);
      const guarded = (model:any,...args:any[]) => {
        if (!fake || model.provider !== "recorder") return deny(method)();
        return original(model,...args);
      };
      Object.defineProperty(ctx.modelRegistry, method, {value:guarded, writable:false, configurable:false});
    }
    log("installed", {fake, commands:pi.getCommands().map((c:any)=>c.name).filter((n:string)=>/^(term|terms|terminology)($|-)/.test(n))});
  });
  pi.on("input", (event:any) => {
    if (fake && prompts.includes(event.text) && event.source === "interactive") { log("fake-input",event.text); return {action:"continue"}; }
    log("model-input-blocked"); return {action:"handled"};
  });
  pi.on("before_agent_start", (event:any,ctx:any) => {
    if (!fake || ctx.model?.provider !== "recorder" || !prompts.includes(event.prompt)) return deny("agent-start")();
    log("fake-agent",event.prompt);
  });
  pi.on("before_provider_request", (_event:any,ctx:any) => {
    if (!fake || ctx.model?.provider !== "recorder") return deny("provider-request")();
  });
  pi.on("cache_warming_decision", () => ({action:"stop"}));
}
''')
        # Adapt the reviewed local recorder; no runtime source changes and no network provider.
        recorder_source = REPO / ".agents/skills/verify-pi-skill-toggle/scripts/recorder-provider.ts"
        recorder = scratch / "001-recorder.ts"
        recorder_text = recorder_source.read_text().replace("PI_SKILL_TOGGLE_RECORDER_FILE", "PREVIEW_PRIMARY_LOG")
        recorder_text = recorder_text.replace("const calls = scriptedCalls(context.messages);", "const calls: readonly ScriptedCall[] = [];\n        await new Promise(resolve => setTimeout(resolve, 700));")
        recorder.write_text(recorder_text)
        env["PREVIEW_PRIMARY_LOG"] = str(evidence / "primary.jsonl")
        env["PREVIEW_ALLOWED_PROMPTS"] = json.dumps(PROMPTS)
        save("recorder-source.json", {"path":str(recorder_source), "sha256":hashlib.sha256(recorder_source.read_bytes()).hexdigest(), "adaptedSha256":hashlib.sha256(recorder.read_bytes()).hexdigest()})
        (evidence / "recorder.ts").write_bytes(recorder.read_bytes())
        name = "@earendil-works/pi-coding-agent"
        pin = json.loads((REPO / "package.json").read_text())["devDependencies"][name]
        manifest = json.loads((REPO / "node_modules" / name / "package.json").read_text())
        assert pin == manifest["version"] == "1.3.0"
        cli = (REPO / "node_modules" / name / manifest["bin"]["pi"]).resolve()
        argv = [node, str(cli), "--no-extensions", "-e", str(guard), "-e", str(copy / "index.ts"),
                "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
                "--no-tools", "--no-approve", "--offline", "--no-session", "--verbose", "--tui-mode", "regular"]
        if sandbox:
            profile = scratch / "network-deny.sb"
            profile.write_text('(version 1)\n(allow default)\n(deny network*)\n')
            argv = [sandbox, "-f", str(profile), *argv]
            (evidence / "network-deny.sb").write_bytes(profile.read_bytes())
        save("environment.json", env)
        save("source-hashes.json", hashes)
        save("safety.json", {"sandboxExec": sandbox, "fakeKeyOnly": True, "guardLoadedFirst": True,
                             "networkPolicy": "deny network*" if sandbox else "offline + throwing fetch/registry guard; no OS sandbox available"})
        (evidence / "guard.ts").write_bytes(guard.read_bytes())
        save("guard-hash.json", {"sha256": hashlib.sha256(guard.read_bytes()).hexdigest()})
        save("cli.json", {"path": str(cli), "sha256": hashlib.sha256(cli.read_bytes()).hexdigest(), "version": pin})
        artifact = copy / "glossary/preview-policy.json"
        actual_artifact = PACKAGE / "glossary/preview-policy.json"
        actual_artifact_existed = actual_artifact.exists()
        if args.synthetic_ui_fixture:
            generator = scratch / "synthetic-fixture.mjs"
            generator.write_text(
                "import {writeFileSync} from 'node:fs';\n"
                + "import {createJiti} from " + json.dumps(str(REPO / "node_modules/jiti/lib/jiti.mjs")) + ";\n"
                + "const jiti = createJiti(import.meta.url,{fsCache:false});\n"
                + "const {loadCatalogue} = await jiti.import(" + json.dumps(str(copy / "catalogue.ts")) + ");\n"
                + "const {previewBinding,validatePreviewPolicy} = await jiti.import(" + json.dumps(str(copy / "preview-policy.ts")) + ");\n"
                + "const {catalogue} = loadCatalogue(); const binding = previewBinding(catalogue);\n"
                + "if(catalogue.recognition.length!==51 || Object.keys(binding.sourceHashes).length!==6) throw new Error('Fixture requires 51 recognizers and six source bindings');\n"
                + "const fixture = {...binding,schemaVersion:1,developmentOnly:true,measured:false,promotable:false,acceptanceStatus:'not-validated',"
                + "conceptThresholds:Object.fromEntries(catalogue.recognition.map(r=>[r.conceptId,0.9])),"
                + "gaps:['SYNTHETIC OFFLINE UI FIXTURE ONLY — no native inference or paid evidence']};\n"
                + "if(!validatePreviewPolicy(fixture,catalogue,binding).ok) throw new Error('Invalid scratch fixture');\n"
                + "writeFileSync(" + json.dumps(str(artifact)) + ",JSON.stringify(fixture,null,2)+'\\n');\n")
            generator_argv = ([sandbox, "-f", str(profile)] if sandbox else []) + [node, str(generator)]
            generated = subprocess.run(generator_argv, env=env, cwd=scratch / "cwd", text=True,
                                       capture_output=True, timeout=30)
            (evidence / "fixture-generator.txt").write_text(generated.stdout + generated.stderr)
            assert generated.returncode == 0, f"Scratch fixture generation failed: {generated.stderr}"
            (evidence / "synthetic-fixture.mjs").write_bytes(generator.read_bytes())
            (evidence / "synthetic-preview-policy.json").write_bytes(artifact.read_bytes())
        save("artifact.json", {"actualPath": str(actual_artifact), "exists": artifact.exists(),
             "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest() if artifact.exists() else None,
             "synthetic": args.synthetic_ui_fixture, "artifactSource": artifact_source, "native": False,
             "actualBundledArtifactUsed": not args.synthetic_ui_fixture, "testedCopy": str(artifact)})
        launch("fresh")
        discover("command-discovery")
        command("/terminology-status")
        wait("initial-status", ["51 concepts", "unmeasured; automatic reminders disabled",
                               "TypeSafe credentials: configured", "TUI authentication: ready", "Experimental preview: off"])
        if not artifact.exists():
            command("/terminology-preview on 2")
            wait("missing-candidate-fail-closed", ["Preview candidate is missing or unreadable"])
            status("missing-remains-off")
            passed.append("missing actual artifact fails closed with fake-auth ready; zero classifier calls")
            waiting = True
        else:
            confirm("cancel-confirm", narrow=True)
            key("Escape")
            status("cancel-remains-off")
            for budget in (0, 101):
                command(f"/terminology-preview on {budget}")
                wait(f"invalid-{budget}", ["Usage: /terminology-preview"])
            confirm("enable-confirm")
            key("Enter")  # built-in confirm defaults to Yes; real keypress, never a prompt
            wait("enabled", ["EXPERIMENTAL unmeasured terminology preview enabled."])
            status("enabled-status", True)
            command("/terminology")
            wait("browse-no-budget", ["Terminology browser", "All entries: 51 of 51."])
            key("Escape")
            status("browse-preserves-budget", True)
            command("/terminology-status")
            wait("status-preserves-budget", ["Experimental preview: on; calls remaining: 2"])
            time.sleep(1)
            status("idle-no-replenish", True)
            command("/terminology-preview off")
            wait("explicit-off", ["preview off; pending work cancelled."])
            status("off-status")
            confirm("restart-enable-confirm")
            key("Enter")
            wait("restart-enabled", ["EXPERIMENTAL unmeasured terminology preview enabled."])
            status("before-restart", True)
            stop()
            launch("restart")
            status("restart-off-no-saved-preview")
            confirm("mutation-enable-confirm")
            key("Enter")
            wait("mutation-enabled", ["EXPERIMENTAL unmeasured terminology preview enabled."])
            status("before-mutation", True)
            # Mutate ONLY disposable copy; bundled artifact/source never touched.
            artifact_bytes = artifact.read_bytes()
            candidate = json.loads(artifact_bytes)
            candidate["acceptanceStatus"] = "UI-TEST-DELIBERATE-MUTATION"
            artifact.write_text(json.dumps(candidate))
            record("mutate-owned-artifact", str(artifact))
            command("/terminology-preview status")
            wait("mutated-fail-closed", ["Experimental preview: off; calls remaining: 0", "incompatible or mutated"])
            command("/terminology-preview on 2")
            wait("mutated-on-refused", ["incompatible or mutated"])
            passed.append(f"{artifact_source}: cancel, invalid 0/101, keypress enable 2, browse/status/idle preserve 2, off, restart off, mutation fail-closed")
            passed.append("confirmation warning and cost visible at 180x50 and 60x28")
            save("slash-counters.json", {"classifierCalls": 0, "modelInputs": 0, "networkCalls": 0})
            stop()
            artifact.write_bytes(artifact_bytes)  # restore only owned copy for fake journey
            state_path = scratch / "agent/pi-terminology.json"
            before_fake_state = state_path.read_bytes() if state_path.exists() else None
            fake_mode = True
            launch("offline-fake")
            status("fake-initial-off")
            confirm("fake-enable-confirm")
            key("Enter")
            wait("fake-enabled", ["EXPERIMENTAL unmeasured terminology preview enabled."])
            glossary = json.loads((copy / "glossary/core.json").read_text())
            labels = {concept["id"]: concept["label"] for concept in glossary["concepts"]}
            # Compiled catalogue order is canonical ID order, not source document order.
            chosen_ids = sorted(item["conceptId"] for item in glossary["recognition"])[:6]
            save("fake-journey-plan.json", {"prompts": PROMPTS, "positiveIds": chosen_ids,
                 "probabilities": "first six 1; remaining 45 zero; same complete response twice",
                 "evidenceKind": "local intercepted classifier; NOT native inference or precision"})
            for index, prompt in enumerate(PROMPTS, 1):
                assert len(prompt.encode()) < 200 and not prompt.startswith("/")
                assert not any(concept["label"].lower() in prompt.lower() for concept in glossary["concepts"])
                record("offline-synthetic-input", prompt)
                t("send-keys", "-t", session + ":0.0", "-l", prompt)
                key("Enter")
                pane = wait(f"fake-response-{index}", [f"Recorded request {index}."])
                time.sleep(.3)
                pane = capture(f"fake-widget-{index}")
                widget = re.findall(r"EXPERIMENTAL \(unmeasured\): Terms: (.*?)\. Ctrl", " ".join(pane.split()))
                if index < 3:
                    expected = [labels[cid] for cid in chosen_ids[(index - 1) * 3:index * 3]]
                    assert widget == [", ".join(expected)], f"Expected only three ephemeral labels: {expected}; got {widget}"
                    assert "+3 more" not in pane, "Preview must cap its actual match list at three"
                else:
                    assert not widget and "EXPERIMENTAL (unmeasured): Terms:" not in pane, "Exhaustion must clear widget"
                    wait("fake-exhausted", ["allowance exhausted"])
                status(f"fake-budget-{index}", on=index == 1, remaining=max(0, 2-index))
                rows_now = guard_zero()
                calls = [row["detail"] for row in rows_now if row["kind"] == "fake-classify"]
                assert len(calls) == min(index, 2), "Third prompt must not classify"
                assert [call["state"]["prompt"] for call in calls] == PROMPTS[:min(index, 2)]
                assert all(call["model"] == "jev-1.13.0" and call["maxRetries"] == 0 and len(call["ids"]) == 51 for call in calls)
            wires = [row["detail"] for row in guard_zero() if row["kind"] == "fake-wire"]
            assert len(wires) == 2, "Both fake calls must exercise the payload hook"
            assert all(len(json.dumps(wire, ensure_ascii=False, separators=(",", ":")).encode()) <= 64_512 for wire in wires), "Short synthetic probe must fit the complete-wire guard"
            assert sum(row["kind"] == "fake-input" for row in guard_zero()) == 3, "All three synthetic inputs must traverse real interactive input"
            assert sum(row["kind"] == "fake-agent" for row in guard_zero()) == 3, "All three inputs must reach only the offline primary agent"
            assert (state_path.read_bytes() if state_path.exists() else None) == before_fake_state, "Preview cooldowns must remain ephemeral, not persisted"
            primary = [json.loads(line) for line in (evidence / "primary.jsonl").read_text().splitlines()]
            assert len(primary) == 3, "Primary recorder must still answer after classifier exhaustion"

            def message_text(message):
                content = message.get("content", "")
                return content if isinstance(content, str) else "".join(block.get("text", "") for block in content if block.get("type") == "text")

            initial_system = [message for message in primary[0]["messages"] if message["role"] == "system"]
            for index, request in enumerate(primary, 1):
                assert request["model"] == "codex-like"
                messages = request["messages"]
                assert [message_text(message) for message in messages if message["role"] == "user"] == PROMPTS[:index], "Primary input must remain byte-for-byte unchanged"
                assert [message for message in messages if message["role"] == "system"] == initial_system, "No terminology system-context injection"
                assert all(message["role"] in ("system", "user", "assistant") for message in messages), "No custom reminder message injection"
                assert [message_text(message) for message in messages if message["role"] == "assistant"] == [f"Recorded request {n}." for n in range(1,index)], "No terminology assistant-context injection"
                assert "EXPERIMENTAL (unmeasured)" not in json.dumps(messages)
            command("/terminology-preview off")
            wait("fake-explicit-off", ["preview off; pending work cancelled."])
            status("fake-final-off")
            passed.append("OFFLINE fake journey: actual TUI inputs -> three experimental labels, next three via ephemeral cooldown, allowance 2->1->0, third primary reply without third classify; no context injection")
        rows = guard_zero()
        save("counters.json", {"guardInstallations": sum(row["kind"] == "installed" for row in rows),
             "slashClassifierCalls": 0, "interceptedFakeClassifierCalls": sum(row["kind"] == "fake-classify" for row in rows),
             "offlineSyntheticInputs": sum(row["kind"] == "fake-input" for row in rows),
             "realProviderRequests": 0, "fetchCalls": 0, "nativeInferenceVerified": False})
        assert json.loads((scratch / "agent/auth.json").read_text()) == {}, "No credentials may persist"
        state = scratch / "agent/pi-terminology.json"
        save("profile-state.json", json.loads(state.read_text()) if state.exists() else {"exists": False})
        changed = [str(p) for p in sources if hashes[str(p.relative_to(REPO))] != hashlib.sha256(p.read_bytes()).hexdigest()]
        assert not changed, f"Sources changed during proof; rerun frozen source: {changed}"
        assert actual_artifact.exists() == actual_artifact_existed, "Bundled artifact appeared/disappeared during run; rerun"
        passed.append("fake env only, isolated empty auth store, first-loaded guard; no native inference or fetch calls")
    except Exception:
        failure = traceback.format_exc()
        (evidence / "failure.txt").write_text(failure)
    finally:
        if tmux:
            t("kill-server", check=False)
        shutil.rmtree(scratch)
        save("result.json", {"viewports": {"normal": "180x50", "narrow": "60x28"}, "commandPrefix": "/terminology", "legacyCommandsAbsent": failure is None,
             "warnings": ["Narrow 60x28 metadata is only as strong as the passed list; a failure invalidates both viewports."], "result": "failed" if failure else "waiting-for-parent-artifact" if waiting else "passed",
             "artifactSource": artifact_source, "native": False,
             "passed": passed, "failure": failure, "scratchRemoved": not scratch.exists(),
             "limitations": ["UI only: fake authentication readiness is not native inference verification.",
                 "Only allowlisted synthetic inputs reach the local offline recorder; no real LLM or TypeSafe HTTP calls.",
                 "Widget and exhaustion journey uses intercepted fabricated classifier results, NOT precision or native-classification evidence.",
                 "Default mode: missing artifact skips candidate/fake-input tests and exits WAITING; never fabricates an artifact.",
                 "Explicit --synthetic-ui-fixture creates a clearly marked scratch-only fake artifact; never candidate, native, or paid evidence.",
                 "Original 199-pane verifier/evidence untouched; final proof requires frozen source and actual artifact."]})
        print(str(evidence), flush=True)
    if failure:
        raise SystemExit(failure)
    if waiting:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
