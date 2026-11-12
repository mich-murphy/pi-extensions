//! Native managed lifecycle/ownership tests using only private temporary fixtures.
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct Fixture {
    directory: PathBuf,
    children: Vec<Child>,
}
impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir()
            .canonicalize()
            .expect("temp root")
            .join(format!(
                "pi-m-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&directory).expect("create fixture");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("private fixture");
        fs::write(directory.join("config"), serde_json::to_vec(&json!({"machineId":"alpha","socketPath":directory.join("s"),"scopeIds":["team"],"policies":[]})).expect("config JSON")).expect("write config");
        Self {
            directory,
            children: Vec::new(),
        }
    }
    fn spawn(&mut self, extra: &[&str]) -> usize {
        let mut command = Command::new(env!("CARGO_BIN_EXE_pi-gateway"));
        command.args(extra);
        let child = command
            .arg("--config")
            .arg(self.directory.join("config"))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn fixture");
        self.children.push(child);
        self.children.len() - 1
    }
    fn ready(&mut self, index: usize) {
        let stdout = self.children[index].stdout.take().expect("stdout");
        // A thread/channel bounds readiness so startup regressions cannot hang this test.
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read readiness");
            let _ = send.send(line);
        });
        let line = receive
            .recv_timeout(Duration::from_secs(5))
            .expect("bounded readiness");
        let ready: Value = serde_json::from_str(&line).expect("ready JSON");
        assert_eq!(ready["event"], "ready", "must bind before ready");
    }
    fn start(&mut self) -> usize {
        let index = self.spawn(&["--managed"]);
        self.ready(index);
        index
    }
    fn connect(&self) -> UnixStream {
        let stream = UnixStream::connect(self.directory.join("s")).expect("connect fixture");
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read bound");
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .expect("write bound");
        stream
    }
    fn exited(&mut self, index: usize, bound: Duration) -> bool {
        let until = Instant::now() + bound;
        loop {
            if self.children[index]
                .try_wait()
                .expect("wait fixture")
                .is_some()
            {
                return true;
            }
            if Instant::now() >= until {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn kill(&mut self, index: usize) {
        self.children[index].kill().expect("kill fixture");
        self.children[index].wait().expect("reap fixture");
    }
    fn rejected(&mut self) {
        let index = self.spawn(&["--managed"]);
        assert!(
            self.exited(index, Duration::from_secs(3)),
            "conflict must fail promptly"
        );
        assert!(
            !self.children[index].wait().expect("status").success(),
            "must fail closed"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}
fn request(stream: &mut UnixStream, value: &Value) {
    let body = serde_json::to_vec(value).expect("request JSON");
    stream
        .write_all(
            &u32::try_from(body.len())
                .expect("small frame")
                .to_be_bytes(),
        )
        .expect("frame length");
    stream.write_all(&body).expect("frame body");
}
fn response(stream: &mut UnixStream) -> Value {
    let mut length = [0; 4];
    stream.read_exact(&mut length).expect("response length");
    let mut body = vec![0; usize::try_from(u32::from_be_bytes(length)).expect("small response")];
    stream.read_exact(&mut body).expect("response body");
    serde_json::from_slice(&body).expect("response JSON")
}
fn registration(session: &str) -> Value {
    json!({"v":1,"op":"register","rid":"00000000000000000000000000000001","sessionId":session,"runtimeNonce":"00000000000000000000000000000002","scopeIds":["team"],"label":"Pi"})
}
fn register(stream: &mut UnixStream, session: &str) {
    request(stream, &registration(session));
    assert_eq!(
        response(stream)["outcome"]["tag"],
        "ok",
        "valid legacy local registration"
    );
}
fn fingerprint(bytes: &[u8]) -> String {
    use std::fmt::Write;
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .fold(String::new(), |mut output, byte| {
            write!(output, "{byte:02x}").expect("writing to String");
            output
        })
}
fn guarded(stream: &mut UnixStream, session: &str, hash: &str) -> Value {
    let mut value = registration(session);
    value["expectedConfigSha256"] = json!(hash);
    request(stream, &value);
    response(stream)
}

#[test]
fn participants_share_lifetime_and_reload_handoff() {
    let mut fixture = Fixture::new();
    let index = fixture.start();
    let mut first = fixture.connect();
    register(&mut first, "first");
    let mut second = fixture.connect();
    register(&mut second, "second");
    drop(first);
    assert!(
        !fixture.exited(index, Duration::from_millis(1000)),
        "one participant must sustain gateway"
    );
    drop(second);
    std::thread::sleep(Duration::from_millis(150));
    let mut replacement = fixture.connect();
    register(&mut replacement, "second");
    assert!(
        !fixture.exited(index, Duration::from_millis(1000)),
        "reload inside debounce must sustain gateway"
    );
    let _probe = fixture.connect();
    drop(replacement);
    assert!(
        fixture.exited(index, Duration::from_secs(3)),
        "unregistered health/probe socket must not sustain gateway"
    );
    assert!(
        fixture.children[index]
            .wait()
            .expect("exit status")
            .success(),
        "demand exit is clean"
    );
    assert!(
        !fixture.directory.join("s").exists(),
        "clean demand exit removes socket"
    );
}

#[test]
fn startup_has_bounded_grace_even_with_unregistered_connections() {
    let mut fixture = Fixture::new();
    let index = fixture.start();
    let _probe = fixture.connect();
    let started = Instant::now();
    loop {
        if fixture.children[index]
            .try_wait()
            .expect("startup status")
            .is_some()
        {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(12),
            "unregistered traffic must not reset startup grace"
        );
        if let Ok(mut stream) = UnixStream::connect(fixture.directory.join("s")) {
            // Incomplete prefix traffic is not a registration/participant.
            let _ = stream.write_all(&[0]);
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    assert!(
        started.elapsed() >= Duration::from_secs(9),
        "startup registration grace is real"
    );
    assert!(
        fixture.children[index]
            .wait()
            .expect("startup exit")
            .success(),
        "bounded idle exit is clean"
    );
}

#[test]
fn lock_contention_and_recorded_crash_recovery() {
    let mut fixture = Fixture::new();
    let first = fixture.start();
    let mut participant = fixture.connect();
    register(&mut participant, "first");
    fixture.rejected();
    assert!(
        !fixture.exited(first, Duration::from_millis(50)),
        "contender cannot stop owner"
    );
    fixture.kill(first);
    drop(participant);
    assert!(
        fixture.directory.join("s").exists(),
        "SIGKILL leaves recorded socket"
    );
    let recovered = fixture.start();
    let mut next = fixture.connect();
    register(&mut next, "next");
    drop(next);
    assert!(
        fixture.exited(recovered, Duration::from_secs(3)),
        "recovered daemon follows demand lifecycle"
    );
}

#[test]
fn unknown_external_and_replaced_sockets_are_never_removed() {
    let mut fixture = Fixture::new();
    let socket = fixture.directory.join("s");
    let external = UnixListener::bind(&socket).expect("external socket");
    let inode = fs::symlink_metadata(&socket)
        .expect("socket metadata")
        .ino();
    fixture.rejected();
    assert_eq!(
        fs::symlink_metadata(&socket)
            .expect("preserved socket")
            .ino(),
        inode,
        "unknown live socket preserved"
    );
    drop(external);
    fixture.rejected();
    assert!(socket.exists(), "unknown stale socket preserved");
    fs::remove_file(&socket).expect("fixture cleanup");
    let owner = fixture.start();
    fixture.kill(owner);
    fs::remove_file(&socket).expect("replace owned stale fixture");
    let replacement = UnixListener::bind(&socket).expect("replacement socket");
    let inode = fs::symlink_metadata(&socket).expect("metadata").ino();
    fixture.rejected();
    assert_eq!(
        fs::symlink_metadata(&socket)
            .expect("replacement survives")
            .ino(),
        inode,
        "replacement must not be removed"
    );
    drop(replacement);
}

#[test]
fn corrupt_and_symlink_lock_records_fail_closed() {
    let mut fixture = Fixture::new();
    let lock = fixture.directory.join("s.managed.lock");
    fs::write(&lock, b"interrupted record").expect("fixture record");
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).expect("private record");
    fixture.rejected();
    assert!(
        !fixture.directory.join("s").exists(),
        "corrupt record cannot bind"
    );
    fs::remove_file(&lock).expect("remove fixture record");
    let target = fixture.directory.join("target");
    fs::write(&target, b"unchanged").expect("target fixture");
    std::os::unix::fs::symlink(&target, &lock).expect("symlink fixture");
    fixture.rejected();
    assert_eq!(
        fs::read(&target).expect("target"),
        b"unchanged",
        "nofollow must preserve target"
    );
}

#[test]
fn manual_mode_remains_idle_and_version_is_side_effect_free() {
    let mut fixture = Fixture::new();
    let index = fixture.spawn(&[]);
    fixture.ready(index);
    assert!(
        !fixture.exited(index, Duration::from_secs(1)),
        "manual gateway is not demand governed"
    );
    let before = fs::read_dir(&fixture.directory)
        .expect("fixture listing")
        .count();
    let output = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .args(["--version", "--json"])
        .current_dir(&fixture.directory)
        .output()
        .expect("version command");
    assert!(
        output.status.success(),
        "version must succeed without config"
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("version JSON");
    assert_eq!(
        value["wireVersions"],
        json!([1]),
        "explicit wire compatibility"
    );
    assert_eq!(
        value["capabilities"],
        json!([
            "managed-on-demand-v1",
            "pairing-v1",
            "gateway-control-v1",
            "setup-lock-v1",
            "config-generation-v1"
        ]),
        "managed contract advertised"
    );
    assert!(
        output.stderr.is_empty(),
        "version emits no diagnostic noise"
    );
    assert_eq!(
        fs::read_dir(&fixture.directory).expect("listing").count(),
        before,
        "version creates no files"
    );
}

#[test]
fn recorded_live_socket_with_saturated_backlog_is_rejected_promptly() {
    const MAX_ATTEMPTS: usize = 65_538;
    let mut fixture = Fixture::new();
    let owner = fixture.start();
    let socket = fixture.directory.join("s");
    let metadata = fs::symlink_metadata(&socket).expect("socket metadata");
    let pid = rustix::process::Pid::from_raw(
        i32::try_from(fixture.children[owner].id()).expect("PID fits"),
    )
    .expect("positive PID");
    // Freeze the actual owner before filling its queue. Its kernel lifetime lock
    // must reject a contender before any potentially ambiguous socket probe.
    rustix::process::kill_process(pid, rustix::process::Signal::STOP)
        .expect("stop isolated fixture");
    // Mio requests listen(-1), so the OS cap applies (commonly 4096 on Linux,
    // 128 on Darwin). Closing a queued client does not drain the stopped owner's
    // accept queue on either platform. Avoid retaining one FD per queue entry:
    // a low test-process RLIMIT_NOFILE must not masquerade as saturation.
    // Allow up to a 64K queue plus Linux's extra entry and the failing probe,
    // with a separate time bound; unusually larger OS caps fail explicitly.
    let started = Instant::now();
    let mut saturated = false;
    for _ in 0..MAX_ATTEMPTS {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "accept backlog saturation must complete within five seconds"
        );
        let client = rustix::net::socket(
            rustix::net::AddressFamily::UNIX,
            rustix::net::SocketType::STREAM,
            None,
        )
        .expect("probe socket");
        rustix::fs::fcntl_setfl(&client, rustix::fs::OFlags::NONBLOCK)
            .expect("nonblocking fixture");
        let result = rustix::net::connect(
            &client,
            &rustix::net::SocketAddrUnix::new(&socket).expect("Unix address"),
        );
        drop(client);
        if let Err(error) = result {
            assert!(
                matches!(
                    error,
                    rustix::io::Errno::AGAIN | rustix::io::Errno::CONNREFUSED
                ),
                "expected a full live accept queue, not another connect error: {error}"
            );
            saturated = true;
            break;
        }
    }
    assert!(
        saturated,
        "fixture must fill the accept backlog within {MAX_ATTEMPTS} attempts"
    );
    fixture.rejected();
    assert_eq!(
        fs::symlink_metadata(&socket)
            .expect("preserved socket")
            .ino(),
        metadata.ino(),
        "live recorded socket must survive a saturated probe"
    );
    fixture.kill(owner);
}

/// Generates only isolated test credentials, and returns beta's connecting settings.
fn configure_remote(fixture: &Fixture) -> pi_gateway::remote::Settings {
    use rcgen::{
        BasicConstraints, CertificateParams, CertificateRevocationListParams,
        ExtendedKeyUsagePurpose, IsCa, Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose,
    };
    use time::{Duration as TimeDuration, OffsetDateTime};
    let now = OffsetDateTime::now_utc();
    let mut ca = CertificateParams::new(Vec::<String>::new()).expect("CA params");
    ca.distinguished_name
        .push(rcgen::DnType::CommonName, "managed lifecycle test CA");
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    ca.not_before = now - TimeDuration::days(1);
    ca.not_after = now + TimeDuration::days(7);
    let ca_key = KeyPair::generate().expect("test CA key");
    let root = ca.self_signed(&ca_key).expect("test root");
    let issuer = Issuer::from_params(&ca, &ca_key);
    let crl = CertificateRevocationListParams {
        this_update: now - TimeDuration::hours(1),
        next_update: now + TimeDuration::hours(12),
        crl_number: 1_u64.into(),
        issuing_distribution_point: None,
        revoked_certs: vec![],
        key_identifier_method: KeyIdMethod::Sha256,
    }
    .signed_by(&issuer)
    .expect("test CRL");
    let mut settings = Vec::new();
    for (own, peer) in [("alpha", "beta"), ("beta", "alpha")] {
        let directory = fixture.directory.join(own);
        fs::create_dir(&directory).expect("credential directory");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("private credentials");
        let mut leaf =
            CertificateParams::new(vec![format!("gateway.{own}.pi.internal")]).expect("leaf SAN");
        leaf.not_before = now - TimeDuration::hours(1);
        leaf.not_after = now + TimeDuration::days(1);
        leaf.serial_number = Some(42_u64.into());
        leaf.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ClientAuth,
            ExtendedKeyUsagePurpose::ServerAuth,
        ];
        let key = KeyPair::generate().expect("leaf key");
        let certificate = leaf.signed_by(&key, &issuer).expect("signed leaf");
        for (name, bytes) in [
            ("root", root.der().to_vec()),
            ("crl", crl.der().to_vec()),
            ("leaf", certificate.der().to_vec()),
            ("key", key.serialize_der()),
        ] {
            let path = directory.join(name);
            fs::write(&path, bytes).expect("generated private credential");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("private file");
        }
        let floor = directory.join("floor");
        drop(
            pi_gateway::revocation::FloorStore::initialize(&floor)
                .expect("explicit isolated floor bootstrap"),
        );
        settings.push(json!({"machineId":peer,"endpoint":{"mode":"listen","address":"127.0.0.1:0"},"rootCertificates":[directory.join("root")],"crls":[directory.join("crl")],"certificateChain":[directory.join("leaf")],"privateKey":directory.join("key"),"revocationState":floor}));
    }
    let path = fixture.directory.join("config");
    let mut config: Value =
        serde_json::from_slice(&fs::read(&path).expect("fixture config")).expect("JSON");
    config["remote"] = settings[0].clone();
    config["policies"] = json!([{"machineId":"beta","scopeId":"team","permissions":["discover"]}]);
    fs::write(path, serde_json::to_vec(&config).expect("updated JSON"))
        .expect("remote fixture config");
    pi_gateway::remote::Settings::parse(&serde_json::to_vec(&settings[1]).expect("settings JSON"))
        .expect("strict remote settings")
}

#[tokio::test]
async fn authenticated_remote_link_does_not_sustain_last_local_disconnect() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut fixture = Fixture::new();
    configure_remote(&fixture);
    let index = fixture.spawn(&["--managed"]);
    let stdout = fixture.children[index]
        .stdout
        .take()
        .expect("readiness stream");
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        BufReader::new(stdout)
            .read_line(&mut line)
            .expect("remote readiness");
        let _ = send.send(line);
    });
    let line = receive
        .recv_timeout(Duration::from_secs(5))
        .expect("bounded remote readiness");
    if line.is_empty() {
        let mut error = String::new();
        fixture.children[index]
            .stderr
            .take()
            .expect("stderr")
            .read_to_string(&mut error)
            .expect("startup error");
        panic!("remote startup failed: {error}");
    }
    let ready: Value = serde_json::from_str(&line).expect("ready JSON");
    // Parse the same generated settings after replacing the endpoint with the
    // actual port; this keeps all normal credential/floor validation enabled.
    let config: Value =
        serde_json::from_slice(&fs::read(fixture.directory.join("config")).expect("config"))
            .expect("JSON");
    let mut beta = config["remote"].clone();
    let beta_dir = fixture.directory.join("beta");
    beta["machineId"] = json!("alpha");
    beta["endpoint"] = json!({"mode":"connect","address":ready["remoteListenAddress"]});
    beta["rootCertificates"] = json!([beta_dir.join("root")]);
    beta["crls"] = json!([beta_dir.join("crl")]);
    beta["certificateChain"] = json!([beta_dir.join("leaf")]);
    beta["privateKey"] = json!(beta_dir.join("key"));
    beta["revocationState"] = json!(beta_dir.join("floor"));
    let settings =
        pi_gateway::remote::Settings::parse(&serde_json::to_vec(&beta).expect("beta settings"))
            .expect("beta strict config");
    let mut local = fixture.connect();
    register(&mut local, "local");
    let prepared = settings
        .prepare("beta")
        .expect("test-only remote preparation");
    let (mut remote, _lease) = tokio::time::timeout(Duration::from_secs(3), prepared.connect())
        .await
        .expect("bounded mTLS")
        .expect("authenticated remote")
        .into_parts();
    let mut header = [0; 4];
    tokio::time::timeout(Duration::from_secs(3), remote.read_exact(&mut header))
        .await
        .expect("roster deadline")
        .expect("remote roster request");
    let mut body =
        vec![0; usize::try_from(u32::from_be_bytes(header)).expect("small roster frame")];
    remote.read_exact(&mut body).await.expect("roster body");
    let roster: Value = serde_json::from_slice(&body).expect("roster JSON");
    assert_eq!(roster["op"], "discover", "authenticated remote activated");
    let reply = serde_json::to_vec(&json!({"v":1,"op":"result","rid":roster["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":[],"watching":true}}})).expect("roster reply");
    remote
        .write_all(
            &u32::try_from(reply.len())
                .expect("small reply")
                .to_be_bytes(),
        )
        .await
        .expect("reply header");
    remote.write_all(&reply).await.expect("reply body");
    drop(local);
    assert!(
        fixture.exited(index, Duration::from_secs(3)),
        "authenticated remote socket must not sustain an empty local roster"
    );
    assert!(
        fixture.children[index].wait().expect("status").success(),
        "remote-connected demand exit is clean"
    );
    assert!(
        !fixture.directory.join("s").exists(),
        "managed socket removed with remote still connected"
    );
}

