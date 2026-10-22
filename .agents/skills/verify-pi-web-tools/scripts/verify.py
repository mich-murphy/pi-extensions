#!/usr/bin/env python3
"""Real isolated Pi TUI verification; never sends a model prompt or tool request."""
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

PI_PACKAGE = "@earendil-works/pi-coding-agent"
COLLISION = "could not register web authentication"
# Pinned: once the subagent fix merges, origin/main no longer has the colliding authentication.ts.
PRE_FIX_COMMIT = "84095b198fe30c1e53a14a6e7c63356442bc2a0a"
SUBAGENT_PROBE = r'''import {join} from "node:path";
const [sdkUrl, configJson] = process.argv.slice(2);
const {createAgentSession,DefaultResourceLoader,ModelRegistry,ModelRuntime,SessionManager,SettingsManager} = await import(sdkUrl);
const {extension, parentCwd, childCwds, synthetic} = JSON.parse(configJson);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.inMemory({packages:[],cacheWarming:"off",defaultProjectTrust:"never"});
const uiFor = (notes) => new Proxy({notify:(message,type)=>notes.push({type,message})}, {get:(o,k)=>k in o ? o[k] : k === "then" ? undefined : () => undefined});
async function open(cwd, modelRuntime) {
 const resourceLoader = new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[extension]});
 await resourceLoader.reload();
 const {session} = await createAgentSession({cwd,agentDir,settingsManager,resourceLoader,sessionManager:SessionManager.inMemory(cwd),...(modelRuntime ? {modelRuntime} : {})});
 const view = {session, loadErrors:resourceLoader.getExtensions().errors.map(e=>String(e.error)), extensionErrors:[], notes:[]};
 await session.bindExtensions({uiContext:uiFor(view.notes), onError:e=>view.extensionErrors.push({event:e.event,error:String(e.error)})});
 return view;
}
async function close(view) {
 await view.session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
 view.session.dispose();
}
const parameters = (view) => view.session.getAllTools().find(t=>t.name==="websearch")?.parameters;
async function snapshot(view) {
 const registry = new ModelRegistry(view.session.modelRuntime);
 const listed = view.session.modelRuntime.getProviders().map(p=>p.id).filter(id=>id.startsWith("pi-web-tools"));
 const providers = {};
 await view.session.modelRuntime.refresh({allowNetwork:false});
 for (const id of [...new Set(listed)].sort()) {
  const check = await view.session.modelRuntime.checkAuth(id);
  const status = registry.getProviderAuthStatus(id);
  const key = await registry.getApiKeyForProvider(id);
  providers[id] = {count:listed.filter(x=>x===id).length, configured:status.configured, source:status.source ?? null, checkSource:check?.source ?? null, keyType:typeof key, synthetic:key === synthetic};
 }
 return {loadErrors:view.loadErrors, extensionErrors:view.extensionErrors, notes:[...view.notes], providers};
}
const parent = await open(parentCwd);
const parentRegistry = new ModelRegistry(parent.session.modelRuntime);
const output = {parentBefore:await snapshot(parent), children:{}};
const parentNatives = new Map(parentRegistry.getRegisteredProviderIds().map(id=>[id, parentRegistry.getRegisteredNativeProvider(id)]));
try {
 for (const [label, cwd] of Object.entries(childCwds)) {
  const childRuntime = await ModelRuntime.create({authPath:join(agentDir,"auth.json"), modelsPath:join(agentDir,"models.json")});
  const childRegistry = new ModelRegistry(childRuntime);
  const replayed = [];
  for (const id of parentRegistry.getRegisteredProviderIds()) {
   const native = parentRegistry.getRegisteredNativeProvider(id);
   if (native !== undefined) { childRegistry.registerProvider(native); replayed.push({id,form:"native"}); continue; }
   const config = parentRegistry.getRegisteredProviderConfig(id);
   if (config !== undefined) { childRegistry.registerProvider(id, config); replayed.push({id,form:"configured"}); }
  }
  const child = await open(cwd, childRuntime);
  try {
   output.children[label] = {cwd, replayed, sharesParentModule:parameters(child) === parameters(parent), ...(await snapshot(child))};
  } finally { await close(child); }
 }
 output.parentAfter = await snapshot(parent);
 output.parentNativesUnchanged = [...parentNatives].every(([id, native])=>parentRegistry.getRegisteredNativeProvider(id) === native);
} finally { await close(parent); }
console.log(JSON.stringify(output, null, 2));
'''


