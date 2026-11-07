//! Real foreground gateway pairs over isolated loopback TCP and generated private PKI.
use super::{Authority, CredentialDirectory};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::{Value, json};

struct Process {
    child: Child,
    directory: CredentialDirectory,
}
impl Process {
    fn start(
        ca: &Authority,
        own: &str,
        peer: &str,
        mode: &str,
        address: std::net::SocketAddr,
        policies: &Value,
    ) -> Self {
        let directory = CredentialDirectory::new();
        drop(directory.settings(ca, own, peer, mode, address));
        let base = &directory.0;
        let config = json!({"machineId":own,"socketPath":base.join("s"),"scopeIds":["team","private"],"policies":policies,"remote":{"machineId":peer,"endpoint":{"mode":mode,"address":address.to_string()},"rootCertificates":[base.join("root.der")],"certificateChain":[base.join("leaf.der")],"privateKey":base.join("key.der"),"crls":[base.join("current.crl")],"revocationState":base.join("floors.json")}});
        let path = base.join("config.json");
        fs::write(
            &path,
            serde_json::to_vec(&config)
                .expect("isolated generated-PKI process fixture and bounded framed I/O"),
        )
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
        Self::spawn(directory, &path)
    }
    fn spawn(directory: CredentialDirectory, config: &PathBuf) -> Self {
        Self {
            child: Self::child(config),
            directory,
        }
    }
    fn child(config: &PathBuf) -> Child {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-session-gateway"))
            .arg("--config")
            .arg(config)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("isolated generated-PKI process fixture and bounded framed I/O");
        let mut ready = String::new();
        BufReader::new(
            child
                .stdout
                .take()
                .expect("isolated generated-PKI process fixture and bounded framed I/O"),
        )
        .read_line(&mut ready)
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
        assert!(
            !ready.is_empty(),
            "remote-enabled foreground process must reach readiness: {:?}",
            child.try_wait()
        );
        let parsed: Value = serde_json::from_str(&ready)
            .expect("isolated generated-PKI process fixture and bounded framed I/O");
        assert_eq!(parsed["event"], "ready", "foreground readiness");
        child
    }
    fn terminate(&mut self) {
        let pid = rustix::process::Pid::from_raw(
            i32::try_from(self.child.id()).expect("test process PID fits OS pid_t"),
        )
        .expect("positive child PID");
        rustix::process::kill_process(pid, rustix::process::Signal::TERM)
            .expect("terminate isolated foreground fixture");
        assert!(
            self.child.wait().expect("wait fixture").success(),
            "controlled shutdown exits normally"
        );
    }
    fn restart(&mut self) {
        self.child = Self::child(&self.directory.0.join("config.json"));
    }
    fn connect(&self) -> UnixStream {
        let stream = UnixStream::connect(self.directory.0.join("s"))
            .expect("isolated generated-PKI process fixture and bounded framed I/O");
        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .expect("isolated generated-PKI process fixture and bounded framed I/O");
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .expect("isolated generated-PKI process fixture and bounded framed I/O");
        stream
    }
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.stop();
    }
}
fn rid(n: u32) -> String {
    format!("{n:032x}")
}
fn write(stream: &mut UnixStream, value: &Value) {
    let bytes = serde_json::to_vec(value)
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
    stream
        .write_all(
            &u32::try_from(bytes.len())
                .expect("isolated generated-PKI process fixture and bounded framed I/O")
                .to_be_bytes(),
        )
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
    stream
        .write_all(&bytes)
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
}
fn read(stream: &mut UnixStream) -> Value {
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
    let length = pi_session_gateway::wire::body_length(header)
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
    pi_session_gateway::wire::decode_body(&bytes, pi_session_gateway::wire::Role::AdapterDelivery)
        .expect("isolated generated-PKI process fixture and bounded framed I/O")
}
fn register(stream: &mut UnixStream, session: &str, n: u32) -> Value {
    write(
        stream,
        &json!({"v":1,"op":"register","rid":rid(n),"sessionId":session,"runtimeNonce":rid(n+1000),"scopeIds":["team","private"],"label":session}),
    );
    let result = read(stream);
    assert_eq!(result["outcome"]["tag"], "ok", "registration succeeds");
    result["outcome"]["value"]["peer"].clone()
}
fn watch(stream: &mut UnixStream, n: u32) -> Value {
    write(
        stream,
        &json!({"v":1,"op":"discover","rid":rid(n),"scopeIds":["team"],"watch":true}),
    );
    let snapshot = read(stream);
    assert_eq!(
        snapshot["outcome"]["tag"], "ok",
        "watch snapshot precedes events"
    );
    snapshot
}
fn await_peer(stream: &mut UnixStream, snapshot: &Value, peer: &Value) {
    if let Some(descriptor) = snapshot["outcome"]["value"]["peers"]
        .as_array()
        .expect("isolated generated-PKI process fixture and bounded framed I/O")
        .iter()
        .find(|descriptor| descriptor["peer"] == *peer)
    {
        assert_eq!(
            descriptor["scopeIds"],
            json!(["team"]),
            "initial snapshot must also truncate private scope memberships"
        );
        return;
    }
    for _ in 0..8 {
        let event = read(stream);
        assert_eq!(event["op"], "roster.event", "ordered watch event");
        if event["event"]["peer"]["peer"] == *peer {
            assert_eq!(
                event["event"]["peer"]["scopeIds"],
                json!(["team"]),
                "remote discovery cannot reveal private membership"
            );
            return;
        }
    }
    panic!("expected bounded peer upsert");
}
fn address() -> std::net::SocketAddr {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .expect("isolated generated-PKI process fixture and bounded framed I/O");
    listener
        .local_addr()
        .expect("isolated generated-PKI process fixture and bounded framed I/O")
}
fn grants(peer: &str) -> Value {
    json!([{"machineId":peer,"scopeId":"team","permissions":["discover","push","read","interest"]},{"machineId":peer,"scopeId":"team","direction":"incoming","permissions":["push","read","interest"]}])
}
fn receipt(delivery: &Value) -> Value {
    json!({"v":1,"op":"result","rid":delivery["rid"],"forOp":"deliver","outcome":{"tag":"admitted","binding":{"messageId":delivery["message"]["id"],"sender":delivery["from"],"recipient":delivery["to"],"scopeId":delivery["scopeId"]},"correlation":"none"}})
}
fn send(stream: &mut UnixStream, to: &Value, n: u32) {
    write(
        stream,
        &json!({"v":1,"op":"send","rid":rid(n),"to":to,"scopeId":"team","message":{"id":rid(n+1000),"kind":"request","content":"isolated collaboration","format":"text"}}),
    );
}

