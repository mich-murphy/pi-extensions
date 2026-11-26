//! Real foreground gateway pairs over isolated loopback TCP, linked by pinned keys.
use super::Dir;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::{Value, json};

/// Listener address that lets the OS choose the port; the gateway reports the bound one at readiness.
const ANY: std::net::SocketAddr =
    std::net::SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0);

/// One Ed25519 key per machine name, generated on first use in an owner-only directory.
struct Keys(Dir);
impl Keys {
    fn new() -> Self {
        Self(Dir::new())
    }
    /// The key path and public key text of `machine`.
    fn key(&self, machine: &str) -> (PathBuf, String) {
        let path = self.0.path(&format!("{machine}.key"));
        let public = if path.exists() {
            pi_gateway::keys::show(&path)
        } else {
            pi_gateway::keys::generate(&path)
        }
        .expect("isolated generated test key");
        (path, public)
    }
    /// `own`'s remote settings, pinning `peer`'s key.
    fn remote(&self, own: &str, peer: &str, mode: &str, address: std::net::SocketAddr) -> Value {
        json!({"machineId":peer,"endpoint":{"mode":mode,"address":address.to_string()},"privateKey":self.key(own).0,"peerPublicKey":self.key(peer).1})
    }
    fn settings(
        &self,
        own: &str,
        peer: &str,
        mode: &str,
        address: std::net::SocketAddr,
    ) -> pi_gateway::remote::Settings {
        pi_gateway::remote::Settings::parse(
            &serde_json::to_vec(&self.remote(own, peer, mode, address)).expect("settings JSON"),
        )
        .expect("strict pinned settings")
    }
}