#[test]
fn interrupted_record_write_preserves_unproven_socket_and_reports_safe_recovery() {
    for record in [b"".as_slice(), b"{\"socket\":"] {
        let mut fixture = Fixture::new();
        let owner = fixture.start();
        fixture.kill(owner);
        let socket = fixture.directory.join("s");
        let before = fs::symlink_metadata(&socket).expect("stale socket");
        // Fault injection: durable record is empty/torn as if killed between bind
        // and record sync. Do not forge a matching record or unlink the socket.
        fs::write(fixture.directory.join("s.managed.lock"), record).expect("inject torn record");
        let contender = fixture.spawn(&["--managed"]);
        assert!(
            fixture.exited(contender, Duration::from_secs(3)),
            "ambiguous startup bounded"
        );
        let mut diagnostic = String::new();
        fixture.children[contender]
            .stderr
            .take()
            .expect("stderr")
            .read_to_string(&mut diagnostic)
            .expect("diagnostic");
        assert!(
            diagnostic.contains("managed-ownership-ambiguous")
                && diagnostic.contains("never unlink an unverified socket"),
            "actionable fail-closed diagnostic: {diagnostic}"
        );
        let after = fs::symlink_metadata(&socket).expect("unproven socket preserved");
        assert_eq!(
            (before.dev(), before.ino()),
            (after.dev(), after.ino()),
            "never substitutes path/refusal for incarnation proof"
        );
    }
}

