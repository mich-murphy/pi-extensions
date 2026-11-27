//! Real gateways identified through a fake `tailscale` CLI over plain loopback TCP.
//!
//! Each gateway gets an owner-only directory holding its config, socket and a fake CLI script
//! that answers `status` and `whois` from JSON files beside it, exactly as tailscaled would; no
//! check is bypassed. Linking needs two loopback addresses with distinct sources, which only
//! Linux gives: the listener's node is 127.0.0.2 and a connection to it comes from 127.0.0.1.
//! Those tests are Linux-only (CI runs on Ubuntu); the rest run on every OS.
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

const SCRIPT: &str = r#"#!/bin/sh
d=$(dirname "$0")
if [ -f "$d/delay" ]; then sleep "$(cat "$d/delay")"; fi
case "$1 $2 $3" in
"status --json --peers=false") f="$d/status.json" ;;
"whois --json "*) f="$d/whois-$3.json" ;;
*) echo "unexpected arguments" >&2; exit 2 ;;
esac
if [ -f "$f" ]; then cat "$f"; exit 0; fi
echo "no match for IP:port" >&2
exit 1
"#;

static NEXT: AtomicU64 = AtomicU64::new(1);

struct Gateway {
    name: &'static str,
    directory: PathBuf,
    child: Option<Child>,
    bound: Option<SocketAddr>,
}
impl Gateway {
    /// An owner-only directory with a fake CLI whose own node is `name` at `ip`.
    fn new(name: &'static str, ip: &str) -> Self {
        let directory = PathBuf::from("/tmp")
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!(
                "pi-ts-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&directory).expect("isolated directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("owner-only directory");
        let gateway = Self {
            name,
            directory,
            child: None,
            bound: None,
        };
        gateway.file("tailscale", SCRIPT);
        fs::set_permissions(gateway.path("tailscale"), fs::Permissions::from_mode(0o700))
            .expect("owner-only fake CLI");
        gateway.file(
            "status.json",
            &json!({"BackendState":"Running","MagicDNSSuffix":"example.ts.net","Self":{"ID":format!("n-{name}"),"DNSName":format!("{name}.example.ts.net."),"TailscaleIPs":[ip]},"CurrentTailnet":{"MagicDNSSuffix":"example.ts.net"}}).to_string(),
        );
        gateway
    }
    fn path(&self, name: &str) -> PathBuf {
        self.directory.join(name)
    }
    fn file(&self, name: &str, contents: &str) {
        fs::write(self.path(name), contents).expect("fixture file");
    }
    /// whois answers for `ip`: the node `name`, holding `caps` toward this node.
    fn knows(&self, name: &str, ip: &str, caps: &Value) {
        self.file(
            &format!("whois-{ip}.json"),
            &json!({"Node":{"ID":7,"StableID":format!("n-{name}"),"Name":format!("{name}.example.ts.net."),"Addresses":[format!("{ip}/32")],"Tags":["tag:dev"]},"UserProfile":{"LoginName":"tagged-devices"},"CapMap":{"github.com/mich-murphy/cap/pi-peers":caps}}).to_string(),
        );
    }
    fn remote(&self, mode: &str, address: &str) -> Value {
        json!({"endpoint":{"mode":mode,"address":address},"tailscale":self.path("tailscale")})
    }
    /// Writes the config: local grants on both scopes, and `remote` if given.
    fn config(&self, remote: Option<Value>) -> PathBuf {
        let mut config = json!({"machineId":self.name,"socketPath":self.path("s"),"scopeIds":["team","private"],"policies":[{"machineId":self.name,"scopeId":"team","permissions":["discover","push"]},{"machineId":self.name,"scopeId":"private","permissions":["discover","push"]}]});
        if let Some(remote) = remote {
            config["remote"] = remote;
        }
        self.write_config(&config)
    }
    fn write_config(&self, config: &Value) -> PathBuf {
        let path = self.path("config.json");
        fs::write(&path, serde_json::to_vec(config).expect("config JSON")).expect("config");
        path
    }
    fn run(&self, args: &[&str]) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .args(args)
            .arg(self.path("config.json"))
            .output()
            .expect("gateway command")
    }
    fn start(&mut self, args: &[&str], remote: Option<Value>) {
        let config = self.config(remote);
        let stderr = fs::File::create(self.path("stderr.log")).expect("stderr log");
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .args(args)
            .arg("--config")
            .arg(&config)
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .expect("gateway process");
        let mut ready = String::new();
        BufReader::new(child.stdout.take().expect("stdout"))
            .read_line(&mut ready)
            .expect("readiness line");
        assert!(!ready.is_empty(), "no readiness: {}", self.stderr());
        let parsed: Value = serde_json::from_str(&ready).expect("ready JSON");
        assert_eq!(parsed["event"], "ready", "foreground readiness");
        self.bound = parsed["remoteListenAddress"]
            .as_str()
            .map(|address| address.parse().expect("bound address"));
        self.child = Some(child);
    }
    fn address(&self) -> SocketAddr {
        self.bound.expect("a listener reports its bound address")
    }
    fn connect(&self) -> UnixStream {
        let stream = UnixStream::connect(self.path("s")).expect("local socket");
        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .expect("read timeout");
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .expect("write timeout");
        stream
    }
    fn stderr(&self) -> String {
        fs::read_to_string(self.path("stderr.log")).unwrap_or_default()
    }
    /// Waits up to 3 s for the audit log to contain `text`; the routing loop writes it after the
    /// connection it describes was already closed.
    fn logged(&self, text: &str) -> bool {
        let end = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if self.stderr().contains(text) {
                return true;
            }
            if std::time::Instant::now() >= end {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    fn stop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn rid(n: u32) -> String {
    format!("{n:032x}")
}
fn write(stream: &mut impl Write, value: &Value) {
    let bytes = serde_json::to_vec(value).expect("frame JSON");
    let length = u32::try_from(bytes.len()).expect("bounded frame");
    stream.write_all(&length.to_be_bytes()).expect("header");
    stream.write_all(&bytes).expect("body");
}
fn read_any(stream: &mut UnixStream) -> Value {
    let mut header = [0; 4];
    stream.read_exact(&mut header).expect("frame header");
    let mut body = vec![0; pi_gateway::wire::body_length(header).expect("frame length")];
    stream.read_exact(&mut body).expect("frame body");
    pi_gateway::wire::decode_body(&body, pi_gateway::wire::Role::AdapterDelivery)
        .expect("valid frame")
}
/// The next frame that is not a pushed `link.state`.
fn read(stream: &mut UnixStream) -> Value {
    loop {
        let frame = read_any(stream);
        if frame["op"] != "link.state" {
            return frame;
        }
    }
}
fn register(stream: &mut UnixStream, session: &str, n: u32) -> Value {
    write(
        stream,
        &json!({"v":2,"op":"register","rid":rid(n),"sessionId":session,"runtimeNonce":rid(n + 1000),"scopeIds":["team","private"],"label":session}),
    );
    let result = read(stream);
    assert_eq!(result["outcome"]["tag"], "ok", "registration succeeds");
    result["outcome"]["value"]["peer"].clone()
}

#[test]
fn diagnose_reports_the_tailscale_self_peer_and_caps_without_linking() {
    let alpha = Gateway::new("alpha", "127.0.0.1");
    alpha.knows(
        "beta",
        "127.0.0.2",
        &json!([{"scopes":["team"],"allow":["reply","discover"]},{"scopes":["*"],"allow":["push"]}]),
    );
    alpha.config(Some(alpha.remote("connect", "127.0.0.2:7443")));
    let diagnose = || -> Value {
        let output = alpha.run(&["--diagnose"]);
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice(&output.stdout).expect("diagnose JSON")
    };
    assert_eq!(
        diagnose(),
        json!({"version":1,"machineId":"alpha","remote":{"state":"configured","trust":"tailscale","endpoint":{"mode":"connect","address":"127.0.0.2:7443"},"self":{"name":"alpha","stableId":"n-alpha","addresses":["127.0.0.1"]},"peer":{"name":"beta","stableId":"n-beta","tags":["tag:dev"],"allow":[{"scope":"team","actions":["discover","reply"]}]}}})
    );
    fs::remove_file(alpha.path("whois-127.0.0.2.json")).expect("forget beta");
    assert_eq!(
        diagnose()["remote"],
        json!({"state":"degraded","reason":"not-tailnet-address"})
    );
    alpha.config(Some(alpha.remote("listen", "127.0.0.1:7443")));
    assert_eq!(diagnose()["remote"]["state"], "configured");
    alpha.config(Some(alpha.remote("listen", "127.0.0.3:7443")));
    assert_eq!(diagnose()["remote"]["reason"], "not-tailnet-address");
    alpha.config(None);
    assert_eq!(diagnose()["remote"], json!({"state":"disabled"}));
}

#[test]
fn an_untrusted_or_missing_cli_degrades_the_remote_but_local_sessions_still_work() {
    for case in ["missing", "writable"] {
        let mut alpha = Gateway::new("alpha", "127.0.0.1");
        let mut remote = alpha.remote("connect", "127.0.0.2:7443");
        if case == "missing" {
            remote["tailscale"] = json!(alpha.path("absent"));
        } else {
            fs::set_permissions(alpha.path("tailscale"), fs::Permissions::from_mode(0o722))
                .expect("group/world-writable fake");
        }
        alpha.start(&[], Some(remote));
        assert!(
            alpha
                .stderr()
                .contains("remote degraded: tailscale-missing"),
            "{case}: {}",
            alpha.stderr()
        );
        let mut first = alpha.connect();
        let mut second = alpha.connect();
        register(&mut first, "first", 1);
        let to = register(&mut second, "second", 2);
        write(
            &mut first,
            &json!({"v":2,"op":"send","rid":rid(3),"to":to,"scopeId":"team","budgetMs":15000,"message":{"id":rid(4),"kind":"request","content":"local","format":"text"}}),
        );
        assert_eq!(read(&mut second)["op"], "deliver", "{case}: local routing");
        let output = alpha.run(&["--diagnose"]);
        let report: Value = serde_json::from_slice(&output.stdout).expect("diagnose JSON");
        assert_eq!(
            report["remote"],
            json!({"state":"degraded","reason":"tailscale-missing"})
        );
    }
}

#[test]
fn pre_tailscale_remote_configs_never_start_and_diagnose_names_them_retired() {
    let alpha = Gateway::new("alpha", "127.0.0.1");
    let endpoint = json!({"mode":"listen","address":"127.0.0.1:0"});
    let own = json!({"machineId":"alpha","scopeId":"team","permissions":["discover"]});
    let beta = json!({"machineId":"beta","scopeId":"team","permissions":["discover"]});
    let incoming =
        json!({"machineId":"alpha","scopeId":"team","permissions":["push"],"direction":"incoming"});
    let certificates = json!({"machineId":"beta","endpoint":endpoint,"rootCertificates":["/r.der"],"certificateChain":["/l.der"],"privateKey":"/k.der","crls":["/c.crl"],"revocationState":"/f.json"});
    let keys = json!({"machineId":"beta","endpoint":endpoint,"privateKey":"/k","peerPublicKey":"ab".repeat(32)});
    let current = json!({"endpoint":endpoint});
    for (case, remote, policies) in [
        (
            "0.3.0 certificates",
            Some(&certificates),
            json!([own, beta]),
        ),
        ("pinned keys", Some(&keys), json!([own, beta])),
        ("remote policy", Some(&current), json!([own, beta])),
        ("incoming grant", None, json!([incoming])),
    ] {
        let mut config = json!({"machineId":"alpha","socketPath":alpha.path("s"),"scopeIds":["team"],"policies":policies});
        if let Some(remote) = remote {
            config["remote"] = remote.clone();
        }
        alpha.write_config(&config);
        let started = alpha.run(&["--config"]);
        assert!(!started.status.success(), "{case} never starts");
        assert!(!alpha.path("s").exists(), "{case}: nothing bound");
        let output = alpha.run(&["--diagnose"]);
        assert!(output.status.success(), "{case}: {output:?}");
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).expect("diagnose JSON"),
            json!({"version":1,"machineId":"alpha","remote":{"state":"retired-certificates"}}),
            "{case}"
        );
        config["scopeIds"] = json!(["bad scope"]);
        alpha.write_config(&config);
        assert!(
            !alpha.run(&["--diagnose"]).status.success(),
            "{case}: only the retired parts may be wrong"
        );
    }
    let legacy = json!({"machineId":"alpha","socketPath":alpha.path("s"),"scopeIds":["team"],"policies":[{"machineId":"alpha","scopeId":"team","permissions":["discover"],"direction":"outgoing"}]});
    alpha.write_config(&legacy);
    let output = alpha.run(&["--diagnose"]);
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).expect("diagnose JSON")["remote"],
        json!({"state":"disabled"}),
        "a 0.3.0 local-only config keeps working"
    );
}