#[test]
fn two_real_daemons_route_exact_receipts_read_interest_and_withdraw_without_replay() {
    let ca = Authority::new("two-process private test CA");
    let address = address();
    let mut beta = Process::start(&ca, "beta", "alpha", "listen", address, &grants("alpha"));
    let mut b = beta.connect();
    let beta_peer = register(&mut b, "beta-session", 1);
    let mut alpha = Process::start(&ca, "alpha", "beta", "connect", address, &grants("beta"));
    let mut a = alpha.connect();
    let alpha_peer = register(&mut a, "alpha-session", 2);
    let mut observer = alpha.connect();
    register(&mut observer, "observer", 3);
    let snapshot = watch(&mut observer, 4);
    await_peer(&mut observer, &snapshot, &beta_peer);
    send(&mut a, &beta_peer, 5);
    let delivery = read(&mut b);
    assert_eq!(delivery["op"], "deliver");
    assert_eq!(delivery["from"], alpha_peer);
    assert_eq!(delivery["to"], beta_peer);
    write(&mut b, &receipt(&delivery));
    let result = read(&mut a);
    assert_eq!(result["rid"], rid(5));
    assert_eq!(result["forOp"], "send");
    assert_eq!(result["outcome"]["tag"], "admitted");
    write(
        &mut a,
        &json!({"v":1,"op":"state.list","rid":rid(6),"publisher":beta_peer,"scopeId":"team"}),
    );
    let query = read(&mut b);
    assert_eq!(query["from"], alpha_peer);
    write(
        &mut b,
        &json!({"v":1,"op":"result","rid":query["rid"],"forOp":"state.list","outcome":{"tag":"ok","value":{"publisher":beta_peer,"scopeId":"team","revision":0,"items":[]}}}),
    );
    assert_eq!(read(&mut a)["outcome"]["tag"], "ok");
    let work = json!({"kind":"request","origin":alpha_peer,"requestId":rid(1005)});
    write(
        &mut a,
        &json!({"v":1,"op":"interest.add","rid":rid(7),"publisher":beta_peer,"scopeId":"team","work":work}),
    );
    let interest = read(&mut b);
    assert_eq!(interest["from"], alpha_peer);
    write(
        &mut b,
        &json!({"v":1,"op":"result","rid":interest["rid"],"forOp":"interest.add","outcome":{"tag":"ok","value":{"publisher":beta_peer,"scopeId":"team","work":work,"active":true,"expiresInMs":86_400_000}}}),
    );
    assert_eq!(read(&mut a)["outcome"]["value"]["active"], true);
    send(&mut a, &beta_peer, 8);
    let _possibly_admitted = read(&mut b);
    beta.stop();
    assert_eq!(
        read(&mut a)["outcome"]["tag"],
        "unknown",
        "link loss cannot erase possible admission"
    );
    let remove = read(&mut observer);
    assert_eq!(remove["event"]["tag"], "remove");
    assert_eq!(remove["event"]["peer"], beta_peer);
    send(&mut a, &beta_peer, 9);
    assert_eq!(read(&mut a)["outcome"]["code"], "no_route");
    alpha.stop();
}

