//! Isolated real-process Unix journeys; no real profile, credentials or provider calls.
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

static DIRECTORY: AtomicU64 = AtomicU64::new(1);
struct Gateway {
    child: Child,
    directory: PathBuf,
    socket: PathBuf,
}
impl Gateway {
    fn start(permissions: &[&str]) -> Self {
        let directory = PathBuf::from("/tmp")
            .canonicalize()
            .expect("isolated fixture setup and framed I/O must succeed")
            .join(format!(
                "pi-gw-{}-{}",
                std::process::id(),
                DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&directory).expect("isolated fixture setup and framed I/O must succeed");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("isolated fixture setup and framed I/O must succeed");
        let socket = directory.join("s");
        let config = directory.join("config.json");
        fs::write(&config, serde_json::to_vec(&json!({"machineId":"alpha","socketPath":socket,"scopeIds":["team","private"],"policies":[{"machineId":"alpha","scopeId":"team","permissions":permissions}]})).expect("isolated fixture setup and framed I/O must succeed")).expect("isolated fixture setup and framed I/O must succeed");
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .args([
                "--config",
                config
                    .to_str()
                    .expect("isolated fixture setup and framed I/O must succeed"),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("isolated fixture setup and framed I/O must succeed");
        let mut ready = String::new();
        BufReader::new(
            child
                .stdout
                .take()
                .expect("isolated fixture setup and framed I/O must succeed"),
        )
        .read_line(&mut ready)
        .expect("isolated fixture setup and framed I/O must succeed");
        assert!(
            !ready.is_empty(),
            "daemon must report readiness before clients connect"
        );
        let value: Value = serde_json::from_str(&ready)
            .expect("isolated fixture setup and framed I/O must succeed");
        assert_eq!(
            value,
            json!({"event":"ready","machineId":"alpha","socketPath":socket}),
            "readiness must report the bound configured identity and path"
        );
        Self {
            child,
            directory,
            socket,
        }
    }
    fn connect(&self) -> UnixStream {
        let stream = UnixStream::connect(&self.socket)
            .expect("isolated fixture setup and framed I/O must succeed");
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("isolated fixture setup and framed I/O must succeed");
        stream
            .set_write_timeout(Some(Duration::from_secs(3)))
            .expect("isolated fixture setup and framed I/O must succeed");
        stream
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}
fn write(stream: &mut UnixStream, frame: &Value) {
    try_write(stream, frame).expect("isolated fixture setup and framed I/O must succeed");
}
/// Writes one frame, reporting a closed peer instead of panicking.
fn try_write(stream: &mut UnixStream, frame: &Value) -> std::io::Result<()> {
    let bytes =
        serde_json::to_vec(frame).expect("isolated fixture setup and framed I/O must succeed");
    stream.write_all(
        &u32::try_from(bytes.len())
            .expect("isolated fixture setup and framed I/O must succeed")
            .to_be_bytes(),
    )?;
    stream.write_all(&bytes)
}
fn read(stream: &mut UnixStream) -> Value {
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .expect("isolated fixture setup and framed I/O must succeed");
    let length = pi_gateway::wire::body_length(header)
        .expect("isolated fixture setup and framed I/O must succeed");
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .expect("isolated fixture setup and framed I/O must succeed");
    let mut frame = header.to_vec();
    frame.extend_from_slice(&bytes);
    let value: Value =
        serde_json::from_slice(&bytes).expect("isolated fixture setup and framed I/O must succeed");
    let role = if value["op"] == "deliver" {
        pi_gateway::wire::Role::AdapterDelivery
    } else if value.get("from").is_some() {
        pi_gateway::wire::Role::GatewayForward
    } else {
        pi_gateway::wire::Role::LocalClient
    };
    pi_gateway::wire::decode_frame(&frame, role)
        .expect("isolated fixture setup and framed I/O must succeed")
}
fn rid(number: u64) -> String {
    format!("{number:032x}")
}
fn register(stream: &mut UnixStream, session: &str, nonce: u64, scopes: &[&str]) -> Value {
    write(
        stream,
        &json!({"v":1,"op":"register","rid":rid(1),"sessionId":session,"runtimeNonce":rid(nonce),"scopeIds":scopes,"label":session}),
    );
    let response = read(stream);
    assert_eq!(
        response["outcome"]["tag"], "ok",
        "fixture runtime registration must succeed"
    );
    response["outcome"]["value"]["peer"].clone()
}
fn request(to: &Value, number: u64) -> Value {
    json!({"v":1,"op":"send","rid":rid(number),"to":to,"scopeId":"team","message":{"id":rid(500),"kind":"request","content":"hello","format":"text"}})
}

#[test]
fn local_registration_watch_send_and_exact_receipt() {
    let gateway = Gateway::start(&["discover", "read", "push", "interest"]);
    let mut sender = gateway.connect();
    let sender_peer = register(&mut sender, "sender", 10, &["team"]);
    write(
        &mut sender,
        &json!({"v":1,"op":"discover","rid":rid(2),"scopeIds":["team"],"watch":true}),
    );
    assert_eq!(
        read(&mut sender)["outcome"]["value"]["peers"]
            .as_array()
            .expect("isolated fixture setup and framed I/O must succeed")
            .len(),
        1
    );
    let mut receiver = gateway.connect();
    let receiver_peer = register(&mut receiver, "receiver", 11, &["team", "private"]);
    let event = read(&mut sender);
    assert_eq!(event["event"]["tag"], "upsert");
    assert_eq!(
        event["event"]["peer"]["scopeIds"],
        json!(["team"]),
        "watch projection must not leak private memberships"
    );
    write(&mut sender, &request(&receiver_peer, 3));
    let delivery = read(&mut receiver);
    assert_eq!(delivery["op"], "deliver");
    assert_eq!(delivery["from"], sender_peer);
    assert_ne!(delivery["rid"], rid(3));
    let binding = json!({"messageId":rid(500),"sender":sender_peer,"recipient":receiver_peer,"scopeId":"team"});
    write(
        &mut receiver,
        &json!({"v":1,"op":"result","rid":delivery["rid"],"forOp":"deliver","outcome":{"tag":"admitted","binding":binding,"correlation":"none"}}),
    );
    let result = read(&mut sender);
    assert_eq!(result["rid"], rid(3));
    assert_eq!(result["forOp"], "send");
    assert_eq!(
        result["outcome"],
        json!({"tag":"admitted","binding":binding,"correlation":"none"})
    );
    write(&mut receiver, &json!({"v":1,"op":"close","rid":rid(4)}));
    assert_eq!(read(&mut receiver)["outcome"]["tag"], "ok");
    assert_eq!(
        read(&mut sender)["event"],
        json!({"tag":"remove","peer":receiver_peer})
    );
}

#[test]
fn ambiguous_delivery_and_bound_mismatch_are_unknown_never_gateway_admitted() {
    let gateway = Gateway::start(&["push"]);
    let mut sender = gateway.connect();
    let sender_peer = register(&mut sender, "sender", 10, &["team"]);
    let mut receiver = gateway.connect();
    let target = register(&mut receiver, "receiver", 11, &["team"]);
    write(&mut sender, &request(&target, 2));
    let delivery = read(&mut receiver);
    write(
        &mut receiver,
        &json!({"v":1,"op":"result","rid":delivery["rid"],"forOp":"deliver","outcome":{"tag":"admitted","binding":{"messageId":rid(501),"sender":sender_peer,"recipient":target,"scopeId":"team"},"correlation":"none"}}),
    );
    let result = read(&mut sender);
    assert_eq!(result["outcome"]["tag"], "unknown");
    assert_eq!(result["outcome"]["code"], "protocol_error");
    assert_eq!(result["outcome"]["binding"]["messageId"], rid(500));
    write(&mut sender, &request(&target, 3));
    assert_eq!(read(&mut sender)["outcome"]["code"], "no_route");
}

#[test]
fn live_runtime_cannot_be_stolen_and_authorization_does_not_probe_routes() {
    let gateway = Gateway::start(&["discover"]);
    let mut first = gateway.connect();
    let peer = register(&mut first, "session", 10, &["team"]);
    let mut thief = gateway.connect();
    write(
        &mut thief,
        &json!({"v":1,"op":"register","rid":rid(1),"sessionId":"session","runtimeNonce":rid(10),"scopeIds":["team"],"label":"steal"}),
    );
    assert_eq!(read(&mut thief)["outcome"]["code"], "already_registered");
    write(&mut first, &request(&peer, 2));
    assert_eq!(read(&mut first)["outcome"]["code"], "forbidden");
    let missing = json!({"machineId":"alpha","sessionId":"missing","runtimeNonce":rid(20)});
    write(&mut first, &request(&missing, 3));
    assert_eq!(read(&mut first)["outcome"]["code"], "forbidden");
}

#[test]
fn malformed_prefix_closes_only_affected_client() {
    let gateway = Gateway::start(&["push"]);
    let mut hostile = gateway.connect();
    hostile
        .write_all(&32765_u32.to_be_bytes())
        .expect("isolated fixture setup and framed I/O must succeed");
    let mut one = [0_u8; 1];
    assert_eq!(
        hostile
            .read(&mut one)
            .expect("isolated fixture setup and framed I/O must succeed"),
        0
    );
    let mut healthy = gateway.connect();
    register(&mut healthy, "healthy", 12, &["team"]);
}

fn send_to(stream: &mut UnixStream, to: &Value, number: u64) {
    write(
        stream,
        &json!({"v":1,"op":"send","rid":rid(number),"to":to,"scopeId":"team","message":{"id":rid(1000 + number),"kind":"request","content":"hello","format":"text"}}),
    );
}

#[test]
fn thirty_local_connections_are_served_and_the_thirty_first_is_closed_until_one_leaves() {
    let gateway = Gateway::start(&["push"]);
    let mut clients: Vec<_> = (0..30)
        .map(|index| {
            let mut stream = gateway.connect();
            register(
                &mut stream,
                &format!("session-{index}"),
                100 + index,
                &["team"],
            );
            stream
        })
        .collect();
    let mut excess = gateway.connect();
    let mut byte = [0_u8; 1];
    assert_eq!(
        excess
            .read(&mut byte)
            .expect("the gateway closes the excess connection instead of leaving it to time out"),
        0,
        "connection 31 is refused with an immediate close"
    );
    let mut leaving = clients.pop().expect("thirty connections");
    write(&mut leaving, &json!({"v":1,"op":"close","rid":rid(2)}));
    assert_eq!(read(&mut leaving)["outcome"]["tag"], "ok");
    drop(leaving);
    // The gateway reaps the closed task asynchronously, so poll the observable state (a refused
    // connection is closed at once) up to a generous hang guard rather than a fixed attempt count.
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut admitted = false;
    while Instant::now() < deadline {
        let mut again = gateway.connect();
        // A refused connection is closed by the gateway, so its write may fail as well as its read.
        let registered = try_write(
            &mut again,
            &json!({"v":1,"op":"register","rid":rid(1),"sessionId":"replacement","runtimeNonce":rid(900),"scopeIds":["team"],"label":"replacement"}),
        );
        let mut header = [0_u8; 4];
        if registered.is_ok() && again.read_exact(&mut header).is_ok() {
            admitted = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(admitted, "a freed connection slot admits a new client");
}

#[test]
fn nine_concurrent_sends_on_one_connection_are_refused_as_overloaded_operations() {
    let gateway = Gateway::start(&["push"]);
    let mut sender = gateway.connect();
    register(&mut sender, "sender", 10, &["team"]);
    let mut other = gateway.connect();
    register(&mut other, "other", 12, &["team"]);
    let mut receiver = gateway.connect();
    let target = register(&mut receiver, "receiver", 11, &["team"]);
    for number in 2..10 {
        send_to(&mut sender, &target, number);
    }
    let mut deliveries = Vec::new();
    for _ in 2..10 {
        deliveries.push(read(&mut receiver));
    }
    send_to(&mut sender, &target, 10);
    let refused = read(&mut sender);
    assert_eq!(refused["rid"], rid(10));
    assert_eq!(refused["outcome"]["tag"], "not_admitted");
    assert_eq!(refused["outcome"]["code"], "overloaded");
    assert_eq!(refused["outcome"]["resource"], "operations");
    assert_eq!(
        refused["outcome"]["binding"]["messageId"],
        rid(1010),
        "the refusal is bound to the refused message"
    );
    // The cap is per connection: another connection is unaffected.
    send_to(&mut other, &target, 2);
    assert_eq!(read(&mut receiver)["from"]["sessionId"], "other");
    // Settling one operation frees one slot on the saturated connection.
    let first = &deliveries[0];
    write(
        &mut receiver,
        &json!({"v":1,"op":"result","rid":first["rid"],"forOp":"deliver","outcome":{"tag":"admitted","binding":{"messageId":first["message"]["id"],"sender":first["from"],"recipient":first["to"],"scopeId":"team"},"correlation":"none"}}),
    );
    assert_eq!(read(&mut sender)["outcome"]["tag"], "admitted");
    send_to(&mut sender, &target, 11);
    assert_eq!(read(&mut receiver)["from"]["sessionId"], "sender");
}

#[test]
fn a_second_concurrent_watch_is_overloaded_until_the_first_is_released() {
    let gateway = Gateway::start(&["discover"]);
    let mut client = gateway.connect();
    register(&mut client, "watcher", 10, &["team"]);
    let watch = |number: u64| json!({"v":1,"op":"discover","rid":rid(number),"scopeIds":["team"],"watch":true});
    write(&mut client, &watch(2));
    assert_eq!(read(&mut client)["outcome"]["tag"], "ok");
    write(&mut client, &watch(3));
    let refused = read(&mut client);
    assert_eq!(refused["rid"], rid(3));
    assert_eq!(refused["outcome"]["tag"], "error");
    assert_eq!(refused["outcome"]["code"], "overloaded");
    assert_eq!(refused["outcome"]["resource"], "watch");
    write(
        &mut client,
        &json!({"v":1,"op":"unwatch","rid":rid(4),"watchRid":rid(2)}),
    );
    assert_eq!(read(&mut client)["outcome"]["tag"], "ok");
    write(&mut client, &watch(5));
    assert_eq!(
        read(&mut client)["outcome"]["tag"],
        "ok",
        "releasing the watch frees the slot"
    );
}

#[test]
fn socket_is_owner_only_and_sigterm_removes_it_with_a_clean_exit() {
    let mut gateway = Gateway::start(&["push"]);
    let socket_mode = fs::metadata(&gateway.socket)
        .expect("bound socket")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(socket_mode, 0o600, "the socket is owner-only");
    let pid = rustix::process::Pid::from_raw(
        i32::try_from(gateway.child.id()).expect("test process PID fits OS pid_t"),
    )
    .expect("positive child PID");
    rustix::process::kill_process(pid, rustix::process::Signal::TERM)
        .expect("terminate isolated foreground gateway");
    assert!(
        gateway
            .child
            .wait()
            .expect("wait for the gateway")
            .success(),
        "SIGTERM is a controlled shutdown"
    );
    assert!(
        !gateway.socket.exists(),
        "the gateway removes its own socket on SIGTERM"
    );
}

#[test]
fn gateway_refuses_a_socket_directory_that_others_can_enter() {
    let gateway = Gateway::start(&["push"]);
    let open = gateway.directory.join("open");
    fs::create_dir(&open).expect("fixture directory");
    fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).expect("fixture mode");
    let config = gateway.directory.join("open.json");
    let socket = open.join("s");
    fs::write(
        &config,
        serde_json::to_vec(
            &json!({"machineId":"beta","socketPath":socket,"scopeIds":["team"],"policies":[]}),
        )
        .expect("fixture config"),
    )
    .expect("fixture config file");
    let mut child = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .arg("--config")
        .arg(&config)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("isolated gateway process");
    let mut first_line = String::new();
    BufReader::new(child.stdout.take().expect("piped stdout"))
        .read_line(&mut first_line)
        .expect("stdout until ready or exit");
    // A gateway that wrongly started would stay up, so never wait on it.
    let _ = child.kill();
    assert!(
        first_line.is_empty(),
        "a refused start never reports ready: {first_line:?}"
    );
    assert!(
        !child.wait().expect("reap gateway").success(),
        "a 0755 socket directory is not a private boundary"
    );
    assert!(
        !socket.exists(),
        "no socket is created in an unsafe directory"
    );
}