#[test]
fn pending_identity_checks_are_bounded_at_four_and_killed_with_the_cli() {
    let mut beta = Gateway::new("beta", "127.0.0.1");
    beta.file("delay", "30");
    let remote = beta.remote("listen", "127.0.0.1:0");
    beta.start(&[], Some(remote));
    let address = beta.address();
    let mut pending: Vec<_> = (0..4)
        .map(|_| TcpStream::connect(address).expect("pending setup"))
        .collect();
    std::thread::sleep(Duration::from_millis(300));
    let mut excess = TcpStream::connect(address).expect("excess connection");
    excess
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .expect("timeout");
    assert_eq!(
        excess.read(&mut [0; 1]).expect("closed, not timed out"),
        0,
        "a fifth pending setup is dropped without running the CLI"
    );
    pending[0]
        .set_read_timeout(Some(Duration::from_secs(4)))
        .expect("timeout");
    assert_eq!(
        pending[0].read(&mut [0; 1]).expect("closed, not timed out"),
        0,
        "a hung CLI is killed at 2 s and the connection refused unread"
    );
    assert!(beta.logged("\"link_refused\""), "{}", beta.stderr());
}

#[cfg(target_os = "linux")]
mod linked {
    use super::*;
    use std::time::Instant;

    const ALPHA: &str = "127.0.0.1";
    const BETA: &str = "127.0.0.2";