#[test]
fn real_pair_push_only_does_not_require_discover_and_incoming_ceiling_is_independent() {
    let ca = Authority::new("push-only two-process CA");
    let address = address();
    let beta_policy = json!([{"machineId":"alpha","scopeId":"team","permissions":["discover","read","push"]},{"machineId":"alpha","scopeId":"team","direction":"incoming","permissions":["push"]}]);
    let beta = Process::start(&ca, "beta", "alpha", "listen", address, &beta_policy);
    let mut b = beta.connect();
    let beta_peer = register(&mut b, "beta", 20);
    let alpha_policy = json!([{"machineId":"beta","scopeId":"team","permissions":["push","read"]},{"machineId":"beta","scopeId":"team","direction":"incoming","permissions":["read"]}]);
    let alpha = Process::start(&ca, "alpha", "beta", "connect", address, &alpha_policy);
    let mut a = alpha.connect();
    let alpha_peer = register(&mut a, "alpha", 21);
    let mut observer = beta.connect();
    register(&mut observer, "observer", 22);
    let snapshot = watch(&mut observer, 23);
    await_peer(&mut observer, &snapshot, &alpha_peer);
    // A real round trip binds beta as a source at alpha; no discover call at alpha.
    write(
        &mut b,
        &json!({"v":1,"op":"state.list","rid":rid(24),"publisher":alpha_peer,"scopeId":"team"}),
    );
    let query = read(&mut a);
    assert_eq!(query["op"], "state.list");
    write(
        &mut a,
        &json!({"v":1,"op":"result","rid":query["rid"],"forOp":"state.list","outcome":{"tag":"ok","value":{"publisher":alpha_peer,"scopeId":"team","revision":0,"items":[]}}}),
    );
    read(&mut b);
    write(
        &mut a,
        &json!({"v":1,"op":"discover","rid":rid(25),"scopeIds":["team"],"watch":false}),
    );
    assert_eq!(read(&mut a)["outcome"]["code"], "forbidden");
    send(&mut a, &beta_peer, 26);
    let delivery = read(&mut b);
    write(&mut b, &receipt(&delivery));
    assert_eq!(
        read(&mut a)["outcome"]["tag"],
        "admitted",
        "push is independent of discovery"
    );
    send(&mut b, &alpha_peer, 27);
    assert_eq!(
        read(&mut b)["outcome"]["code"],
        "forbidden",
        "outgoing adapter capability cannot exceed peer gateway incoming grant"
    );
    write(
        &mut a,
        &json!({"v":1,"op":"state.list","rid":rid(28),"publisher":beta_peer,"scopeId":"team"}),
    );
    assert_eq!(
        read(&mut a)["outcome"]["code"],
        "forbidden",
        "read requires a separate receiving gateway grant"
    );
}

