//! Isolated real-process Unix journeys; no real profile, credentials or provider calls.
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-session-gateway"))
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
    let bytes =
        serde_json::to_vec(frame).expect("isolated fixture setup and framed I/O must succeed");
    stream
        .write_all(
            &u32::try_from(bytes.len())
                .expect("isolated fixture setup and framed I/O must succeed")
                .to_be_bytes(),
        )
        .expect("isolated fixture setup and framed I/O must succeed");
    stream
        .write_all(&bytes)
        .expect("isolated fixture setup and framed I/O must succeed");
}
fn read(stream: &mut UnixStream) -> Value {
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .expect("isolated fixture setup and framed I/O must succeed");
    let length = pi_session_gateway::wire::body_length(header)
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
        pi_session_gateway::wire::Role::AdapterDelivery
    } else if value.get("from").is_some() {
        pi_session_gateway::wire::Role::GatewayForward
    } else {
        pi_session_gateway::wire::Role::LocalClient
    };
    pi_session_gateway::wire::decode_frame(&frame, role)
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