#[test]
fn managed_restart_is_machine_bound_and_closes_two_surviving_participants_after_ack() {
    let mut fixture = Fixture::new();
    let owner = fixture.start();
    let mut first = fixture.connect();
    let mut second = fixture.connect();
    register(&mut first, "first");
    register(&mut second, "second");
    let wrong = fixture.directory.join("wrong-config");
    fs::write(&wrong, serde_json::to_vec(&json!({"machineId":"beta","socketPath":fixture.directory.join("s"),"scopeIds":["team"],"policies":[]})).expect("wrong config JSON")).expect("wrong config");
    let rejected = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .arg("--request-restart")
        .arg(wrong)
        .output()
        .expect("wrong-machine restart");
    assert!(!rejected.status.success(), "machine mismatch must refuse");
    assert!(
        fixture.children[owner]
            .try_wait()
            .expect("live owner")
            .is_none(),
        "mismatch cannot stop gateway"
    );
    let accepted = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .arg("--request-restart")
        .arg(fixture.directory.join("config"))
        .output()
        .expect("restart CLI");
    assert!(
        accepted.status.success(),
        "exact acknowledgement: {}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    let output: Value = serde_json::from_slice(&accepted.stdout).expect("public control JSON");
    assert_eq!(output["state"], "restart-requested");
    assert!(
        fixture.exited(owner, Duration::from_secs(3)),
        "managed exits after flushing ACK"
    );
    assert_eq!(first.read(&mut [0; 1]).expect("first disconnected"), 0);
    assert_eq!(second.read(&mut [0; 1]).expect("second disconnected"), 0);
    assert!(
        !fixture.directory.join("s").exists(),
        "normal inode-owned cleanup"
    );
}

#[test]
fn manual_gateway_refuses_restart_control() {
    let mut fixture = Fixture::new();
    let owner = fixture.spawn(&[]);
    fixture.ready(owner);
    let output = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .arg("--request-restart")
        .arg(fixture.directory.join("config"))
        .output()
        .expect("manual restart CLI");
    assert!(
        !output.status.success(),
        "manual owner never accepts control"
    );
    let mut participant = fixture.connect();
    register(&mut participant, "still-manual");
    assert!(
        fixture.children[owner]
            .try_wait()
            .expect("manual alive")
            .is_none(),
        "manual gateway survives refusal"
    );
}

#[test]
fn setup_lock_is_permanent_private_and_releases_on_eof_and_crash() {
    let fixture = Fixture::new();
    let path = fixture.directory.join("setup.lock");
    let spawn = || {
        Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .arg("--setup-lock")
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("setup lock child")
    };
    let mut owner = spawn();
    let mut line = String::new();
    BufReader::new(owner.stdout.take().expect("lock stdout"))
        .read_line(&mut line)
        .expect("lock ready");
    assert_eq!(
        serde_json::from_str::<Value>(&line).expect("lock JSON")["state"],
        "locked"
    );
    let before = fs::symlink_metadata(&path).expect("permanent lock");
    assert_eq!(before.mode() & 0o777, 0o600, "private lock");
    let conflict = spawn().wait_with_output().expect("conflicting lock");
    assert!(!conflict.status.success(), "contention fails promptly");
    drop(owner.stdin.take());
    assert!(
        owner.wait().expect("EOF release").success(),
        "EOF cleanly releases lock"
    );
    let mut next = spawn();
    line.clear();
    BufReader::new(next.stdout.take().expect("lock stdout"))
        .read_line(&mut line)
        .expect("second ready");
    next.kill().expect("inject lock owner crash");
    next.wait().expect("reap crashed owner");
    let mut final_owner = spawn();
    line.clear();
    BufReader::new(final_owner.stdout.take().expect("lock stdout"))
        .read_line(&mut line)
        .expect("third ready");
    drop(final_owner.stdin.take());
    final_owner.wait().expect("final EOF");
    let after = fs::symlink_metadata(path).expect("lock never unlinked");
    assert_eq!(
        (before.dev(), before.ino()),
        (after.dev(), after.ino()),
        "no split-lock inode replacement"
    );
}

#[test]
fn stopped_owner_accepts_closed_queued_peer_without_terminating_surviving_or_new_sessions() {
    let mut fixture = Fixture::new();
    let owner = fixture.start();
    let mut survivor = fixture.connect();
    register(&mut survivor, "survivor");
    let pid = rustix::process::Pid::from_raw(
        i32::try_from(fixture.children[owner].id()).expect("child PID fits"),
    )
    .expect("child PID");
    rustix::process::kill_process(pid, rustix::process::Signal::STOP)
        .expect("stop only owned child");
    let (_, status) = rustix::process::waitpid(Some(pid), rustix::process::WaitOptions::UNTRACED)
        .expect("confirm stopped child")
        .expect("child stopped");
    assert!(
        status.stopped(),
        "kernel confirms owner is stopped before queue injection"
    );
    // This connect-and-close is deliberately completed before accept can execute.
    // Darwin LOCAL_PEEREPID then returns ENOTCONN for the disconnected peer.
    // The TS launcher's connect/destroy reachability probe can do exactly this.
    drop(fixture.connect());
    rustix::process::kill_process(pid, rustix::process::Signal::CONT)
        .expect("resume only owned child");
    let mut fresh = fixture.connect();
    register(&mut fresh, "fresh-after-closed-peer");
    assert!(
        fixture.children[owner]
            .try_wait()
            .expect("owner status")
            .is_none(),
        "one disconnected peer cannot terminate gateway"
    );
    assert!(
        !fixture.exited(owner, Duration::from_millis(100)),
        "registered survivor keeps owner alive after rejected peer"
    );
}

#[test]
fn guarded_registration_binds_loaded_bytes_not_changed_disk_and_has_no_rejection_effects() {
    let mut fixture = Fixture::new();
    let path = fixture.directory.join("config");
    let mut config: Value =
        serde_json::from_slice(&fs::read(&path).expect("config")).expect("JSON");
    config["policies"] = json!([{"machineId":"alpha","scopeId":"team","permissions":["discover"]}]);
    let loaded = serde_json::to_vec(&config).expect("loaded bytes");
    fs::write(&path, &loaded).expect("initial config");
    let old_hash = fingerprint(&loaded);
    let owner = fixture.start();
    let mut survivor = fixture.connect();
    register(&mut survivor, "legacy-survivor");

    // Same JSON meaning, different bytes, after successful startup.
    let formatted = serde_json::to_vec_pretty(&config).expect("formatted config");
    let new_hash = fingerprint(&formatted);
    assert_ne!(old_hash, new_hash, "formatting is part of the generation");
    fs::write(&path, formatted).expect("change disk after load");
    let mut rejected = fixture.connect();
    assert_eq!(
        guarded(&mut rejected, "candidate", &new_hash)["outcome"],
        json!({"tag":"error","code":"config_mismatch"}),
        "must not reread new disk bytes"
    );
    // The failed attempt must not reserve the identity. Same socket and identity work.
    assert_eq!(
        guarded(&mut rejected, "candidate", &old_hash)["outcome"]["tag"],
        "ok",
        "loaded bytes still admitted"
    );
    let admitted = rejected;

    // A genuinely narrower policy is likewise not served by this old process.
    config["policies"][0]["permissions"] = json!(["read"]);
    let narrowed = serde_json::to_vec(&config).expect("narrowed config");
    fs::write(&path, &narrowed).expect("commit narrowed config");
    let mut mismatch = fixture.connect();
    assert_eq!(
        guarded(&mut mismatch, "not-in-roster", &fingerprint(&narrowed))["outcome"]["code"],
        "config_mismatch"
    );
    for malformed in ["A".repeat(64), "a".repeat(63), "g".repeat(64)] {
        let mut stream = fixture.connect();
        let mut value = registration("malformed");
        value["expectedConfigSha256"] = json!(malformed);
        request(&mut stream, &value);
        assert_eq!(
            stream.read(&mut [0; 1]).expect("malformed rejected"),
            0,
            "strict malformed hash closes connection"
        );
    }
    request(
        &mut survivor,
        &json!({"v":1,"op":"discover","rid":"00000000000000000000000000000003","scopeIds":["team"],"watch":false}),
    );
    let snapshot = response(&mut survivor);
    let peers = snapshot["outcome"]["value"]["peers"]
        .as_array()
        .expect("roster");
    assert_eq!(
        peers.len(),
        2,
        "only legacy survivor and correctly guarded participant registered"
    );
    assert!(
        peers
            .iter()
            .all(|peer| peer["peer"]["sessionId"] != "not-in-roster"),
        "mismatch has no roster effect"
    );
    drop(survivor);
    drop(admitted);
    assert!(
        fixture.exited(owner, Duration::from_secs(3)),
        "connected rejected registration cannot sustain managed lifetime"
    );
}

#[test]
fn matching_fingerprint_manual_registration_fails_but_legacy_still_works() {
    let mut fixture = Fixture::new();
    let hash = fingerprint(&fs::read(fixture.directory.join("config")).expect("config bytes"));
    let owner = fixture.spawn(&[]);
    fixture.ready(owner);
    let mut stream = fixture.connect();
    assert_eq!(
        guarded(&mut stream, "manual", &hash)["outcome"],
        json!({"tag":"error","code":"config_mismatch"}),
        "manual daemon cannot satisfy managed guard even with matching bytes"
    );
    register(&mut stream, "manual");
}

#[test]
fn rejected_guard_does_not_start_participant_disconnect_grace() {
    let mut fixture = Fixture::new();
    let owner = fixture.start();
    let started = Instant::now();
    let mut stream = fixture.connect();
    assert_eq!(
        guarded(&mut stream, "not-a-participant", &"0".repeat(64))["outcome"]["code"],
        "config_mismatch"
    );
    drop(stream);
    assert!(
        fixture.exited(owner, Duration::from_secs(12)),
        "startup grace remains bounded"
    );
    assert!(
        started.elapsed() >= Duration::from_secs(9),
        "mismatch must not enter shorter post-participant grace"
    );
}