async fn remote_write<S: tokio::io::AsyncWrite + Unpin>(stream: &mut S, value: &Value) {
    use tokio::io::AsyncWriteExt;
    let bytes = serde_json::to_vec(value).expect("generated remote frame");
    stream
        .write_all(
            &u32::try_from(bytes.len())
                .expect("bounded frame")
                .to_be_bytes(),
        )
        .await
        .expect("local TLS write");
    stream.write_all(&bytes).await.expect("local TLS body");
}
async fn remote_read<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<Value> {
    use tokio::io::AsyncReadExt;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    let mut bytes =
        vec![0; pi_session_gateway::wire::body_length(header).map_err(std::io::Error::other)?];
    stream.read_exact(&mut bytes).await?;
    pi_session_gateway::wire::decode_body(&bytes, pi_session_gateway::wire::Role::RemoteLink)
        .map_err(std::io::Error::other)
}
fn descriptor(machine: &str) -> Value {
    json!({"peer":{"machineId":machine,"sessionId":"remote","runtimeNonce":rid(800)},"label":"remote fixture","scopeIds":["team"]})
}

#[tokio::test]
async fn real_daemon_rejects_third_machine_private_scope_pre_snapshot_event_and_unadvertised_source()
 {
    let ca = Authority::new("adversarial process CA");
    let address = address();
    let beta = Process::start(&ca, "beta", "alpha", "listen", address, &grants("alpha"));
    for case in 0..5 {
        let directory = CredentialDirectory::new();
        let prepared = directory
            .settings(&ca, "alpha", "beta", "connect", address)
            .prepare("alpha")
            .unwrap();
        let (mut stream, _lease) = prepared.connect().await.unwrap().into_parts();
        let discover = remote_read(&mut stream).await.unwrap();
        assert_eq!(discover["op"], "discover");
        let mut advertised = descriptor("alpha");
        if case == 0 {
            advertised["peer"]["machineId"] = json!("gamma");
        }
        if case == 1 {
            advertised["scopeIds"] = json!(["team", "private"]);
        }
        if case == 2 {
            remote_write(&mut stream,&json!({"v":1,"op":"roster.event","rid":discover["rid"],"event":{"tag":"upsert","peer":advertised}})).await;
        } else {
            remote_write(&mut stream,&json!({"v":1,"op":"result","rid":discover["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":[advertised],"watching":true}}})).await;
            if case >= 3 {
                let from = if case == 3 {
                    descriptor("gamma")["peer"].clone()
                } else {
                    let mut peer = advertised["peer"].clone();
                    peer["runtimeNonce"] = json!(rid(801));
                    peer
                };
                remote_write(&mut stream,&json!({"v":1,"op":"send","rid":rid(802),"from":from,"to":{"machineId":"beta","sessionId":"no-runtime","runtimeNonce":rid(803)},"scopeId":"team","message":{"id":rid(804),"kind":"request","content":"must not route","format":"text"}})).await;
            }
        }
        let closed = tokio::time::timeout(Duration::from_secs(3), remote_read(&mut stream)).await;
        assert!(
            closed.is_ok_and(|result| result.is_err()),
            "daemon must close malformed authenticated roster/source case {case}"
        );
    }
    drop(beta);
}

#[tokio::test]
async fn real_daemon_authenticates_identity_and_rejects_transit_but_keeps_valid_link() {
    let ca = Authority::new("identity and transit process CA");
    let address = address();
    let beta = Process::start(&ca, "beta", "alpha", "listen", address, &grants("alpha"));
    let impostor_directory = CredentialDirectory::new();
    let impostor = impostor_directory
        .settings(&ca, "impostor", "beta", "connect", address)
        .prepare("impostor")
        .unwrap();
    if let Ok(authenticated) = impostor.connect().await {
        let (mut stream, _lease) = authenticated.into_parts();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), remote_read(&mut stream))
                .await
                .unwrap()
                .is_err(),
            "trusted wrong client SAN cannot become an application link"
        );
    }
    let directory = CredentialDirectory::new();
    let prepared = directory
        .settings(&ca, "alpha", "beta", "connect", address)
        .prepare("alpha")
        .unwrap();
    let (mut stream, _lease) = prepared.connect().await.unwrap().into_parts();
    let discover = remote_read(&mut stream).await.unwrap();
    let advertised = descriptor("alpha");
    remote_write(&mut stream,&json!({"v":1,"op":"result","rid":discover["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":[advertised],"watching":true}}})).await;
    remote_write(&mut stream,&json!({"v":1,"op":"send","rid":rid(850),"from":advertised["peer"],"to":descriptor("gamma")["peer"],"scopeId":"team","message":{"id":rid(851),"kind":"request","content":"no transit","format":"text"}})).await;
    let rejection = remote_read(&mut stream).await.unwrap();
    assert_eq!(rejection["outcome"]["tag"], "not_admitted");
    assert_eq!(rejection["outcome"]["code"], "forbidden");
    remote_write(&mut stream, &json!({"v":1,"op":"ping","rid":rid(852)})).await;
    let pong = remote_read(&mut stream).await.unwrap();
    assert_eq!(pong["forOp"], "ping");
    assert_eq!(pong["outcome"]["tag"], "ok");
    drop(beta);
}