struct Process {
    child: Child,
    bound: Option<std::net::SocketAddr>,
    directory: Dir,
}
impl Process {
    fn start(
        keys: &Keys,
        own: &str,
        peer: &str,
        mode: &str,
        address: std::net::SocketAddr,
        policies: &Value,
    ) -> Self {
        let directory = Dir::new();
        let base = &directory.0;
        let config = json!({"machineId":own,"socketPath":base.join("s"),"scopeIds":["team","private"],"policies":policies,"remote":keys.remote(own, peer, mode, address)});
        let path = base.join("config.json");
        fs::write(
            &path,
            serde_json::to_vec(&config)
                .expect("isolated pinned-key process fixture and bounded framed I/O"),
        )
        .expect("isolated pinned-key process fixture and bounded framed I/O");
        Self::spawn(directory, &path)
    }
    fn spawn(directory: Dir, config: &PathBuf) -> Self {
        let (child, bound) = Self::child(config);
        Self {
            child,
            bound,
            directory,
        }
    }
    /// The address the remote listener actually bound, as reported by the `ready` event.
    fn address(&self) -> std::net::SocketAddr {
        self.bound
            .expect("a listening process reports its bound address at readiness")
    }
    fn child(config: &PathBuf) -> (Child, Option<std::net::SocketAddr>) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .arg("--config")
            .arg(config)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("isolated pinned-key process fixture and bounded framed I/O");
        let mut ready = String::new();
        BufReader::new(
            child
                .stdout
                .take()
                .expect("isolated pinned-key process fixture and bounded framed I/O"),
        )
        .read_line(&mut ready)
        .expect("isolated pinned-key process fixture and bounded framed I/O");
        assert!(
            !ready.is_empty(),
            "remote-enabled foreground process must reach readiness: {:?}",
            child.try_wait()
        );
        let parsed: Value = serde_json::from_str(&ready)
            .expect("isolated pinned-key process fixture and bounded framed I/O");
        assert_eq!(parsed["event"], "ready", "foreground readiness");
        let bound = parsed["remoteListenAddress"]
            .as_str()
            .map(|address| address.parse().expect("ready reports a socket address"));
        (child, bound)
    }
    fn connect(&self) -> UnixStream {
        let stream = UnixStream::connect(self.directory.0.join("s"))
            .expect("isolated pinned-key process fixture and bounded framed I/O");
        stream
            .set_read_timeout(Some(Duration::from_secs(8)))
            .expect("isolated pinned-key process fixture and bounded framed I/O");
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .expect("isolated pinned-key process fixture and bounded framed I/O");
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
        .expect("isolated pinned-key process fixture and bounded framed I/O");
    stream
        .write_all(
            &u32::try_from(bytes.len())
                .expect("isolated pinned-key process fixture and bounded framed I/O")
                .to_be_bytes(),
        )
        .expect("isolated pinned-key process fixture and bounded framed I/O");
    stream
        .write_all(&bytes)
        .expect("isolated pinned-key process fixture and bounded framed I/O");
}
/// Reads the next frame other than a pushed `link.state`, which every local session now receives.
fn read(stream: &mut UnixStream) -> Value {
    loop {
        let frame = read_any(stream);
        if frame["op"] != "link.state" {
            return frame;
        }
    }
}
fn read_any(stream: &mut UnixStream) -> Value {
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .expect("isolated pinned-key process fixture and bounded framed I/O");
    let length = pi_gateway::wire::body_length(header)
        .expect("isolated pinned-key process fixture and bounded framed I/O");
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .expect("isolated pinned-key process fixture and bounded framed I/O");
    pi_gateway::wire::decode_body(&bytes, pi_gateway::wire::Role::AdapterDelivery)
        .expect("isolated pinned-key process fixture and bounded framed I/O")
}
fn register(stream: &mut UnixStream, session: &str, n: u32) -> Value {
    write(
        stream,
        &json!({"v":2,"op":"register","rid":rid(n),"sessionId":session,"runtimeNonce":rid(n+1000),"scopeIds":["team","private"],"label":session}),
    );
    let result = read(stream);
    assert_eq!(result["outcome"]["tag"], "ok", "registration succeeds");
    result["outcome"]["value"]["peer"].clone()
}
fn watch(stream: &mut UnixStream, n: u32) -> Value {
    write(
        stream,
        &json!({"v":2,"op":"discover","rid":rid(n),"scopeIds":["team"],"watch":true}),
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
        .expect("isolated pinned-key process fixture and bounded framed I/O")
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
fn grants(peer: &str) -> Value {
    json!([{"machineId":peer,"scopeId":"team","permissions":["discover","push","read","interest"]},{"machineId":peer,"scopeId":"team","direction":"incoming","permissions":["push","read","interest"]}])
}
fn receipt(delivery: &Value) -> Value {
    json!({"v":2,"op":"result","rid":delivery["rid"],"forOp":"deliver","outcome":{"tag":"admitted","messageId":delivery["message"]["id"],"correlation":"none","durable":false}})
}
fn send(stream: &mut UnixStream, to: &Value, n: u32) {
    write(
        stream,
        &json!({"v":2,"op":"send","rid":rid(n),"to":to,"scopeId":"team","budgetMs":15000,"message":{"id":rid(n+1000),"kind":"request","content":"isolated collaboration","format":"text"}}),
    );
}

#[test]
fn two_real_daemons_route_exact_receipts_refuse_retired_requests_and_withdraw_without_replay() {
    let keys = Keys::new();
    let mut beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let address = beta.address();
    let mut b = beta.connect();
    let beta_peer = register(&mut b, "beta-session", 1);
    let mut alpha = Process::start(&keys, "alpha", "beta", "connect", address, &grants("beta"));
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
    let work = json!({"kind":"request","origin":alpha_peer,"requestId":rid(1005)});
    for (n, retired) in [
        json!({"v":2,"op":"state.list","rid":rid(6),"publisher":beta_peer,"scopeId":"team"}),
        json!({"v":2,"op":"interest.add","rid":rid(7),"publisher":beta_peer,"scopeId":"team","work":work}),
    ]
    .into_iter()
    .enumerate()
    {
        write(&mut a, &retired);
        let refused = read(&mut a);
        assert_eq!(refused["rid"], retired["rid"], "retired request {n} answered");
        assert_eq!(
            refused["outcome"],
            json!({"tag":"error","code":"forbidden"}),
            "a retired request is refused by the local gateway, not routed"
        );
    }
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
    assert_eq!(
        read(&mut a)["outcome"]["code"],
        "link_down",
        "with the link gone, every session is told the link is down"
    );
    alpha.stop();
}

#[test]
fn real_pair_push_only_does_not_require_discover_and_incoming_ceiling_is_independent() {
    let keys = Keys::new();
    let beta_policy = json!([{"machineId":"alpha","scopeId":"team","permissions":["discover","read","push"]},{"machineId":"alpha","scopeId":"team","direction":"incoming","permissions":["push"]}]);
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &beta_policy);
    let address = beta.address();
    let mut b = beta.connect();
    let beta_peer = register(&mut b, "beta", 20);
    let alpha_policy = json!([{"machineId":"beta","scopeId":"team","permissions":["push","read"]},{"machineId":"beta","scopeId":"team","direction":"incoming","permissions":["read"]}]);
    let alpha = Process::start(&keys, "alpha", "beta", "connect", address, &alpha_policy);
    let mut a = alpha.connect();
    let alpha_peer = register(&mut a, "alpha", 21);
    let mut observer = beta.connect();
    register(&mut observer, "observer", 22);
    let snapshot = watch(&mut observer, 23);
    await_peer(&mut observer, &snapshot, &alpha_peer);
    // A real round trip through alpha binds beta as a source there; no discover call at alpha.
    // Alpha's only incoming grant is the retired read, which parses but grants nothing.
    send(&mut b, &alpha_peer, 24);
    assert_eq!(
        read(&mut b)["outcome"]["code"],
        "forbidden",
        "outgoing adapter capability cannot exceed peer gateway incoming grant"
    );
    write(
        &mut a,
        &json!({"v":2,"op":"discover","rid":rid(25),"scopeIds":["team"],"watch":false}),
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
    stream.flush().await.expect("local TLS flush");
}
async fn remote_read<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<Value> {
    use tokio::io::AsyncReadExt;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    let mut bytes = vec![0; pi_gateway::wire::body_length(header).map_err(std::io::Error::other)?];
    stream.read_exact(&mut bytes).await?;
    pi_gateway::wire::decode_body(&bytes, pi_gateway::wire::Role::RemoteLink)
        .map_err(std::io::Error::other)
}
fn descriptor(machine: &str) -> Value {
    json!({"peer":{"machineId":machine,"sessionId":"remote","runtimeNonce":rid(800)},"label":"remote fixture","scopeIds":["team"]})
}

#[tokio::test]
async fn real_daemon_rejects_third_machine_private_scope_pre_snapshot_event_and_unadvertised_source()
 {
    let keys = Keys::new();
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let address = beta.address();
    for case in 0..5 {
        let prepared = keys
            .settings("alpha", "beta", "connect", address)
            .prepare()
            .unwrap();
        let mut stream = prepared.connect().await.unwrap().into_stream();
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
            remote_write(&mut stream,&json!({"v":2,"op":"roster.event","rid":discover["rid"],"event":{"tag":"upsert","peer":advertised}})).await;
        } else {
            remote_write(&mut stream,&json!({"v":2,"op":"result","rid":discover["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":[advertised],"watching":true}}})).await;
            if case >= 3 {
                let from = if case == 3 {
                    descriptor("gamma")["peer"].clone()
                } else {
                    let mut peer = advertised["peer"].clone();
                    peer["runtimeNonce"] = json!(rid(801));
                    peer
                };
                remote_write(&mut stream,&json!({"v":2,"op":"send","rid":rid(802),"from":from,"to":{"machineId":"beta","sessionId":"no-runtime","runtimeNonce":rid(803)},"scopeId":"team","budgetMs":15000,"message":{"id":rid(804),"kind":"request","content":"must not route","format":"text"}})).await;
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
    let keys = Keys::new();
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let address = beta.address();
    // The impostor pins beta correctly, but beta pins only alpha's key.
    let impostor = keys
        .settings("impostor", "beta", "connect", address)
        .prepare()
        .unwrap();
    if let Ok(authenticated) = impostor.connect().await {
        let mut stream = authenticated.into_stream();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), remote_read(&mut stream))
                .await
                .unwrap()
                .is_err(),
            "an unpinned client key cannot become an application link"
        );
    }
    let prepared = keys
        .settings("alpha", "beta", "connect", address)
        .prepare()
        .unwrap();
    let mut stream = prepared.connect().await.unwrap().into_stream();
    let discover = remote_read(&mut stream).await.unwrap();
    let advertised = descriptor("alpha");
    remote_write(&mut stream,&json!({"v":2,"op":"result","rid":discover["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":[advertised],"watching":true}}})).await;
    remote_write(&mut stream,&json!({"v":2,"op":"send","rid":rid(850),"from":advertised["peer"],"to":descriptor("gamma")["peer"],"scopeId":"team","budgetMs":15000,"message":{"id":rid(851),"kind":"request","content":"no transit","format":"text"}})).await;
    let rejection = remote_read(&mut stream).await.unwrap();
    assert_eq!(rejection["outcome"]["tag"], "not_admitted");
    assert_eq!(rejection["outcome"]["code"], "forbidden");
    remote_write(&mut stream, &json!({"v":2,"op":"ping","rid":rid(852)})).await;
    let pong = remote_read(&mut stream).await.unwrap();
    assert_eq!(pong["forOp"], "ping");
    assert_eq!(pong["outcome"]["tag"], "ok");
    drop(beta);
}

