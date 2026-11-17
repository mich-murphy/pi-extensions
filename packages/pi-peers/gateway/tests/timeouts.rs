//! Forwarded-operation deadline against the real routing loop on a paused clock; no real waits.
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use pi_gateway::config::Config;
use pi_gateway::daemon::Daemon;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

fn rid(number: u64) -> String {
    format!("{number:032x}")
}
async fn write(stream: &mut UnixStream, frame: &Value) {
    let bytes = serde_json::to_vec(frame).expect("fixture frame encoding");
    let length = u32::try_from(bytes.len()).expect("small fixture frame");
    stream
        .write_all(&length.to_be_bytes())
        .await
        .expect("fixture frame header");
    stream.write_all(&bytes).await.expect("fixture frame body");
}
async fn read(stream: &mut UnixStream) -> Value {
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .await
        .expect("frame header from the gateway");
    let length = pi_gateway::wire::body_length(header).expect("valid gateway frame length");
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .expect("frame body from the gateway");
    serde_json::from_slice(&bytes).expect("gateway frames are JSON")
}
async fn register(stream: &mut UnixStream, session: &str, nonce: u64) -> Value {
    write(
        stream,
        &json!({"v":1,"op":"register","rid":rid(1),"sessionId":session,"runtimeNonce":rid(nonce),"scopeIds":["team"],"label":session}),
    )
    .await;
    let response = read(stream).await;
    assert_eq!(response["outcome"]["tag"], "ok", "fixture registration");
    response["outcome"]["value"]["peer"].clone()
}

struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = PathBuf::from("/tmp")
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!("gw-timeout-{}", std::process::id()));
        fs::create_dir(&directory).expect("isolated socket directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("private socket directory");
        Self { directory }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[tokio::test(start_paused = true)]
async fn forwarded_operation_stays_pending_for_fifteen_seconds_then_becomes_unknown() {
    let fixture = Fixture::new();
    let socket = fixture.directory.join("s");
    let config = Config::parse(
        &serde_json::to_vec(&json!({"machineId":"alpha","socketPath":socket,"scopeIds":["team"],"policies":[{"machineId":"alpha","scopeId":"team","permissions":["push"]}]}))
            .expect("fixture config encoding"),
    )
    .expect("fixture config");
    let daemon = Daemon::bind(config).expect("isolated bind");
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let running = tokio::spawn(daemon.run(async move {
        let _ = stopped.await;
    }));

    let mut sender = UnixStream::connect(&socket).await.expect("sender socket");
    let sender_peer = register(&mut sender, "sender", 10).await;
    let mut receiver = UnixStream::connect(&socket).await.expect("receiver socket");
    let receiver_peer = register(&mut receiver, "receiver", 11).await;
    write(
        &mut sender,
        &json!({"v":1,"op":"send","rid":rid(2),"to":receiver_peer,"scopeId":"team","message":{"id":rid(500),"kind":"request","content":"hello","format":"text"}}),
    )
    .await;
    // The delivery proves the gateway has accepted the operation; the receiver never answers it.
    assert_eq!(read(&mut receiver).await["op"], "deliver");

    assert!(
        tokio::time::timeout(Duration::from_millis(14_999), read(&mut sender))
            .await
            .is_err(),
        "an unanswered operation stays pending until its fifteen-second deadline"
    );
    let outcome = tokio::time::timeout(Duration::from_millis(2), read(&mut sender))
        .await
        .expect("the operation must be settled at fifteen seconds");
    assert_eq!(outcome["rid"], rid(2));
    assert_eq!(outcome["outcome"]["tag"], "unknown");
    assert_eq!(outcome["outcome"]["code"], "unavailable");
    assert_eq!(
        outcome["outcome"]["binding"]["sender"], sender_peer,
        "possible admission is reported as unknown, bound to the exact message"
    );
    stop.send(()).expect("gateway still running");
    running
        .await
        .expect("gateway task")
        .expect("clean gateway shutdown");
}