fn replace_leaf(process: &Process, ca: &Authority, serial: u64, seconds: i64) {
    let mut params = rcgen::CertificateParams::new(vec!["gateway.beta.pi.internal".to_owned()])
        .expect("fixed beta SAN");
    params.not_before = time::OffsetDateTime::now_utc() - time::Duration::hours(1);
    params.not_after = time::OffsetDateTime::now_utc() + time::Duration::seconds(seconds);
    params.serial_number = Some(serial.into());
    params.extended_key_usages = vec![
        rcgen::ExtendedKeyUsagePurpose::ClientAuth,
        rcgen::ExtendedKeyUsagePurpose::ServerAuth,
    ];
    let (chain, key) = ca.sign_leaf(&params);
    fs::write(process.directory.0.join("leaf.der"), &chain[0])
        .expect("replace only generated beta certificate");
    fs::write(process.directory.0.join("key.der"), key)
        .expect("replace only generated beta private key");
}

#[test]
fn real_pair_active_credential_expiry_withdraws_routes_and_possible_admission_stays_unknown() {
    let ca = Authority::new("active expiry process CA");
    let address = address();
    let mut beta = Process::start(&ca, "beta", "alpha", "listen", address, &grants("alpha"));
    beta.terminate();
    replace_leaf(&beta, &ca, 43, 4);
    beta.restart();
    let mut b = beta.connect();
    let beta_peer = register(&mut b, "beta", 900);
    let alpha = Process::start(&ca, "alpha", "beta", "connect", address, &grants("beta"));
    let mut a = alpha.connect();
    register(&mut a, "alpha", 901);
    let mut observer = alpha.connect();
    register(&mut observer, "observer", 902);
    let snapshot = watch(&mut observer, 903);
    await_peer(&mut observer, &snapshot, &beta_peer);
    send(&mut a, &beta_peer, 904);
    let _delivery = read(&mut b);
    assert_eq!(
        read(&mut a)["outcome"]["tag"],
        "unknown",
        "active credential expiry cannot retract a forwarded operation"
    );
    assert_eq!(
        read(&mut observer)["event"]["tag"],
        "remove",
        "actual leased TLS process link must withdraw imported routes"
    );
    send(&mut a, &beta_peer, 905);
    assert_eq!(read(&mut a)["outcome"]["code"], "no_route");
}

#[test]
fn controlled_restart_installs_revocation_even_when_no_peer_can_authenticate_and_rejects_rollback()
{
    let ca = Authority::new("controlled revocation process CA");
    let address = address();
    let mut beta = Process::start(&ca, "beta", "alpha", "listen", address, &grants("alpha"));
    beta.terminate();
    replace_leaf(&beta, &ca, 43, 3600);
    beta.restart();
    let mut b = beta.connect();
    let beta_peer = register(&mut b, "beta", 910);
    let alpha = Process::start(&ca, "alpha", "beta", "connect", address, &grants("beta"));
    let mut a = alpha.connect();
    register(&mut a, "alpha", 911);
    let mut observer = alpha.connect();
    register(&mut observer, "observer", 912);
    let snapshot = watch(&mut observer, 913);
    await_peer(&mut observer, &snapshot, &beta_peer);
    let older = fs::read(beta.directory.0.join("current.crl")).unwrap();
    beta.terminate();
    assert_eq!(
        read(&mut observer)["event"]["tag"],
        "remove",
        "applying authenticated updates by restart invalidates old links"
    );
    let revoked = rcgen::RevokedCertParams {
        serial_number: 42_u64.into(),
        revocation_time: time::OffsetDateTime::now_utc() - time::Duration::minutes(1),
        reason_code: None,
        invalidity_date: None,
    };
    let newer = ca.crl(
        2,
        time::OffsetDateTime::now_utc() - time::Duration::minutes(1),
        time::OffsetDateTime::now_utc() + time::Duration::hours(1),
        vec![revoked],
    );
    fs::write(beta.directory.0.join("current.crl"), newer).unwrap();
    beta.restart();
    let floors: Value =
        serde_json::from_slice(&fs::read(beta.directory.0.join("floors.json")).unwrap()).unwrap();
    assert_eq!(
        floors["issuers"][0]["number"],
        json!([2]),
        "new revocation floor must be durable BEFORE any successful peer handshake"
    );
    beta.terminate();
    fs::write(beta.directory.0.join("current.crl"), older).unwrap();
    let rejected = Command::new(env!("CARGO_BIN_EXE_pi-session-gateway"))
        .arg("--config")
        .arg(beta.directory.0.join("config.json"))
        .output()
        .unwrap();
    assert!(
        !rejected.status.success(),
        "rolled-back revoked credential policy must fail at startup"
    );
    assert!(rejected.stdout.is_empty(), "rollback must not report ready");
}