#[test]
fn real_daemon_bounds_pending_unauthenticated_handshakes_and_closes_on_five_second_deadline() {
    let keys = Keys::new();
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let address = beta.address();
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

fn imported(index: u32) -> Value {
    json!({"peer":{"machineId":"alpha","sessionId":format!("remote-{index}"),"runtimeNonce":rid(2000 + index)},"label":"remote fixture","scopeIds":["team"]})
}

/// Opens an authenticated raw link to `beta` and answers its roster watch with `snapshot` peers.
async fn link_with_snapshot(
    keys: &Keys,
    address: std::net::SocketAddr,
    snapshot: u32,
) -> (
    impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    Value,
) {
    let prepared = keys
        .settings("alpha", "beta", "connect", address)
        .prepare()
        .expect("alpha key prepares");
    let mut stream = prepared
        .connect()
        .await
        .expect("authenticated link")
        .into_stream();
    let discover = remote_read(&mut stream)
        .await
        .expect("roster watch request");
    let peers: Vec<_> = (0..snapshot).map(imported).collect();
    remote_write(&mut stream,&json!({"v":2,"op":"result","rid":discover["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":peers,"watching":true}}})).await;
    (stream, discover["rid"].clone())
}

async fn link_is_alive<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    stream: &mut S,
) -> bool {
    remote_write(stream, &json!({"v":2,"op":"ping","rid":rid(3000)})).await;
    tokio::time::timeout(Duration::from_secs(3), remote_read(stream))
        .await
        .is_ok_and(|reply| reply.is_ok_and(|pong| pong["forOp"] == "ping"))
}

