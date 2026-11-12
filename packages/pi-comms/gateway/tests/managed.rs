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
fn register(stream: &mut UnixStream, session: &str) {
    let body = serde_json::to_vec(&json!({"v":1,"op":"register","rid":"00000000000000000000000000000001","sessionId":session,"runtimeNonce":"00000000000000000000000000000002","scopeIds":["team"],"label":"Pi"})).expect("register JSON");
    stream
        .write_all(
            &u32::try_from(body.len())
                .expect("small frame")
                .to_be_bytes(),
        )
        .expect("frame length");
    stream.write_all(&body).expect("frame body");
    let mut length = [0; 4];
    stream.read_exact(&mut length).expect("response length");
    let mut response =
        vec![0; usize::try_from(u32::from_be_bytes(length)).expect("small response")];
    stream.read_exact(&mut response).expect("response body");
    let value: Value = serde_json::from_slice(&response).expect("response JSON");
    assert_eq!(value["outcome"]["tag"], "ok", "valid local registration");
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
        json!(["managed-on-demand-v1"]),
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
    let mut pending = Vec::new();
    let mut saturated = false;
    for _ in 0..1024 {
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
        pending.push(client);
        if result.is_err() {
            saturated = true;
            break;
        }
    }
    assert!(saturated, "fixture must fill the accept backlog");
    fixture.rejected();
    assert_eq!(
        fs::symlink_metadata(&socket)
            .expect("preserved socket")
            .ino(),
        metadata.ino(),
        "live recorded socket must survive a saturated probe"
    );
    drop(pending);
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