#[test]
fn explicit_floor_cli_initializes_once_without_resetting_existing_state() {
    let directory = CredentialDirectory::new();
    let path = directory.0.join("new-floors.json");
    let initialize = || {
        Command::new(env!("CARGO_BIN_EXE_pi-session-gateway"))
            .arg("--initialize-revocation-floor")
            .arg(&path)
            .output()
            .expect("isolated explicit floor CLI")
    };
    assert!(
        initialize().status.success(),
        "explicit operator bootstrap creates new private state"
    );
    let bytes = fs::read(&path).unwrap();
    assert!(
        !initialize().status.success(),
        "repeat initialization must not erase protected floors"
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn real_daemon_bounds_pending_unauthenticated_handshakes_and_closes_on_five_second_deadline() {
    let ca = Authority::new("pending handshake cap CA");
    let address = address();
    let _beta = Process::start(&ca, "beta", "alpha", "listen", address, &grants("alpha"));
    let mut pending: Vec<_> = (0..4)
        .map(|_| std::net::TcpStream::connect(address).expect("isolated pending TCP handshake"))
        .collect();
    let mut excess = std::net::TcpStream::connect(address).unwrap();
    excess
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(
        excess.read(&mut [0; 1]).unwrap(),
        0,
        "fifth pending handshake is rejected without spawning another TLS task"
    );
    pending[0]
        .set_read_timeout(Some(Duration::from_secs(7)))
        .unwrap();
    assert_eq!(
        pending[0].read(&mut [0; 1]).unwrap(),
        0,
        "raw accepted TCP cannot remain in a partial TLS handshake beyond five seconds"
    );
}

#[test]
fn real_pair_active_crl_expiry_withdraws_routes_and_possible_admission_stays_unknown() {
    let ca = Authority::new("active CRL expiry process CA");
    let address = address();
    let mut beta = Process::start(&ca, "beta", "alpha", "listen", address, &grants("alpha"));
    beta.terminate();
    replace_leaf(&beta, &ca, 43, 3600);
    let current = time::OffsetDateTime::now_utc();
    fs::write(
        beta.directory.0.join("current.crl"),
        ca.crl(
            2,
            current - time::Duration::minutes(1),
            current + time::Duration::seconds(4),
            vec![],
        ),
    )
    .unwrap();
    beta.restart();
    let mut b = beta.connect();
    let beta_peer = register(&mut b, "beta", 900);
    let alpha = Process::start(&ca, "alpha", "beta", "connect", address, &grants("beta"));
    let mut a = alpha.connect();
    register(&mut a, "alpha", 901);
    let mut observer = alpha.connect();
    register(&mut observer, "observer", 902);
    let snapshot = watch(&mut observer, 903);
    await_peer(&mut observer, &snapshot, &beta_peer);
    send(&mut a, &beta_peer, 904);
    let _delivery = read(&mut b);
    assert_eq!(
        read(&mut a)["outcome"]["tag"],
        "unknown",
        "active credential expiry cannot retract a forwarded operation"
    );
    assert_eq!(
        read(&mut observer)["event"]["tag"],
        "remove",
        "actual leased TLS process link must withdraw imported routes"
    );
    send(&mut a, &beta_peer, 905);
    assert_eq!(read(&mut a)["outcome"]["code"], "no_route");
}