#[tokio::test]
async fn real_daemon_imports_thirty_remote_sessions_and_closes_the_link_on_the_thirty_first() {
    let keys = Keys::new();
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let address = beta.address();
    // Snapshot sizes 30 and 31, then a live upsert taking a 29-session roster to 30 and to 31.
    for (snapshot, upserts, survives) in
        [(30, 0, true), (31, 0, false), (29, 1, true), (30, 1, false)]
    {
        let (mut stream, watch) = link_with_snapshot(&keys, address, snapshot).await;
        for index in 0..upserts {
            remote_write(&mut stream,&json!({"v":2,"op":"roster.event","rid":watch,"event":{"tag":"upsert","peer":imported(snapshot + index)}})).await;
        }
        assert_eq!(
            link_is_alive(&mut stream).await,
            survives,
            "snapshot of {snapshot} sessions plus {upserts} upserts must {} the link",
            if survives { "keep" } else { "close" }
        );
    }
    drop(beta);
}

#[tokio::test]
async fn real_daemon_refuses_retired_requests_from_an_older_remote_gateway_and_keeps_the_link() {
    let keys = Keys::new();
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let address = beta.address();
    let mut receiver = beta.connect();
    let target = register(&mut receiver, "receiver", 1);
    let (mut stream, _watch) = link_with_snapshot(&keys, address, 1).await;
    let origin = imported(0)["peer"].clone();
    let work = json!({"kind":"request","origin":origin,"requestId":rid(6100)});
    let retired = [
        json!({"v":2,"op":"state.get","rid":rid(6001),"from":origin,"publisher":target,"scopeId":"team","key":"report"}),
        json!({"v":2,"op":"state.list","rid":rid(6002),"from":origin,"publisher":target,"scopeId":"team"}),
        json!({"v":2,"op":"interest.add","rid":rid(6003),"from":origin,"publisher":target,"scopeId":"team","work":work}),
        json!({"v":2,"op":"interest.remove","rid":rid(6004),"from":origin,"publisher":target,"scopeId":"team","work":work}),
    ];
    for request in &retired {
        remote_write(&mut stream, request).await;
        let refused = tokio::time::timeout(Duration::from_secs(3), remote_read(&mut stream))
            .await
            .expect("a retired request is answered promptly")
            .expect("the link stays open");
        assert_eq!(refused["rid"], request["rid"]);
        assert_eq!(refused["forOp"], request["op"]);
        assert_eq!(
            refused["outcome"],
            json!({"tag":"error","code":"forbidden"})
        );
    }
    assert!(
        link_is_alive(&mut stream).await,
        "the link survives retired requests"
    );
    let send = json!({"v":2,"op":"send","rid":rid(6005),"from":origin,"to":target,"scopeId":"team","budgetMs":15000,"message":{"id":rid(6006),"kind":"request","content":"still routed","format":"text"}});
    remote_write(&mut stream, &send).await;
    assert_eq!(
        read(&mut receiver)["message"]["id"],
        rid(6006),
        "nothing retired reached the receiver; the next send does"
    );
    drop(beta);
}

