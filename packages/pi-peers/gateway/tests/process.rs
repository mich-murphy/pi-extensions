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

mod support;

static DIRECTORY: AtomicU64 = AtomicU64::new(1);
struct Gateway {
    child: Child,
    directory: PathBuf,
    socket: PathBuf,
}
impl Gateway {
    fn start(permissions: &[&str]) -> Self {
        Self::with_policies(
            &json!([{"machineId":"alpha","scopeId":"team","permissions":permissions}]),
        )
    }
    fn with_policies(policies: &Value) -> Self {
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
        fs::write(&config, serde_json::to_vec(&json!({"machineId":"alpha","socketPath":socket,"scopeIds":["team","private"],"policies":policies})).expect("isolated fixture setup and framed I/O must succeed")).expect("isolated fixture setup and framed I/O must succeed");
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .args([
                "--config",
                config
                    .to_str()
                    .expect("isolated fixture setup and framed I/O must succeed"),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
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
        &json!({"v":2,"op":"register","rid":rid(1),"sessionId":session,"runtimeNonce":rid(nonce),"scopeIds":scopes,"label":session}),
    );
    let response = read(stream);
    assert_eq!(
        response["outcome"]["tag"], "ok",
        "fixture runtime registration must succeed"
    );
    response["outcome"]["value"]["peer"].clone()
}
fn request(to: &Value, number: u64) -> Value {
    json!({"v":2,"op":"send","rid":rid(number),"to":to,"scopeId":"team","budgetMs":15000,"message":{"id":rid(500),"kind":"request","content":"hello","format":"text"}})
}

#[test]
fn local_registration_watch_send_and_exact_receipt() {
    let gateway = Gateway::start(&["discover", "read", "push", "interest"]);
    let mut sender = gateway.connect();
    let sender_peer = register(&mut sender, "sender", 10, &["team"]);
    write(
        &mut sender,
        &json!({"v":2,"op":"discover","rid":rid(2),"scopeIds":["team"],"watch":true}),
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
    let message_id = rid(500);
    write(
        &mut receiver,
        &json!({"v":2,"op":"result","rid":delivery["rid"],"forOp":"deliver","outcome":{"tag":"admitted","messageId":message_id,"correlation":"none","durable":false}}),
    );
    let result = read(&mut sender);
    assert_eq!(result["rid"], rid(3));
    assert_eq!(result["forOp"], "send");
    assert_eq!(
        result["outcome"],
        json!({"tag":"admitted","messageId":message_id,"correlation":"none","durable":false})
    );
    write(&mut receiver, &json!({"v":2,"op":"close","rid":rid(4)}));
    assert_eq!(read(&mut receiver)["outcome"]["tag"], "ok");
    assert_eq!(
        read(&mut sender)["event"],
        json!({"tag":"remove","peer":receiver_peer})
    );
}

#[test]
fn a_spent_budget_is_refused_as_expired_and_never_delivered() {
    let gateway = Gateway::start(&["push"]);
    let mut sender = gateway.connect();
    let _sender = register(&mut sender, "sender", 10, &["team"]);
    let mut receiver = gateway.connect();
    let target = register(&mut receiver, "receiver", 11, &["team"]);
    let mut spent = request(&target, 2);
    spent["budgetMs"] = json!(500);
    write(&mut sender, &spent);
    assert_eq!(
        read(&mut sender)["outcome"],
        json!({"tag":"not_admitted","messageId":rid(500),"code":"expired"}),
        "a budget too small to cover this hop and the next is refused here"
    );
    let mut fresh = request(&target, 3);
    fresh["budgetMs"] = json!(60_000);
    write(&mut sender, &fresh);
    let delivery = read(&mut receiver);
    assert_eq!(delivery["op"], "deliver");
    assert_eq!(
        delivery["budgetMs"], 14_500,
        "the next hop gets min(budget, operation timeout) less this hop's reserve"
    );
}

#[test]
fn ambiguous_delivery_and_bound_mismatch_are_unknown_never_gateway_admitted() {
    let gateway = Gateway::start(&["push"]);
    let mut sender = gateway.connect();
    let _sender = register(&mut sender, "sender", 10, &["team"]);
    let mut receiver = gateway.connect();
    let target = register(&mut receiver, "receiver", 11, &["team"]);
    write(&mut sender, &request(&target, 2));
    let delivery = read(&mut receiver);
    write(
        &mut receiver,
        &json!({"v":2,"op":"result","rid":delivery["rid"],"forOp":"deliver","outcome":{"tag":"admitted","messageId":rid(501),"correlation":"none","durable":false}}),
    );
    let result = read(&mut sender);
    assert_eq!(result["outcome"]["tag"], "unknown");
    assert_eq!(result["outcome"]["code"], "protocol_error");
    assert_eq!(result["outcome"]["messageId"], rid(500));
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
        &json!({"v":2,"op":"register","rid":rid(1),"sessionId":"session","runtimeNonce":rid(10),"scopeIds":["team"],"label":"steal"}),
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
        &json!({"v":2,"op":"send","rid":rid(number),"to":to,"scopeId":"team","budgetMs":15000,"message":{"id":rid(1000 + number),"kind":"request","content":"hello","format":"text"}}),
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
    write(&mut leaving, &json!({"v":2,"op":"close","rid":rid(2)}));
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
            &json!({"v":2,"op":"register","rid":rid(1),"sessionId":"replacement","runtimeNonce":rid(900),"scopeIds":["team"],"label":"replacement"}),
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
        refused["outcome"]["messageId"],
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
        &json!({"v":2,"op":"result","rid":first["rid"],"forOp":"deliver","outcome":{"tag":"admitted","messageId":first["message"]["id"],"correlation":"none","durable":false}}),
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
    let watch = |number: u64| json!({"v":2,"op":"discover","rid":rid(number),"scopeIds":["team"],"watch":true});
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
        &json!({"v":2,"op":"unwatch","rid":rid(4),"watchRid":rid(2)}),
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
        .stderr(Stdio::inherit())
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

const SCOPES: [&str; 2] = ["team", "private"];
const PERMISSIONS: [&str; 4] = ["discover", "read", "push", "interest"];
const RETIRED: [&str; 4] = ["state.get", "state.list", "interest.add", "interest.remove"];

fn subset(tc: &hegel::TestCase, items: &[&'static str], min: usize) -> Vec<&'static str> {
    use hegel::generators as gs;
    tc.draw(
        gs::vecs(gs::sampled_from(items.to_vec()))
            .min_size(min)
            .max_size(items.len())
            .unique(true),
    )
}

/// A real gateway with generated local grants per scope, some with the legacy direction, and two
/// registered sessions in generated scopes.
struct World {
    policies: Value,
    sender: UnixStream,
    sender_peer: Value,
    sender_scopes: Vec<&'static str>,
    receiver: UnixStream,
    receiver_peer: Value,
    receiver_scopes: Vec<&'static str>,
    _gateway: Gateway,
}
fn draw_world(tc: &hegel::TestCase) -> World {
    let mut policies = Vec::new();
    for scope in SCOPES {
        let permissions = subset(tc, &PERMISSIONS, 0);
        if !permissions.is_empty() {
            let mut policy = json!({"machineId":"alpha","scopeId":scope,"permissions":permissions});
            // 0.3.0 onboarding wrote "outgoing" on every local grant; it is accepted and ignored.
            if tc.draw(hegel::generators::booleans()) {
                policy["direction"] = json!("outgoing");
            }
            policies.push(policy);
        }
    }
    let policies = Value::from(policies);
    let gateway = Gateway::with_policies(&policies);
    let sender_scopes = subset(tc, &SCOPES, 1);
    let receiver_scopes = subset(tc, &SCOPES, 1);
    let mut sender = gateway.connect();
    let sender_peer = register(&mut sender, "sender", 10, &sender_scopes);
    let mut receiver = gateway.connect();
    let receiver_peer = register(&mut receiver, "receiver", 11, &receiver_scopes);
    World {
        policies,
        sender,
        sender_peer,
        sender_scopes,
        receiver,
        receiver_peer,
        receiver_scopes,
        _gateway: gateway,
    }
}
/// The live receiver, the same session after a restart, or a session on a machine with no route.
fn draw_target(tc: &hegel::TestCase, receiver: &Value) -> Value {
    use hegel::generators as gs;
    match tc.draw(gs::sampled_from(vec![0_u8, 1, 2])) {
        0 => receiver.clone(),
        1 => json!({"machineId":"alpha","sessionId":"receiver","runtimeNonce":rid(99)}),
        _ => json!({"machineId":"beta","sessionId":"receiver","runtimeNonce":rid(11)}),
    }
}
/// Oracle written from the policy text alone: local grants name only this machine.
fn granted(policies: &Value, machine: &str, scope: &str, permission: &str) -> bool {
    policies.as_array().into_iter().flatten().any(|policy| {
        policy["machineId"] == machine
            && policy["scopeId"] == scope
            && policy["permissions"]
                .as_array()
                .is_some_and(|listed| listed.iter().any(|item| item == permission))
    })
}
/// The session's next frame is the answer to a fresh request, so nothing else was queued for it.
fn assert_nothing_queued(stream: &mut UnixStream, number: u64) {
    write(
        stream,
        &json!({"v":2,"op":"discover","rid":rid(number),"scopeIds":["team"],"watch":false}),
    );
    let reply = read(stream);
    assert_eq!(
        (reply["rid"].clone(), reply["forOp"].clone()),
        (json!(rid(number)), json!("discover")),
        "the connection is alive and nothing else reached this session first"
    );
}

#[hegel::test(support::property_settings(100, 56789))]
fn send_and_discover_follow_the_local_grants_exactly(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let mut world = draw_world(&tc);
    let scope = tc.draw(gs::sampled_from(SCOPES.to_vec()));
    let target = draw_target(&tc, &world.receiver_peer);
    let machine = target["machineId"].as_str().unwrap_or("");
    // Sends to another machine are left to its gateway; local ones need a local push grant.
    let authorized = world.sender_scopes.contains(&scope)
        && (machine != "alpha" || granted(&world.policies, machine, scope, "push"));
    let delivered =
        authorized && target == world.receiver_peer && world.receiver_scopes.contains(&scope);
    write(
        &mut world.sender,
        &json!({"v":2,"op":"send","rid":rid(20),"to":target,"scopeId":scope,"budgetMs":15000,"message":{"id":rid(600),"kind":"request","content":"routed","format":"text"}}),
    );
    let message_id = rid(600);
    if delivered {
        let delivery = read(&mut world.receiver);
        assert_eq!(delivery["op"], "deliver");
        assert_eq!(delivery["from"], world.sender_peer);
        write(
            &mut world.receiver,
            &json!({"v":2,"op":"result","rid":delivery["rid"],"forOp":"deliver","outcome":{"tag":"admitted","messageId":message_id,"correlation":"none","durable":false}}),
        );
        assert_eq!(
            read(&mut world.sender)["outcome"],
            json!({"tag":"admitted","messageId":message_id,"correlation":"none","durable":false})
        );
    } else {
        let code = if authorized { "no_route" } else { "forbidden" };
        assert_eq!(
            read(&mut world.sender)["outcome"],
            json!({"tag":"not_admitted","messageId":message_id,"code":code}),
            "an unauthorized send is forbidden before any route lookup; an authorized one without a live member is no_route"
        );
    }
    let scopes = subset(&tc, &SCOPES, 1);
    let visible = scopes.iter().all(|scope| {
        world.sender_scopes.contains(scope) && granted(&world.policies, "alpha", scope, "discover")
    });
    write(
        &mut world.sender,
        &json!({"v":2,"op":"discover","rid":rid(21),"scopeIds":scopes,"watch":false}),
    );
    assert_eq!(
        read(&mut world.sender)["outcome"]["tag"],
        if visible { "ok" } else { "error" },
        "discover succeeds exactly when every requested scope is joined and granted"
    );
    assert_nothing_queued(&mut world.receiver, 22);
}

#[hegel::test(support::property_settings(100, 67890))]
fn retired_requests_are_refused_alike_whatever_the_grants_and_never_reach_a_session(
    tc: hegel::TestCase,
) {
    use hegel::generators as gs;
    let mut world = draw_world(&tc);
    let count = tc.draw(gs::sampled_from(vec![1_u64, 2, 3, 4]));
    for number in 30..30 + count {
        let op = tc.draw(gs::sampled_from(RETIRED.to_vec()));
        let publisher = draw_target(&tc, &world.receiver_peer);
        let scope = tc.draw(gs::sampled_from(vec!["team", "private", "elsewhere"]));
        let mut request =
            json!({"v":2,"op":op,"rid":rid(number),"publisher":publisher,"scopeId":scope});
        if op == "state.get" {
            request["key"] = json!("report");
        } else if op.starts_with("interest.") {
            request["work"] =
                json!({"kind":"request","origin":world.sender_peer,"requestId":rid(700)});
        }
        write(&mut world.sender, &request);
        assert_eq!(
            read(&mut world.sender),
            json!({"v":2,"op":"result","rid":rid(number),"forOp":op,"outcome":{"tag":"error","code":"forbidden"}}),
            "the same refusal whatever the grants, scope or target, so it reveals no route"
        );
    }
    assert_nothing_queued(&mut world.sender, 40);
    assert_nothing_queued(&mut world.receiver, 41);
}