def pinned_pi(repo):
    """Resolve the checkout's pinned Pi devDependency: expected version, CLI entry, SDK entry."""
    expected = json.loads((repo / "package.json").read_text())["devDependencies"][PI_PACKAGE]
    package_dir = repo / "node_modules" / PI_PACKAGE
    manifest_path = package_dir / "package.json"
    assert manifest_path.is_file(), f"Missing {manifest_path}; run npm install in the checkout first"
    manifest = json.loads(manifest_path.read_text())
    assert manifest["version"] == expected, f"Installed {PI_PACKAGE} {manifest['version']} != pinned {expected}; run npm install"
    bin_entry = manifest["bin"] if isinstance(manifest["bin"], str) else manifest["bin"]["pi"]
    exports = manifest.get("exports")
    export = exports.get(".", exports) if isinstance(exports, dict) else exports
    sdk_entry = export.get("import") if isinstance(export, dict) else export
    cli = (package_dir / bin_entry).resolve()
    sdk = (package_dir / (sdk_entry or manifest["main"])).resolve()
    assert cli.is_file() and sdk.is_file(), (cli, sdk)
    return expected, cli, sdk


def child_failures(outcome, expected, synthetic):
    """Return unmet assertions for one replayed-child probe run; empty means the journey passed."""
    failures = []
    parent_ok = sorted(outcome["parentBefore"]["providers"]) == sorted(expected)
    for label, view in [("parent", outcome["parentBefore"]), *outcome["children"].items()]:
        if view["loadErrors"] or view["extensionErrors"]:
            failures.append(label + ": extension error")
        if any(COLLISION in note["message"] for note in view["notes"]):
            failures.append(label + ": authentication provider collision")
        if sorted(view["providers"]) != sorted(expected) or any(p["count"] != 1 for p in view["providers"].values()):
            failures.append(label + ": web-tools providers not registered exactly once")
    for label, child in outcome["children"].items():
        if sorted(r["id"] for r in child["replayed"] if r["form"] == "native") != sorted(expected):
            failures.append(label + ": parent native providers not replayed")
        for provider, source in [("pi-web-tools-exa", "stored"), ("pi-web-tools-brave", "environment")]:
            status = child["providers"].get(provider, {})
            if not (status.get("configured") and status.get("source") == source and status.get("synthetic")):
                failures.append(f"{label}: {provider} not configured from {source}")
    if outcome["children"]["other-cwd"]["sharesParentModule"]:
        failures.append("other-cwd: child reused the parent module instance")
    if not parent_ok or outcome["parentAfter"] != outcome["parentBefore"] or not outcome["parentNativesUnchanged"]:
        failures.append("parent changed after child disposal")
    return failures