#[tokio::test]
async fn real_daemon_admits_256_remote_operations_and_refuses_the_257th_as_overloaded() {
    let keys = Keys::new();
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let address = beta.address();
    let mut receiver = beta.connect();
    let target = register(&mut receiver, "receiver", 1);
    let (mut stream, _watch) = link_with_snapshot(&keys, address, 1).await;
    let origin = imported(0)["peer"].clone();
    let send_from_remote = |number: u32| json!({"v":2,"op":"send","rid":rid(4000 + number),"from":origin,"to":target,"scopeId":"team","budgetMs":15000,"message":{"id":rid(5000 + number),"kind":"request","content":"queued","format":"text"}});
    // One operation at a time: the delivery proves the gateway registered it before the next
    // frame is offered, so the gateway's bounded inbound queue never overflows.
    for number in 0..256 {
        remote_write(&mut stream, &send_from_remote(number)).await;
        let delivery = read(&mut receiver);
        assert_eq!(
            delivery["message"]["id"],
            rid(5000 + number),
            "the first 256 operations reach the receiver in order"
        );
    }
    remote_write(&mut stream, &send_from_remote(256)).await;
    let refused = tokio::time::timeout(Duration::from_secs(5), remote_read(&mut stream))
        .await
        .expect("the 257th operation must be answered promptly")
        .expect("the link stays open");
    assert_eq!(refused["rid"], rid(4256));
    assert_eq!(refused["outcome"]["tag"], "not_admitted");
    assert_eq!(refused["outcome"]["code"], "overloaded");
    assert_eq!(refused["outcome"]["resource"], "operations");
    drop(beta);
}

#[test]
fn listener_on_port_zero_reports_a_nonzero_bound_address_that_accepts_connections() {
    let keys = Keys::new();
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let bound = beta.address();
    assert_eq!(bound.ip(), ANY.ip(), "the bound IP is the configured IP");
    assert_ne!(bound.port(), 0, "ready reports the port the OS chose");
    std::net::TcpStream::connect(bound).expect("the reported address is the live listener");
}

#[test]
fn concurrent_listeners_on_port_zero_receive_distinct_ports() {
    let keys = Keys::new();
    let first = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let second = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    assert_ne!(first.address(), second.address());
    std::net::TcpStream::connect(first.address()).expect("first listener is live");
    std::net::TcpStream::connect(second.address()).expect("second listener is live");
}

#[test]
fn connecting_process_reports_no_remote_listen_address() {
    let keys = Keys::new();
    let beta = Process::start(&keys, "beta", "alpha", "listen", ANY, &grants("alpha"));
    let alpha = Process::start(
        &keys,
        "alpha",
        "beta",
        "connect",
        beta.address(),
        &grants("beta"),
    );
    assert!(
        alpha.bound.is_none(),
        "only listeners report a bound address"
    );
}

#[test]
fn port_zero_is_valid_for_a_listener_and_rejected_for_a_dialed_address() {
    let keys = Keys::new();
    let settings = |mode: &str| {
        serde_json::to_vec(&keys.remote("alpha", "beta", mode, ANY)).expect("settings encoding")
    };
    assert!(pi_gateway::remote::Settings::parse(&settings("listen")).is_ok());
    assert!(
        pi_gateway::remote::Settings::parse(&settings("connect")).is_err(),
        "port 0 is never a destination"
    );
}