    /// beta listening on 127.0.0.2; whois knows alpha at 127.0.0.1 holding `alpha_caps`.
    fn beta(alpha_caps: Option<&Value>, args: &[&str]) -> Gateway {
        let mut beta = Gateway::new("beta", BETA);
        if let Some(caps) = alpha_caps {
            beta.knows("alpha", ALPHA, caps);
        }
        let remote = beta.remote("listen", &format!("{BETA}:0"));
        beta.start(args, Some(remote));
        beta
    }
    /// alpha dialing `address`; whois knows beta at 127.0.0.2 holding `beta_caps`.
    fn alpha(beta_caps: &Value, address: SocketAddr) -> Gateway {
        let mut alpha = Gateway::new("alpha", ALPHA);
        alpha.knows("beta", BETA, beta_caps);
        let remote = alpha.remote("connect", &address.to_string());
        alpha.start(&[], Some(remote));
        alpha
    }
    fn remote_read(stream: &mut TcpStream) -> std::io::Result<Value> {
        let mut header = [0; 4];
        stream.read_exact(&mut header)?;
        let mut body =
            vec![0; pi_gateway::wire::body_length(header).map_err(std::io::Error::other)?];
        stream.read_exact(&mut body)?;
        pi_gateway::wire::decode_body(&body, pi_gateway::wire::Role::RemoteLink)
            .map_err(std::io::Error::other)
    }
    fn imported(n: u32) -> Value {
        json!({"peer":{"machineId":"alpha","sessionId":format!("remote-{n}"),"runtimeNonce":rid(2000 + n)},"label":"remote fixture","scopeIds":["team","private"]})
    }
    /// Links this test process to `beta` as alpha (its source address is 127.0.0.1) and answers
    /// the roster watch with `peers`. Retries while a previous link is still being torn down.
    fn link(beta: &Gateway, peers: &[Value]) -> (TcpStream, Value) {
        for _ in 0..30 {
            let mut stream = TcpStream::connect(beta.address()).expect("dial beta");
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .expect("timeout");
            if let Ok(discover) = remote_read(&mut stream) {
                assert_eq!(
                    discover["op"], "discover",
                    "first frame is the roster watch"
                );
                assert_eq!(
                    discover["scopeIds"],
                    json!(["team", "private"]),
                    "asks the remote for every own scope"
                );
                write(
                    &mut stream,
                    &json!({"v":2,"op":"result","rid":discover["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":peers,"watching":true}}}),
                );
                return (stream, discover["rid"].clone());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("beta never linked: {}", beta.stderr());
    }
    fn alive(stream: &mut TcpStream) -> bool {
        write(stream, &json!({"v":2,"op":"ping","rid":rid(3000)}));
        loop {
            match remote_read(stream) {
                Ok(frame) if frame["forOp"] == "ping" => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    }
    fn closed(stream: &mut TcpStream, within: Duration) -> bool {
        stream.set_read_timeout(Some(within)).expect("timeout");
        loop {
            match remote_read(stream) {
                Ok(_) => {}
                Err(error) => {
                    return !matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    );
                }
            }
        }
    }
    fn send(stream: &mut impl Write, to: &Value, n: u32, message: &Value) {
        write(
            stream,
            &json!({"v":2,"op":"send","rid":rid(n),"to":to,"scopeId":"team","budgetMs":15000,"message":message}),
        );
    }
    fn request(n: u32) -> Value {
        json!({"id":rid(n + 1000),"kind":"request","content":"isolated collaboration","format":"text"})
    }
    fn receipt(delivery: &Value, correlation: &str) -> Value {
        json!({"v":2,"op":"result","rid":delivery["rid"],"forOp":"deliver","outcome":{"tag":"admitted","messageId":delivery["message"]["id"],"correlation":correlation,"durable":false}})
    }
    /// Watches `team` and waits until `peer` is visible, exported in `team` only.
    fn await_peer(stream: &mut UnixStream, n: u32, peer: &Value) {
        write(
            stream,
            &json!({"v":2,"op":"discover","rid":rid(n),"scopeIds":["team"],"watch":true}),
        );
        let snapshot = read(stream);
        assert_eq!(snapshot["outcome"]["tag"], "ok", "watch snapshot");
        let found = snapshot["outcome"]["value"]["peers"]
            .as_array()
            .expect("peers")
            .iter()
            .find(|descriptor| descriptor["peer"] == *peer)
            .cloned()
            .or_else(|| {
                (0..8)
                    .map(|_| read(stream))
                    .find(|event| event["event"]["peer"]["peer"] == *peer)
                    .map(|event| event["event"]["peer"].clone())
            })
            .expect("remote peer becomes visible");
        assert_eq!(found["scopeIds"], json!(["team"]), "only the watched scope");
    }
    fn link_states(stream: &mut UnixStream, window: Duration) -> Vec<String> {
        let end = Instant::now() + window;
        let mut states = Vec::new();
        while let Some(left) = end
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
        {
            stream.set_read_timeout(Some(left)).expect("timeout");
            let mut header = [0; 4];
            if stream.read_exact(&mut header).is_err() {
                break;
            }
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("timeout");
            let mut body = vec![0; pi_gateway::wire::body_length(header).expect("length")];
            stream.read_exact(&mut body).expect("body");
            let frame: Value = serde_json::from_slice(&body).expect("frame JSON");
            if frame["op"] == "link.state" {
                assert_eq!(frame["machineId"], "beta", "named by whois");
                states.push(frame["state"].as_str().unwrap_or("").to_owned());
            }
        }
        states
    }

    #[test]
    fn two_gateways_link_route_exact_receipts_and_report_link_down_after_loss() {
        let both = json!([{"scopes":["team"],"allow":["discover","push"]}]);
        let mut beta = beta(Some(&both), &[]);
        let mut b = beta.connect();
        let beta_peer = register(&mut b, "beta-session", 1);
        let alpha = alpha(&both, beta.address());
        let mut a = alpha.connect();
        let alpha_peer = register(&mut a, "alpha-session", 2);
        let mut observer = alpha.connect();
        register(&mut observer, "observer", 3);
        await_peer(&mut observer, 4, &beta_peer);
        send(&mut a, &beta_peer, 5, &request(5));
        let delivery = read(&mut b);
        assert_eq!(delivery["op"], "deliver");
        assert_eq!(delivery["from"], alpha_peer);
        assert_eq!(delivery["to"], beta_peer);
        write(&mut b, &receipt(&delivery, "none"));
        let result = read(&mut a);
        assert_eq!(result["rid"], rid(5));
        assert_eq!(result["outcome"]["tag"], "admitted");
        send(&mut a, &beta_peer, 8, &request(8));
        let _possibly_admitted = read(&mut b);
        let audit = alpha.stderr();
        assert!(
            audit.contains("\"event\":\"link_up\"") && audit.contains("\"n-beta\""),
            "{audit}"
        );
        beta.stop();
        assert_eq!(
            read(&mut a)["outcome"]["tag"],
            "unknown",
            "link loss cannot erase possible admission"
        );
        let removed = (0..8)
            .map(|_| read(&mut observer))
            .any(|event| event["event"]["tag"] == "remove" && event["event"]["peer"] == beta_peer);
        assert!(removed, "the remote session is withdrawn");
        send(&mut a, &beta_peer, 9, &request(9));
        assert_eq!(read(&mut a)["outcome"]["code"], "link_down");
        assert!(
            alpha.logged("\"event\":\"link_down\""),
            "{}",
            alpha.stderr()
        );
    }

    #[test]
    fn a_reply_only_remote_answers_only_what_was_sent_to_it_and_only_once() {
        let beta = beta(
            Some(&json!([{"scopes":["team"],"allow":["discover","push"]}])),
            &[],
        );
        let mut b = beta.connect();
        let beta_peer = register(&mut b, "beta-session", 1);
        let alpha = alpha(
            &json!([{"scopes":["team"],"allow":["discover","reply"]}]),
            beta.address(),
        );
        let mut a = alpha.connect();
        let alpha_peer = register(&mut a, "alpha-session", 2);
        let mut observer = alpha.connect();
        register(&mut observer, "observer", 3);
        await_peer(&mut observer, 4, &beta_peer);
        let answer = |kind: &str, n: u32, to: u32| json!({"id":rid(n),"kind":kind,"content":"answer","format":"text","replyTo":{"sender":alpha_peer,"messageId":rid(to)}});
        send(&mut b, &alpha_peer, 10, &request(10));
        assert_eq!(
            read(&mut b)["outcome"],
            json!({"tag":"not_admitted","messageId":rid(1010),"code":"forbidden"}),
            "a request is never admitted under reply"
        );
        send(&mut b, &alpha_peer, 11, &answer("reply", 11, 5005));
        assert_eq!(
            read(&mut b)["outcome"]["code"],
            "forbidden",
            "nothing was sent to beta yet"
        );
        send(&mut a, &beta_peer, 5, &request(4005));
        let delivery = read(&mut b);
        write(&mut b, &receipt(&delivery, "none"));
        assert_eq!(read(&mut a)["outcome"]["tag"], "admitted");
        for (n, kind) in [(12, "update"), (13, "reply")] {
            send(&mut b, &alpha_peer, n, &answer(kind, n, 5005));
            let delivered = read(&mut a);
            assert_eq!(delivered["message"]["kind"], kind);
            write(&mut a, &receipt(&delivered, "verified"));
            assert_eq!(read(&mut b)["outcome"]["tag"], "admitted", "{kind}");
        }
        send(&mut b, &alpha_peer, 14, &answer("reply", 14, 5005));
        assert_eq!(
            read(&mut b)["outcome"]["code"],
            "forbidden",
            "a second reply is refused"
        );
        send(&mut b, &alpha_peer, 15, &answer("reply", 15, 5006));
        assert_eq!(read(&mut b)["outcome"]["code"], "forbidden", "forged id");
        assert!(alpha.logged("\"event\":\"refused\""), "{}", alpha.stderr());
        assert!(!alpha.stderr().contains("answer"), "no content in audit");
        drop(beta);
    }

    /// Two linked gateways where alpha may discover and push to beta's sessions, and beta holds
    /// only `reply` on team toward alpha, so it never receives alpha's sessions in a roster.
    /// One request from alpha's session has been admitted at beta's session.
    struct ReplyOnly {
        beta: Gateway,
        alpha: Gateway,
        a: UnixStream,
        b: UnixStream,
        other: UnixStream,
        alpha_peer: Value,
        beta_peer: Value,
        original: String,
    }

    fn reply_answer(kind: &str, n: u32, sender: &Value, to: &str) -> Value {
        json!({"id":rid(n),"kind":kind,"content":"answer","format":"text","replyTo":{"sender":sender,"messageId":to}})
    }

    fn send_in(stream: &mut UnixStream, to: &Value, n: u32, scope: &str, message: &Value) {
        write(
            stream,
            &json!({"v":2,"op":"send","rid":rid(n),"to":to,"scopeId":scope,"budgetMs":15000,"message":message}),
        );
    }

    fn reply_only_link() -> ReplyOnly {
        let beta = beta(
            Some(&json!([{"scopes":["team","private"],"allow":["discover","push"]}])),
            &[],
        );
        let mut b = beta.connect();
        let beta_peer = register(&mut b, "beta-session", 1);
        let mut other = beta.connect();
        register(&mut other, "beta-other", 2);
        let alpha = alpha(
            &json!([{"scopes":["team"],"allow":["reply"]}]),
            beta.address(),
        );
        let mut a = alpha.connect();
        let alpha_peer = register(&mut a, "alpha-session", 3);
        let mut observer = alpha.connect();
        register(&mut observer, "observer", 4);
        // Both beta sessions registered before the link, so one snapshot holds both.
        await_peer(&mut observer, 5, &beta_peer);
        let mut watcher = beta.connect();
        register(&mut watcher, "watcher", 7);
        write(
            &mut watcher,
            &json!({"v":2,"op":"discover","rid":rid(8),"scopeIds":["team"],"watch":true}),
        );
        let snapshot = read(&mut watcher);
        assert!(
            snapshot["outcome"]["value"]["peers"]
                .as_array()
                .expect("peers")
                .iter()
                .all(|descriptor| descriptor["peer"]["machineId"] == "beta"),
            "beta never sees alpha's sessions: {snapshot}"
        );
        let original = rid(1020);
        send_in(
            &mut b,
            &alpha_peer,
            10,
            "team",
            &reply_answer("reply", 10, &alpha_peer, &original),
        );
        assert_eq!(
            read(&mut b)["outcome"]["code"],
            "forbidden",
            "nothing was sent to beta yet"
        );
        send(&mut a, &beta_peer, 20, &request(20));
        let delivery = read(&mut b);
        assert_eq!(
            delivery["message"]["id"], original,
            "beta receives the original request"
        );
        assert_eq!(delivery["from"], alpha_peer, "from alpha's session");
        write(&mut b, &receipt(&delivery, "none"));
        assert_eq!(
            read(&mut a)["outcome"]["tag"],
            "admitted",
            "the request is admitted"
        );
        ReplyOnly {
            beta,
            alpha,
            a,
            b,
            other,
            alpha_peer,
            beta_peer,
            original,
        }
    }

    #[test]
    fn a_reply_only_remote_without_discover_answers_what_was_sent_to_it_once() {
        let mut link = reply_only_link();
        let to = link.alpha_peer.clone();
        for (n, kind) in [(14, "update"), (15, "reply")] {
            let answer = reply_answer(kind, n, &to, &link.original);
            send_in(&mut link.b, &to, n, "team", &answer);
            let delivered = read(&mut link.a);
            assert_eq!(delivered["message"]["kind"], kind);
            assert_eq!(delivered["from"], link.beta_peer);
            write(&mut link.a, &receipt(&delivered, "verified"));
            assert_eq!(read(&mut link.b)["outcome"]["tag"], "admitted", "{kind}");
        }
        let second = reply_answer("reply", 16, &to, &link.original);
        send_in(&mut link.b, &to, 16, "team", &second);
        assert_eq!(
            read(&mut link.b)["outcome"]["code"],
            "forbidden",
            "a second reply is refused"
        );
        assert!(
            !link.alpha.stderr().contains("answer"),
            "no content in audit"
        );
        drop(link.beta);
    }

    #[test]
    fn a_sender_seen_in_fewer_scopes_still_sends_where_caps_allow() {
        // beta may discover alpha's sessions only in team but answer in private too, so its roster
        // lists alpha's session in team alone. That must not bound where the session sends.
        let beta = beta(
            Some(&json!([{"scopes":["team","private"],"allow":["discover","push"]}])),
            &[],
        );
        let mut b = beta.connect();
        let beta_peer = register(&mut b, "beta-session", 1);
        let alpha = alpha(
            &json!([
                {"scopes":["team"],"allow":["discover","reply"]},
                {"scopes":["private"],"allow":["reply"]}
            ]),
            beta.address(),
        );
        let mut a = alpha.connect();
        let alpha_peer = register(&mut a, "alpha-session", 3);
        let mut observer = alpha.connect();
        register(&mut observer, "observer", 4);
        await_peer(&mut observer, 5, &beta_peer);
        let mut watcher = beta.connect();
        register(&mut watcher, "watcher", 7);
        await_peer(&mut watcher, 9, &alpha_peer);
        let original = request(30);
        send_in(&mut a, &beta_peer, 30, "private", &original);
        let delivery = read(&mut b);
        assert_eq!(
            delivery["message"]["id"], original["id"],
            "beta's session receives the request in private"
        );
        write(&mut b, &receipt(&delivery, "none"));
        assert_eq!(
            read(&mut a)["outcome"]["tag"],
            "admitted",
            "the request in private is admitted"
        );
        let id = original["id"].as_str().expect("message id");
        let answer = reply_answer("reply", 31, &alpha_peer, id);
        send_in(&mut b, &alpha_peer, 31, "private", &answer);
        let answered = read(&mut a);
        assert_eq!(
            answered["message"]["kind"], "reply",
            "alpha receives the reply"
        );
        write(&mut a, &receipt(&answered, "verified"));
        assert_eq!(
            read(&mut b)["outcome"]["tag"],
            "admitted",
            "the reply in private is admitted"
        );
        assert!(
            !beta.stderr().contains("link_down"),
            "the link never dropped: {}",
            beta.stderr()
        );
        drop(alpha);
    }

    #[test]
    fn a_reply_only_remote_cannot_forge_answers_or_send_requests() {
        let mut link = reply_only_link();
        let to = link.alpha_peer.clone();
        let original = link.original.clone();
        for (forger, n, scope, message, case) in [
            (false, 11, "team", rid(1021), "unknown messageId"),
            (true, 12, "team", original.clone(), "wrong from"),
            (false, 13, "private", original.clone(), "wrong scope"),
        ] {
            let stream = if forger { &mut link.other } else { &mut link.b };
            send_in(
                stream,
                &to,
                n,
                scope,
                &reply_answer("reply", n, &to, &message),
            );
            assert_eq!(read(stream)["outcome"]["code"], "forbidden", "{case}");
        }
        send_in(&mut link.b, &to, 17, "team", &request(17));
        assert_eq!(
            read(&mut link.b)["outcome"]["code"],
            "no_route",
            "a request never leaves beta for a session it was not shown"
        );
        let mut disguised = reply_answer("reply", 18, &to, &original);
        disguised["kind"] = json!("request");
        send_in(&mut link.b, &to, 18, "team", &disguised);
        assert_eq!(
            read(&mut link.b)["outcome"]["code"],
            "forbidden",
            "alpha never admits a request under reply, even one carrying replyTo"
        );
        let audit = link.alpha.stderr();
        assert!(audit.contains("\"reason\":\"caps\""), "{audit}");
        assert!(!audit.contains("answer"), "no content in audit");
        drop(link.beta);
    }

    #[test]
    fn a_link_the_listener_refuses_never_reports_up() {
        let beta = beta(None, &[]);
        let alpha = alpha(
            &json!([{"scopes":["team"],"allow":["discover"]}]),
            beta.address(),
        );
        let mut a = alpha.connect();
        register(&mut a, "alpha-session", 1);
        let states = link_states(&mut a, Duration::from_secs(3));
        assert!(!states.is_empty(), "every session is told the link state");
        assert!(
            !states.iter().any(|state| state == "up"),
            "never up before the peer's roster: {states:?}"
        );
        let audit = beta.stderr();
        assert!(
            audit.contains("\"link_refused\"") && audit.contains("not-found"),
            "{audit}"
        );
    }

    #[test]
    fn an_unknown_source_is_closed_before_any_byte_and_a_known_one_links() {
        let mut beta = Gateway::new("beta", BETA);
        let remote = beta.remote("listen", &format!("{BETA}:0"));
        beta.start(&[], Some(remote));
        let mut stream = TcpStream::connect(beta.address()).expect("dial beta");
        assert!(
            closed(&mut stream, Duration::from_secs(3)),
            "whois does not know 127.0.0.1: closed without a frame"
        );
        beta.knows("alpha", ALPHA, &json!([]));
        let mut stream = TcpStream::connect(beta.address()).expect("dial beta");
        assert!(
            closed(&mut stream, Duration::from_secs(3)),
            "a node holding no caps is refused"
        );
        assert!(beta.logged("no-caps"), "{}", beta.stderr());
        beta.knows(
            "alpha",
            ALPHA,
            &json!([{"scopes":["team"],"allow":["discover"]}]),
        );
        let (mut stream, _) = link(&beta, &[]);
        assert!(alive(&mut stream));
    }

    #[test]
    fn malformed_rosters_and_unadvertised_sources_close_the_link() {
        let beta = beta(
            Some(&json!([{"scopes":["team","private"],"allow":["discover","push"]}])),
            &[],
        );
        for case in 0..5 {
            let mut advertised = imported(0);
            if case == 0 {
                advertised["peer"]["machineId"] = json!("gamma");
            }
            if case == 1 {
                advertised["scopeIds"] = json!(["team", "elsewhere"]);
            }
            let mut stream = loop {
                let mut stream = TcpStream::connect(beta.address()).expect("dial beta");
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .expect("timeout");
                if let Ok(discover) = remote_read(&mut stream) {
                    if case == 2 {
                        write(
                            &mut stream,
                            &json!({"v":2,"op":"roster.event","rid":discover["rid"],"event":{"tag":"upsert","peer":advertised}}),
                        );
                    } else {
                        write(
                            &mut stream,
                            &json!({"v":2,"op":"result","rid":discover["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":[advertised],"watching":true}}}),
                        );
                    }
                    break stream;
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            if case >= 3 {
                let mut from = advertised["peer"].clone();
                if case == 3 {
                    from["machineId"] = json!("gamma");
                } else {
                    from["runtimeNonce"] = json!(rid(801));
                }
                write(
                    &mut stream,
                    &json!({"v":2,"op":"send","rid":rid(802),"from":from,"to":{"machineId":"beta","sessionId":"none","runtimeNonce":rid(803)},"scopeId":"team","budgetMs":15000,"message":request(804)}),
                );
            }
            if case == 4 {
                // A sender the remote never advertised (it may hold no discover here) is
                // answered, not dropped: caps and routing decide.
                assert_eq!(
                    answer_to(&mut stream, &rid(802))["outcome"]["code"],
                    "no_route",
                    "an unadvertised sender of the linked machine is routed"
                );
                assert!(alive(&mut stream), "and the link stays up");
                continue;
            }
            assert!(
                closed(&mut stream, Duration::from_secs(3)),
                "case {case} closes the link"
            );
        }
    }

    #[test]
    fn caps_decide_per_grant_entry_what_is_exported_and_admitted() {
        let mut beta = beta(
            Some(&json!([
                {"scopes":["team"],"allow":["push"]},
                {"scopes":["private"],"allow":["discover"]}
            ])),
            &[],
        );
        let mut receiver = beta.connect();
        let target = register(&mut receiver, "receiver", 1);
        let (mut stream, _) = link(&beta, &[imported(0)]);
        write(
            &mut stream,
            &json!({"v":2,"op":"discover","rid":rid(900),"scopeIds":["team","private"],"watch":false}),
        );
        let exported = remote_read(&mut stream).expect("export");
        assert_eq!(
            exported["outcome"]["value"]["peers"][0]["scopeIds"],
            json!(["private"]),
            "export is filtered by discover; push on team grants no discovery"
        );
        let origin = imported(0)["peer"].clone();
        let push = |n: u32, scope: &str, to: &Value| json!({"v":2,"op":"send","rid":rid(n),"from":origin,"to":to,"scopeId":scope,"budgetMs":15000,"message":request(n)});
        for (n, scope, to) in [
            (901, "private", target.clone()),
            (
                902,
                "team",
                json!({"machineId":"gamma","sessionId":"s","runtimeNonce":rid(9)}),
            ),
        ] {
            write(&mut stream, &push(n, scope, &to));
            let refused = remote_read(&mut stream).expect("answered");
            assert_eq!(refused["rid"], rid(n));
            assert_eq!(refused["outcome"]["code"], "forbidden", "{scope}");
        }
        write(&mut stream, &push(903, "team", &target));
        assert_eq!(read(&mut receiver)["message"]["id"], rid(1903));
        assert!(alive(&mut stream), "refusals keep the link");
        let audit = beta.stderr();
        assert!(audit.contains("\"reason\":\"caps\""), "{audit}");
        assert!(audit.contains("\"reason\":\"transit\""), "{audit}");
        beta.stop();
    }

    #[test]
    fn a_second_identified_connection_is_refused_while_one_is_linked() {
        let beta = beta(Some(&json!([{"scopes":["team"],"allow":["push"]}])), &[]);
        let (mut first, _) = link(&beta, &[]);
        let mut second = TcpStream::connect(beta.address()).expect("dial beta");
        assert!(closed(&mut second, Duration::from_secs(3)), "busy");
        assert!(alive(&mut first), "the active link is unaffected");
    }

    #[test]
    fn retired_requests_are_refused_and_the_link_survives() {
        let beta = beta(Some(&json!([{"scopes":["team"],"allow":["push"]}])), &[]);
        let mut receiver = beta.connect();
        let target = register(&mut receiver, "receiver", 1);
        let (mut stream, _) = link(&beta, &[imported(0)]);
        let origin = imported(0)["peer"].clone();
        let work = json!({"kind":"request","origin":origin,"requestId":rid(6100)});
        for request in [
            json!({"v":2,"op":"state.get","rid":rid(6001),"from":origin,"publisher":target,"scopeId":"team","key":"report"}),
            json!({"v":2,"op":"state.list","rid":rid(6002),"from":origin,"publisher":target,"scopeId":"team"}),
            json!({"v":2,"op":"interest.add","rid":rid(6003),"from":origin,"publisher":target,"scopeId":"team","work":work}),
            json!({"v":2,"op":"interest.remove","rid":rid(6004),"from":origin,"publisher":target,"scopeId":"team","work":work}),
        ] {
            write(&mut stream, &request);
            let refused = remote_read(&mut stream).expect("answered, link open");
            assert_eq!(refused["rid"], request["rid"]);
            assert_eq!(
                refused["outcome"],
                json!({"tag":"error","code":"forbidden"})
            );
        }
        write(
            &mut stream,
            &json!({"v":2,"op":"send","rid":rid(6005),"from":origin,"to":target,"scopeId":"team","budgetMs":15000,"message":request(6005)}),
        );
        assert_eq!(read(&mut receiver)["message"]["id"], rid(7005));
    }

    #[test]
    fn thirty_imported_sessions_link_and_the_thirty_first_closes() {
        let beta = beta(Some(&json!([{"scopes":["team"],"allow":["push"]}])), &[]);
        for (snapshot, upserts, survives) in
            [(30, 0, true), (31, 0, false), (29, 1, true), (30, 1, false)]
        {
            let peers: Vec<_> = (0..snapshot).map(imported).collect();
            let (mut stream, watch) = link(&beta, &peers);
            for index in 0..upserts {
                write(
                    &mut stream,
                    &json!({"v":2,"op":"roster.event","rid":watch,"event":{"tag":"upsert","peer":imported(snapshot + index)}}),
                );
            }
            assert_eq!(
                alive(&mut stream),
                survives,
                "{snapshot} sessions plus {upserts} upserts"
            );
            drop(stream);
        }
    }

    #[test]
    fn two_hundred_fifty_six_remote_operations_and_the_next_is_overloaded() {
        let beta = beta(Some(&json!([{"scopes":["team"],"allow":["push"]}])), &[]);
        let mut receiver = beta.connect();
        let target = register(&mut receiver, "receiver", 1);
        let (mut stream, _) = link(&beta, &[imported(0)]);
        let origin = imported(0)["peer"].clone();
        let push = |n: u32| json!({"v":2,"op":"send","rid":rid(4000 + n),"from":origin,"to":target,"scopeId":"team","budgetMs":15000,"message":request(5000 + n)});
        for n in 0..256 {
            write(&mut stream, &push(n));
            assert_eq!(read(&mut receiver)["message"]["id"], rid(6000 + n));
        }
        write(&mut stream, &push(256));
        let refused = remote_read(&mut stream).expect("answered");
        assert_eq!(refused["outcome"]["code"], "overloaded");
        assert_eq!(refused["outcome"]["resource"], "operations");
    }

    /// The next remote frame answering `rid`, skipping the gateway's own pings and events.
    fn answer_to(stream: &mut TcpStream, rid: &str) -> Value {
        loop {
            let frame = remote_read(stream).expect("answered, link open");
            if frame["rid"] == rid && frame["op"] == "result" {
                return frame;
            }
        }
    }
    /// Accepts alpha's dial on `listener` within 5 s, as the test process playing beta.
    fn accept(listener: &std::net::TcpListener, alpha: &Gateway) -> TcpStream {
        listener.set_nonblocking(true).expect("nonblocking");
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).expect("blocking");
                    stream
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .expect("timeout");
                    return stream;
                }
                Err(_) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
                Err(error) => panic!("alpha never dialed ({error}): {}", alpha.stderr()),
            }
        }
    }

    /// The parsed `link_up` audit line, waiting up to 3 s for it.
    fn link_up(gateway: &Gateway) -> Value {
        assert!(
            gateway.logged("\"event\":\"link_up\""),
            "{}",
            gateway.stderr()
        );
        gateway
            .stderr()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|line| line["event"] == "link_up")
            .expect("link_up line")
    }

    #[test]
    fn link_up_audit_names_the_peer_login() {
        let beta = beta(Some(&json!([{"scopes":["team"],"allow":["push"]}])), &[]);
        let (mut stream, _) = link(&beta, &[]);
        assert!(alive(&mut stream));
        let line = link_up(&beta);
        assert_eq!(line["stableId"], "n-alpha");
        assert_eq!(line["loginName"], "tagged-devices", "{line}");
        drop(stream);
        drop(beta);
        let beta = Gateway::new("beta", BETA);
        beta.file(
            &format!("whois-{ALPHA}.json"),
            &json!({"Node":{"ID":7,"StableID":"n-alpha","Name":"alpha.example.ts.net.","Addresses":[format!("{ALPHA}/32")]},"UserProfile":{"ID":3,"LoginName":"alice@example.com","DisplayName":"Alice"},"CapMap":{"github.com/mich-murphy/cap/pi-peers":[{"scopes":["team"],"allow":["push"]}]}}).to_string(),
        );
        let mut beta = beta;
        let remote = beta.remote("listen", &format!("{BETA}:0"));
        beta.start(&[], Some(remote));
        let (mut stream, _) = link(&beta, &[]);
        assert!(alive(&mut stream));
        let line = link_up(&beta);
        assert_eq!(line["loginName"], "alice@example.com", "{line}");
        assert!(
            !beta.stderr().contains("Alice"),
            "only the login name is logged"
        );
    }

    #[test]
    fn a_connector_whose_listener_holds_no_caps_stays_linked_and_refuses_its_frames() {
        // The test process is beta, listening on 127.0.0.2; alpha's whois says beta holds no caps.
        let listener = std::net::TcpListener::bind(format!("{BETA}:0")).expect("listen as beta");
        let alpha = alpha(&json!([]), listener.local_addr().expect("bound"));
        let mut a = alpha.connect();
        let alpha_peer = register(&mut a, "alpha-session", 1);
        let mut stream = accept(&listener, &alpha);
        let discover = remote_read(&mut stream).expect("roster watch");
        assert_eq!(discover["op"], "discover", "the link is set up");
        let beta_session = json!({"peer":{"machineId":"beta","sessionId":"beta-session","runtimeNonce":rid(2100)},"label":"remote fixture","scopeIds":["team"]});
        write(
            &mut stream,
            &json!({"v":2,"op":"result","rid":discover["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":[beta_session],"watching":true}}}),
        );
        let mut observer = alpha.connect();
        register(&mut observer, "observer", 2);
        await_peer(&mut observer, 3, &beta_session["peer"]);
        write(
            &mut stream,
            &json!({"v":2,"op":"discover","rid":rid(10),"scopeIds":["team","private"],"watch":false}),
        );
        assert_eq!(
            answer_to(&mut stream, &rid(10))["outcome"]["value"]["peers"],
            json!([]),
            "nothing is exported without discover"
        );
        let origin = beta_session["peer"].clone();
        let push = |n: u32, message: Value| json!({"v":2,"op":"send","rid":rid(n),"from":origin,"to":alpha_peer,"scopeId":"team","budgetMs":15000,"message":message});
        let forged = json!({"id":rid(1012),"kind":"reply","content":"answer","format":"text","replyTo":{"sender":alpha_peer,"messageId":rid(77)}});
        for (n, message) in [(11, request(11)), (12, forged)] {
            write(&mut stream, &push(n, message));
            assert_eq!(
                answer_to(&mut stream, &rid(n))["outcome"]["code"],
                "forbidden",
                "frame {n} is refused"
            );
        }
        assert!(alive(&mut stream), "refusals keep the link");
        assert!(alpha.logged("\"reason\":\"caps\""), "{}", alpha.stderr());
        // Refreshes apply the caps as they change and never close the connector's link.
        alpha.knows("beta", BETA, &json!([{"scopes":["team"],"allow":["push"]}]));
        std::thread::sleep(Duration::from_secs(17));
        write(&mut stream, &push(13, request(13)));
        assert_eq!(read(&mut a)["message"]["id"], rid(1013), "push granted");
        alpha.knows("beta", BETA, &json!([]));
        std::thread::sleep(Duration::from_secs(17));
        write(&mut stream, &push(14, request(14)));
        assert_eq!(
            answer_to(&mut stream, &rid(14))["outcome"]["code"],
            "forbidden",
            "push withdrawn"
        );
        assert!(alive(&mut stream), "empty caps on refresh keep the link");
        let audit = alpha.stderr();
        assert!(
            audit.contains("\"caps_changed\"") && !audit.contains("link_revoked"),
            "{audit}"
        );
    }

    #[test]
    fn revoking_the_caps_closes_the_link_at_the_next_refresh() {
        let caps = json!([{"scopes":["team"],"allow":["push"]}]);
        let beta = beta(Some(&caps), &[]);
        let (mut stream, _) = link(&beta, &[]);
        beta.knows("alpha", ALPHA, &json!([]));
        let started = Instant::now();
        assert!(
            closed(&mut stream, Duration::from_secs(25)),
            "empty caps close the link"
        );
        assert!(
            started.elapsed() <= Duration::from_secs(20),
            "within one refresh"
        );
        let audit = beta.stderr();
        assert!(
            audit.contains("\"link_revoked\"") && audit.contains("no-caps"),
            "{audit}"
        );
    }

    #[test]
    fn a_linked_remote_does_not_keep_a_managed_gateway_alive() {
        let mut beta = beta(
            Some(&json!([{"scopes":["team"],"allow":["push"]}])),
            &["--managed"],
        );
        let mut local = beta.connect();
        register(&mut local, "local", 1);
        let (mut stream, _) = link(&beta, &[]);
        assert!(alive(&mut stream));
        drop(local);
        let child = beta.child.as_mut().expect("running");
        let end = Instant::now() + Duration::from_secs(3);
        let status = loop {
            if let Some(status) = child.try_wait().expect("status") {
                break Some(status);
            }
            if Instant::now() >= end {
                break None;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        assert!(
            status.is_some_and(|status| status.success()),
            "an empty local roster ends a managed gateway, link or not"
        );
        assert!(!beta.path("s").exists());
    }
}