def subagent_child(repo, node, pi_sdk, scratch, evidence, env, synthetic, expected):
    """Replay parent providers onto children as pi-subagents does; require checkout pass and the pre-fix commit collide."""
    old = scratch / "pre-fix/pi-web-tools"
    shutil.copytree(repo / "packages/pi-web-tools", old, ignore=shutil.ignore_patterns("node_modules", "test"))
    show = ["git", "-C", str(repo), "show", f"{PRE_FIX_COMMIT}:packages/pi-web-tools/authentication.ts"]
    (old / "authentication.ts").write_text(subprocess.run(show, text=True, capture_output=True, check=True).stdout)
    # Symlink, not a copy: rmtree unlinks it without descending into the checkout's dependencies.
    (scratch / "pre-fix/node_modules").symlink_to(repo / "node_modules")
    assert (old / "authentication.ts").read_bytes() != (repo / "packages/pi-web-tools/authentication.ts").read_bytes()
    auth_path = scratch / "agent/auth.json"
    auth_path.write_text(json.dumps({"pi-web-tools-exa": {"type": "api_key", "key": synthetic}}))
    auth_path.chmod(0o600)
    stored = auth_path.read_bytes()
    (scratch / "cwd-child").mkdir()
    probe = scratch / "subagent-child.mjs"
    probe.write_text(SUBAGENT_PROBE)
    (evidence / "subagent-child.mjs").write_text(SUBAGENT_PROBE)
    summary = {"credentials": {"pi-web-tools-exa": "stored api_key in scratch auth.json", "pi-web-tools-brave": "BRAVE_API_KEY"},
               "preFixCommit": PRE_FIX_COMMIT}
    for label, package in [("checkout", repo / "packages/pi-web-tools"), ("pre-fix", old)]:
        config = {"extension": str(package / "index.ts"), "parentCwd": str(scratch / "cwd"), "synthetic": synthetic,
                  "childCwds": {"same-cwd": str(scratch / "cwd"), "other-cwd": str(scratch / "cwd-child")}}
        result = subprocess.run([node, str(probe), pi_sdk.as_uri(), json.dumps(config)], cwd=scratch / "cwd",
                                env=env, text=True, capture_output=True, timeout=60)
        (evidence / f"subagent-child-{label}.json").write_text(result.stdout)
        (evidence / f"subagent-child-{label}.stderr.txt").write_text(result.stderr)
        assert result.returncode == 0, result.stderr
        outcome = json.loads(result.stdout)
        summary[label] = {"failures": child_failures(outcome, expected, synthetic),
                          "childCollisions": {name: any(COLLISION in n["message"] for n in child["notes"])
                                              for name, child in outcome["children"].items()},
                          "sharesParentModule": {name: child["sharesParentModule"] for name, child in outcome["children"].items()}}
    summary["authUnchanged"] = auth_path.read_bytes() == stored
    (evidence / "subagent-child-summary.json").write_text(json.dumps(summary, indent=2))
    assert summary["authUnchanged"], "Probe must not write credentials"
    assert not summary["checkout"]["failures"], summary["checkout"]
    assert all(summary["pre-fix"]["childCollisions"].values()), "pre-fix commit must collide in every child"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["startup", "invalid-config", "native-auth", "subagent-child"])
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[4]
    evidence = Path(tempfile.mkdtemp(prefix="pi-web-tools-evidence-", dir="/tmp"))
    scratch = Path(tempfile.mkdtemp(prefix="pi-web-tools-state-", dir="/tmp"))
    for name in ["home", "agent", "cwd", "tmp"]:
        (scratch / name).mkdir()
    (scratch / "agent/settings.json").write_text(json.dumps({"packages": [], "cacheWarming": "off", "theme": "dark"}))
    socket = str(scratch / "tmux.sock")
    tmux = shutil.which("tmux")
    node = shutil.which("node")
    assert tmux and node, "Install tmux and Node first"
    expected_version, pi_cli, pi_sdk = pinned_pi(repo)
    # Run the pinned devDependency, never a global install. A global `pi` is only noted.
    pi = [node, str(pi_cli)]
    global_pi = shutil.which("pi")
    env = {"HOME": str(scratch / "home"), "PI_CODING_AGENT_DIR": str(scratch / "agent"),
           "TMPDIR": str(scratch / "tmp"), "PATH": os.environ["PATH"], "TERM": "xterm-256color",
           "NODE_DISABLE_COMPILE_CACHE": "1", "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"}
    native = {"pi-web-tools-exa": "Web Tools: Exa", "pi-web-tools-parallel": "Web Tools: Parallel", "pi-web-tools-brave": "Web Tools: Brave"}
    synthetic = "pi-web-tools-verification-not-a-real-key"
    if args.mode == "native-auth":
        env.update({name: synthetic for name in ["EXA_API_KEY", "PARALLEL_API_KEY", "BRAVE_API_KEY"]})
    if args.mode == "invalid-config":
        env["PI_WEB_TOOLS_PROVIDERS"] = "verification-unknown-provider"
    if args.mode == "subagent-child":
        env["BRAVE_API_KEY"] = synthetic
    flags = ["--no-extensions", "-e", str(repo / "packages/pi-web-tools/index.ts"),
             "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
             "--no-approve", "--offline", "--no-session", "--verbose", "--tui-mode", "regular"]
    actions = []
    def t(*argv, check=True):
        return subprocess.run([tmux, "-S", socket, *argv], text=True, capture_output=True, check=check)
    def capture(label):
        text = t("capture-pane", "-p", "-t", "verify:0.0").stdout
        (evidence / (label + ".txt")).write_text(text)
        return text
    def wait(label, needle, timeout=20):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            text = capture(label)
            assert "could not register web authentication" not in text, text
            assert "Extension errors" not in text, text
            if needle in text:
                return text
            time.sleep(.2)
        raise RuntimeError(f"{label}: missing {needle!r}; inspect {evidence}")
    def send(text):
        # Drop old terminal history so subsequent waits cannot match an earlier action.
        t("clear-history", "-t", "verify:0.0")
        actions.append(text)
        t("send-keys", "-t", "verify:0.0", "-l", text)
        # Let Pi distinguish the literal text burst from the submit key.
        time.sleep(.2)
        if text.startswith("/"):
            actions.append("KEY Escape (dismiss command completion)")
            t("send-keys", "-t", "verify:0.0", "Escape")
            time.sleep(.2)
        t("send-keys", "-t", "verify:0.0", "Enter")
        time.sleep(.6)
        # Pi's command completion can consume Enter to accept an argument first.
        # Submit again only while the literal command is still in the editor.
        if text.startswith("/") and text != "/quit":
            pane = t("capture-pane", "-p", "-t", "verify:0.0").stdout
            if any(line.rstrip() == text for line in pane.splitlines()):
                actions.append("KEY Enter (submit accepted command completion)")
                t("send-keys", "-t", "verify:0.0", "Enter")
                time.sleep(.6)
    def key(name):
        actions.append("KEY " + name)
        t("send-keys", "-t", "verify:0.0", name)
        time.sleep(.4)
    def auth(label):
        path = scratch / "agent/auth.json"
        data = json.loads(path.read_text()) if path.exists() else {}
        # Synthetic-only run; retain types/presence, never resolved key values.
        summary = {k: {"type": v.get("type"), "synthetic": v.get("key") == "pi-web-tools-verification-not-a-real-key"} for k, v in data.items()}
        (evidence / (label + ".json")).write_text(json.dumps(summary, indent=2))
        return data
    def wait_auth(label, expected):
        end = time.monotonic() + 10
        while time.monotonic() < end:
            data = auth(label)
            if set(data) == set(expected):
                assert all(v.get("type") == "api_key" and v.get("key") == synthetic for v in data.values())
                return
            time.sleep(.2)
        raise AssertionError(f"{label}: unexpected credential IDs {list(data)}")
    status = "failed"
    owned_pids = set()
    try:
        version = subprocess.run([*pi, "--version"], env=env, text=True, capture_output=True, check=True).stdout.strip()
        assert version == expected_version, f"pi --version {version!r} != pinned {expected_version!r}"
        doctor_header = [f"pi version: {version} (pinned devDependency {PI_PACKAGE} {expected_version})",
                         "pi command: " + shlex.join(pi), "pi sdk: " + str(pi_sdk),
                         "global pi on PATH (noted, not run): " + (global_pi or "none")]
        print("\n".join(doctor_header), flush=True)
        (evidence / "launch.json").write_text(json.dumps({"version": version, "expectedVersion": expected_version,
            "piCommand": pi, "piSdk": str(pi_sdk), "globalPiNotRun": global_pi,
            "cwd": str(scratch / "cwd"), "env": env, "argv": [*pi, *flags]}, indent=2))
        if args.mode == "subagent-child":
            subagent_child(repo, node, pi_sdk, scratch, evidence, env, synthetic, native)
            status = "passed"
            return
        command = shlex.join(["env", "-i", *[k + "=" + v for k, v in env.items()], *pi, *flags])
        t("-f", "/dev/null", "new-session", "-d", "-s", "verify", "-x", "120", "-y", "45", "-c", str(scratch / "cwd"), command)
        owned_pids.add(int(t("display-message", "-p", "-t", "verify:0.0", "#{pane_pid}").stdout.strip()))
        t("set-option", "-t", "verify", "history-limit", "20000")
        startup = wait("startup", "Extensions")
        assert str(repo / "packages/pi-web-tools") in startup, startup
        assert "Extension errors" not in startup, startup
        panes = t("list-panes", "-t", "verify", "-F", "#{pane_pid} #{pane_current_command} #{pane_dead}").stdout
        (evidence / "doctor.txt").write_text("\n".join(doctor_header) + "\npane: " + panes)
        assert not auth("initial-auth"), "Fresh profile must have no stored credentials"
        if args.mode == "invalid-config":
            wait("invalid-config", "verification-unknown-provider")
        send("/model")
        time.sleep(.5)
        capture("model-picker")
        key("Escape")
        send("/reload")
        wait("reload", "Reloaded")
        assert not auth("after-reload"), "Baseline must not write credentials"
        if args.mode == "native-auth":
            # Native CLI, not a mock login API: Escape must leave storage unchanged.
            send("/login pi-web-tools-brave")
            wait("cancel-login-prompt", "Web Tools: Brave")
            key("Escape")
            capture("cancel-login-result")
            wait_auth("after-cancel", [])
            saved = []
            for provider, label in native.items():
                send("/login " + provider)
                wait(provider + "-login-prompt", label)
                send(synthetic)
                saved.append(provider)
                wait_auth(provider + "-after-login", saved)
                wait(provider + "-login-result", "Saved API key for " + label)
            for i in range(2):
                send("/reload")
                wait("native-reload-" + str(i + 1), "Reloaded")
                wait_auth("native-reload-auth-" + str(i + 1), saved)
                send("/login Web Tools")
                picker = wait("native-reload-providers-" + str(i + 1), "Select provider to configure:")
                # Current pane only: scrollback includes earlier login messages.
                visible = t("capture-pane", "-p", "-t", "verify:0.0").stdout.split("Select provider to configure:", 1)[-1]
                for label in native.values():
                    assert visible.count(label) == 1, visible
                key("Escape")
            for provider, label in native.items():
                send("/logout")
                wait(provider + "-logout-picker", "Select provider to logout:")
                # Filter the real selector rather than assuming provider ordering.
                t("send-keys", "-t", "verify:0.0", "-l", label)
                actions.append("FILTER " + label)
                time.sleep(.4)
                capture(provider + "-logout-filter")
                key("Enter")
                saved.remove(provider)
                wait_auth(provider + "-after-logout", saved)
                wait(provider + "-logout-result", "Removed stored API key for " + label)
            send("/logout")
            wait("logout-empty", "No stored credentials to remove")
        # Public SDK read-only second view; same sole extension, no prompts or requests.
        probe = scratch / "doctor.mjs"
        probe.write_text('''import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager} from ''' + json.dumps(pi_sdk.as_uri()) + ''';
const cwd=process.cwd(), agentDir=process.env.PI_CODING_AGENT_DIR;
const settingsManager=SettingsManager.inMemory({packages:[],cacheWarming:"off",defaultProjectTrust:"never"});
const resourceLoader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:[''' + json.dumps(str(repo / "packages/pi-web-tools/index.ts")) + ''']});
await resourceLoader.reload();
if(resourceLoader.getExtensions().errors.length) throw new Error("Extension load failed");
const {session}=await createAgentSession({cwd,agentDir,settingsManager,resourceLoader,sessionManager:SessionManager.inMemory(cwd)});
try {
 await session.bindExtensions({});
 const providers=await Promise.all(session.modelRuntime.getProviders().filter(p=>p.id.startsWith("pi-web-tools")).map(async p=>({id:p.id,name:p.name,auth:await session.modelRuntime.checkAuth(p.id)})));
 const models=session.modelRuntime.getAllModels().map(m=>({provider:m.provider,id:m.id,type:m.type}));
 const tools=session.getAllTools().map(t=>({name:t.name,description:t.description}));
 console.log(JSON.stringify({providers,extensions:resourceLoader.getExtensions().extensions.map(e=>e.path),skills:resourceLoader.getSkills().skills.length,prompts:resourceLoader.getPrompts().prompts.length,context:resourceLoader.getAgentsFiles().agentsFiles.length,tools,models},null,2));
} finally {session.dispose();}
''')
        (evidence / "catalog-doctor.mjs").write_text(probe.read_text())
        result = subprocess.run([node, str(probe)], cwd=scratch / "cwd", env=env, text=True, capture_output=True, timeout=30)
        (evidence / "catalog-doctor.json").write_text(result.stdout)
        (evidence / "catalog-doctor.stderr.txt").write_text(result.stderr)
        assert result.returncode == 0, result.stderr
        catalog = json.loads(result.stdout)
        assert {"websearch", "webfetch"} <= {tool["name"] for tool in catalog["tools"]}
        assert not any(m["provider"].startswith("pi-web-tools") for m in catalog["models"])
        assert catalog["skills"] == catalog["prompts"] == catalog["context"] == 0
        if args.mode == "invalid-config":
            assert all("Unavailable:" in tool["description"] for tool in catalog["tools"] if tool["name"] in ["websearch", "webfetch"])
        provider_ids = [p["id"] for p in catalog["providers"]]
        assert sorted(provider_ids) == sorted(native), provider_ids
        assert len(provider_ids) == len(set(provider_ids)), "Duplicate native registrations"
        if args.mode == "native-auth":
            assert all(p["auth"] and p["auth"].get("source") == env_name for p, env_name in zip(sorted(catalog["providers"], key=lambda p: p["id"]), ["BRAVE_API_KEY", "EXA_API_KEY", "PARALLEL_API_KEY"])), catalog["providers"]
        assert not auth("after-doctor"), "Read-only catalog doctor must not store credentials"
        inventory = [{"path": str(p.relative_to(scratch)), "bytes": p.stat().st_size,
                      "mode": oct(p.stat().st_mode & 0o777)} for p in sorted(scratch.rglob("*")) if p.is_file()]
        (evidence / "storage-metadata.json").write_text(json.dumps(inventory, indent=2))
        send("/quit")
        status = "passed"
    finally:
        (evidence / "actions.json").write_text(json.dumps(actions, indent=2))
        errors = []
        # Snapshot descendants before stopping the dedicated tmux server. No name-based kills.
        processes = subprocess.run(["ps", "-axo", "pid=,ppid="], text=True, capture_output=True, check=True)
        pairs = [tuple(map(int, line.split())) for line in processes.stdout.splitlines()]
        while True:
            children = {pid for pid, ppid in pairs if ppid in owned_pids}
            if children <= owned_pids:
                break
            owned_pids.update(children)
        def alive():
            live = set()
            for pid in owned_pids:
                proc = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], text=True, capture_output=True)
                if proc.returncode == 0 and proc.stdout.strip() and not proc.stdout.strip().startswith("Z"):
                    live.add(pid)
            return live
        t("kill-server", check=False)
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
        stopped = t("list-sessions", check=False).returncode != 0
        processes_stopped = not alive()
        if not stopped or not processes_stopped:
            errors.append("Owned tmux server or pane descendants still running")
        if processes_stopped:
            for attempt in range(5):
                try:
                    shutil.rmtree(scratch)
                    break
                except FileNotFoundError:
                    break
                except OSError as error:
                    if attempt == 4:
                        errors.append(str(error))
                    else:
                        time.sleep(.3)
        if scratch.exists():
            errors.append("Scratch directory remains: " + str(scratch))
        (evidence / "result.json").write_text(json.dumps({"status": status if not errors else "failed", "mode": args.mode,
            "serverStopped": stopped, "ownedPids": sorted(owned_pids), "ownedProcessesStopped": processes_stopped,
            "scratchRemoved": not scratch.exists(), "cleanupErrors": errors}, indent=2))
        print(evidence, flush=True)
        if errors:
            raise RuntimeError("Cleanup failed: " + "; ".join(errors))


if __name__ == "__main__":
    main()
