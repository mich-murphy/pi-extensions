//! Shared CLI fixture and real two-gateway mTLS/local degradation journeys.
#[path = "support/pair_fixture.rs"]
mod fixture;
use fixture::Fixture;
use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct Gateway {
    child: Child,
    ready: Value,
}
impl Gateway {
    fn start(f: &Fixture, name: &str, credentials: &Value, endpoint: Value) -> Self {
        Self::start_mode(f, name, credentials, endpoint, &[])
    }
    fn start_mode(
        f: &Fixture,
        name: &str,
        credentials: &Value,
        endpoint: Value,
        flags: &[&str],
    ) -> Self {
        let mut remote = credentials.clone();
        let peer = remote["peerMachineId"].clone();
        remote
            .as_object_mut()
            .expect("credentials object")
            .remove("pairId");
        remote
            .as_object_mut()
            .expect("credentials object")
            .remove("peerMachineId");
        remote
            .as_object_mut()
            .expect("credentials object")
            .remove("version");
        remote
            .as_object_mut()
            .expect("credentials object")
            .remove("operation");
        remote
            .as_object_mut()
            .expect("credentials object")
            .remove("activationRequired");
        remote["machineId"] = peer.clone();
        remote["endpoint"] = endpoint;
        let config = json!({"machineId":name,"socketPath":f.path(&format!("{name}.sock")),"scopeIds":["team"],"policies":[{"machineId":name,"scopeId":"team","permissions":["discover"]},{"machineId":peer,"scopeId":"team","permissions":["discover"]},{"machineId":peer,"scopeId":"team","permissions":["discover"],"direction":"incoming"}],"remote":remote});
        let path = f.path(&format!("{name}-config.json"));
        fs::write(&path, serde_json::to_vec(&config).expect("config JSON")).expect("write config");
        let child = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .args(flags)
            .arg("--config")
            .arg(path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn gateway");
        let mut gateway = Self {
            child,
            ready: Value::Null,
        };
        let stdout = gateway.child.stdout.take().expect("ready pipe");
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("ready line");
            let _ = send.send(line);
        });
        let line = receive
            .recv_timeout(Duration::from_secs(5))
            .expect("bounded startup");
        gateway.ready = serde_json::from_str(&line).expect("ready JSON");
        gateway
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn request(stream: &mut UnixStream, body: &Value) -> Value {
    let body = serde_json::to_vec(body).expect("request JSON");
    stream
        .write_all(
            &u32::try_from(body.len())
                .expect("bounded body")
                .to_be_bytes(),
        )
        .expect("length");
    stream.write_all(&body).expect("body");
    let mut length = [0; 4];
    stream.read_exact(&mut length).expect("response length");
    let mut body = vec![0; usize::try_from(u32::from_be_bytes(length)).expect("response length")];
    stream.read_exact(&mut body).expect("response body");
    serde_json::from_slice(&body).expect("response JSON")
}
fn register(f: &Fixture, name: &str) -> UnixStream {
    let mut stream = UnixStream::connect(f.path(&format!("{name}.sock"))).expect("local socket");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read deadline");
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .expect("write deadline");
    let response = request(
        &mut stream,
        &json!({"v":1,"op":"register","rid":"00000000000000000000000000000001","sessionId":name,"runtimeNonce":"00000000000000000000000000000002","scopeIds":["team"],"label":"Pi"}),
    );
    assert_eq!(response["outcome"]["tag"], "ok", "local registration");
    stream
}
fn diagnose(f: &Fixture, name: &str) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .arg("--diagnose")
        .arg(f.path(&format!("{name}-config.json")))
        .output()
        .expect("diagnose");
    assert!(output.status.success(), "read-only diagnose succeeds");
    serde_json::from_slice(&output.stdout).expect("diagnostic JSON")
}
#[test]
fn cli_pair_operates_two_real_gateways_with_mtls_and_readonly_active_floor_diagnostic() {
    let f = Fixture::new();
    let (_, alpha, beta) = f.issued();
    let beta_gateway = Gateway::start(
        &f,
        "beta",
        &beta,
        json!({"mode":"listen","address":"127.0.0.1:0"}),
    );
    let _alpha_gateway = Gateway::start(
        &f,
        "alpha",
        &alpha,
        json!({"mode":"connect","address":beta_gateway.ready["remoteListenAddress"]}),
    );
    let mut a = register(&f, "alpha");
    let _b = register(&f, "beta");
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let response = request(
            &mut a,
            &json!({"v":1,"op":"discover","rid":"00000000000000000000000000000003","scopeIds":["team"],"watch":false}),
        );
        if response.to_string().contains("\"machineId\":\"beta\"") {
            break;
        }
        assert!(
            Instant::now() < until,
            "authenticated remote roster arrives: {response}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let floor = alpha["revocationState"].as_str().unwrap();
    let bytes = fs::read(floor).unwrap();
    let modified = fs::metadata(floor).unwrap().modified().unwrap();
    assert_eq!(
        diagnose(&f, "alpha")["remote"]["state"],
        "configured",
        "held floor lock is not degradation"
    );
    assert_eq!(
        bytes,
        fs::read(floor).unwrap(),
        "diagnose never commits floors"
    );
    assert_eq!(
        modified,
        fs::metadata(floor).unwrap().modified().unwrap(),
        "diagnose does not write"
    );
}
#[test]
fn missing_floor_or_expired_crl_disables_remote_but_local_still_registers() {
    for fault in ["missing-floor", "expired-crl", "expired-leaf", "bad-crl"] {
        let f = Fixture::new();
        let (_, alpha, _) = f.issued();
        if fault == "missing-floor" {
            fs::remove_file(alpha["revocationState"].as_str().unwrap()).unwrap();
        } else {
            let root = fs::read(alpha["rootCertificates"][0].as_str().unwrap()).unwrap();
            let key = rcgen::KeyPair::try_from(
                fs::read(f.path("issuer/issuer-key.der"))
                    .unwrap()
                    .as_slice(),
            )
            .unwrap();
            let issuer = rcgen::Issuer::from_ca_cert_der(&root.as_slice().into(), key).unwrap();
            let now = time::OffsetDateTime::now_utc();
            if fault == "expired-leaf" {
                let key = rcgen::KeyPair::try_from(
                    fs::read(alpha["privateKey"].as_str().unwrap())
                        .unwrap()
                        .as_slice(),
                )
                .unwrap();
                let mut params =
                    rcgen::CertificateParams::new(vec!["gateway.alpha.pi.internal".into()])
                        .unwrap();
                params.not_before = now - time::Duration::days(2);
                params.not_after = now - time::Duration::days(1);
                params.extended_key_usages = vec![
                    rcgen::ExtendedKeyUsagePurpose::ClientAuth,
                    rcgen::ExtendedKeyUsagePurpose::ServerAuth,
                ];
                let cert = params.signed_by(&key, &issuer).unwrap();
                fs::write(alpha["certificateChain"][0].as_str().unwrap(), cert.der()).unwrap();
            } else if fault == "bad-crl" {
                fs::write(alpha["crls"][0].as_str().unwrap(), b"invalid CRL").unwrap();
            } else {
                let crl = rcgen::CertificateRevocationListParams {
                    this_update: now - time::Duration::days(2),
                    next_update: now - time::Duration::days(1),
                    crl_number: 99_u64.into(),
                    issuing_distribution_point: None,
                    revoked_certs: vec![],
                    key_identifier_method: rcgen::KeyIdMethod::Sha256,
                }
                .signed_by(&issuer)
                .unwrap();
                fs::write(alpha["crls"][0].as_str().unwrap(), crl.der()).unwrap();
            }
        }
        let gateway = Gateway::start(
            &f,
            "alpha",
            &alpha,
            json!({"mode":"listen","address":"127.0.0.1:0"}),
        );
        assert!(
            gateway.ready.get("remoteListenAddress").is_none(),
            "remote endpoint stays closed: {fault}"
        );
        let _local = register(&f, "alpha");
        assert_eq!(
            diagnose(&f, "alpha")["remote"]["state"],
            "degraded",
            "truthful snapshot: {fault}"
        );
        if fault == "missing-floor" {
            assert!(
                !std::path::Path::new(alpha["revocationState"].as_str().unwrap()).exists(),
                "no floor repair"
            );
        }
    }
}

#[test]
fn live_locked_floor_allows_staging_but_staged_rollback_is_rejected_before_control_activation() {
    let f = Fixture::new();
    let (creator, _, beta) = f.issued();
    let mut gateway = Gateway::start_mode(
        &f,
        "beta",
        &beta,
        json!({"mode":"listen","address":"127.0.0.1:0"}),
        &["--managed"],
    );
    let _participant = register(&f, "beta");
    let floor = beta["revocationState"].as_str().unwrap();
    let before = fs::read(floor).unwrap();
    let old_bundle = f.path("old-bundle.json");
    fs::copy(f.path("issuer/bundle.json"), &old_bundle).unwrap();
    let inspect = f.ok("inspect", &json!({"runtimeDir":f.path("beta")}));
    let renewed = f.ok("renew",&json!({"issuerDir":f.path("issuer"),"requestPath":inspect["requestPath"],"confirmedRequestSha256":inspect["requestSha256"]}));
    let staged = f.ok("import",&json!({"runtimeDir":f.path("beta"),"bundlePath":renewed["bundlePath"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
    assert_eq!(staged["activationRequired"], true);
    assert_eq!(
        before,
        fs::read(floor).unwrap(),
        "staging never commits held live floor"
    );
    let rollback = f.run("import",&json!({"runtimeDir":f.path("beta"),"bundlePath":old_bundle,"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
    assert!(
        !rollback.status.success(),
        "already-staged generation protects unactivated newer CRL"
    );
    let path = f.path("beta-config.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for field in [
        "rootCertificates",
        "certificateChain",
        "issuerCertificates",
        "privateKey",
        "crls",
        "revocationState",
    ] {
        config["remote"][field] = staged[field].clone();
    }
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .arg("--request-restart")
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "control acknowledgement: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let until = Instant::now() + Duration::from_secs(3);
    while gateway.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < until, "bounded old owner exit");
        std::thread::sleep(Duration::from_millis(10));
    }
    let _replacement = Gateway::start_mode(
        &f,
        "beta",
        &staged,
        json!({"mode":"listen","address":"127.0.0.1:0"}),
        &["--managed"],
    );
    let _participant = register(&f, "beta");
    assert_ne!(
        before,
        fs::read(floor).unwrap(),
        "startup persists newer floor before remote readiness"
    );
    assert_eq!(diagnose(&f, "beta")["remote"]["state"], "configured");
}

#[tokio::test]
async fn authenticated_remote_cannot_request_managed_restart() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let f = Fixture::new();
    let (_, alpha, beta) = f.issued();
    let mut gateway = Gateway::start_mode(
        &f,
        "beta",
        &beta,
        json!({"mode":"listen","address":"127.0.0.1:0"}),
        &["--managed"],
    );
    let _participant = register(&f, "beta");
    let trust = pi_gateway::tls::Trust::from_der(
        vec![fs::read(alpha["rootCertificates"][0].as_str().unwrap()).unwrap()],
        vec![fs::read(alpha["crls"][0].as_str().unwrap()).unwrap()],
    )
    .unwrap();
    let config = pi_gateway::tls::Policy::new(trust, "beta")
        .unwrap()
        .client_config(
            vec![fs::read(alpha["certificateChain"][0].as_str().unwrap()).unwrap()],
            fs::read(alpha["privateKey"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
    let tcp =
        tokio::net::TcpStream::connect(gateway.ready["remoteListenAddress"].as_str().unwrap())
            .await
            .unwrap();
    let mut tls = connector
        .connect(
            rustls::pki_types::ServerName::try_from("gateway.beta.pi.internal").unwrap(),
            tcp,
        )
        .await
        .unwrap();
    let body = serde_json::to_vec(&json!({"v":1,"op":"gateway.restart","rid":"00000000000000000000000000000009","expectedMachineId":"beta"})).unwrap();
    tls.write_all(&u32::try_from(body.len()).unwrap().to_be_bytes())
        .await
        .unwrap();
    tls.write_all(&body).await.unwrap();
    let mut remaining = Vec::new();
    let result =
        tokio::time::timeout(Duration::from_secs(3), tls.read_to_end(&mut remaining)).await;
    assert!(
        result.is_ok(),
        "authenticated remote invalid control is closed promptly"
    );
    assert!(
        gateway.child.try_wait().unwrap().is_none(),
        "remote cannot stop managed gateway"
    );
    let config = f.path("beta-config.json");
    let status = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .arg("--diagnose")
        .arg(config)
        .output()
        .unwrap();
    assert!(status.status.success(), "local gateway remains available");
}

fn bounded_output(command: &mut Command) -> std::process::Output {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("bounded child");
    let until = Instant::now() + Duration::from_secs(3);
    while child.try_wait().expect("child status").is_none() {
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            panic!("read-only FIFO operation must not hang");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().expect("bounded output")
}
#[test]
fn fifo_floor_diagnose_and_existing_import_are_bounded_and_do_not_repair_state() {
    let f = Fixture::new();
    let (creator, alpha, _) = f.issued();
    let mut gateway = Gateway::start(
        &f,
        "alpha",
        &alpha,
        json!({"mode":"listen","address":"127.0.0.1:0"}),
    );
    gateway.child.kill().unwrap();
    gateway.child.wait().unwrap();
    let floor = std::path::Path::new(alpha["revocationState"].as_str().unwrap());
    fs::remove_file(floor).unwrap();
    assert!(
        Command::new("mkfifo")
            .args(["-m", "600"])
            .arg(floor)
            .status()
            .unwrap()
            .success(),
        "native owned FIFO fixture"
    );
    let output = bounded_output(
        Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .arg("--diagnose")
            .arg(f.path("alpha-config.json")),
    );
    assert!(
        output.status.success(),
        "operational floor failure reported as degradation"
    );
    let diagnostic: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        diagnostic["remote"]["reason"],
        "revocation-floor-unavailable"
    );
    let input = json!({"runtimeDir":f.path("alpha"),"bundlePath":f.path("issuer/bundle.json"),"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"});
    fs::write(
        f.path("fifo-input.json"),
        serde_json::to_vec(&input).unwrap(),
    )
    .unwrap();
    let output = bounded_output(
        Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .args(["pair", "import", "--input"])
            .arg(f.path("fifo-input.json")),
    );
    assert!(
        !output.status.success(),
        "FIFO snapshot cannot authorize import"
    );
    assert!(
        fs::symlink_metadata(floor).unwrap().file_type().is_fifo(),
        "no replacement or repair"
    );
}

#[test]
fn occupied_remote_port_degrades_only_remote_and_does_not_rebind() {
    let f = Fixture::new();
    let (_, alpha, _) = f.issued();
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = occupied.local_addr().unwrap();
    let floor = alpha["revocationState"].as_str().unwrap();
    let before = fs::read(floor).unwrap();
    // A renewed staged generation proves the floor commits even when bind fails.
    let inspected = f.ok("inspect", &json!({"runtimeDir":f.path("alpha")}));
    let renewed = f.ok("renew", &json!({"issuerDir":f.path("issuer"),"requestPath":inspected["requestPath"],"confirmedRequestSha256":inspected["requestSha256"]}));
    let staged = f.ok("import", &json!({"runtimeDir":f.path("alpha"),"bundlePath":renewed["bundlePath"],"confirmedRootSha256":inspected["rootSha256"],"floorMode":"existing"}));
    assert_eq!(before, fs::read(floor).unwrap());
    let mut gateway = Gateway::start(
        &f,
        "alpha",
        &staged,
        json!({"mode":"listen","address":address.to_string()}),
    );
    assert_ne!(
        before,
        fs::read(floor).unwrap(),
        "floor commits before attempted activation"
    );
    assert!(gateway.ready.get("remoteListenAddress").is_none());
    let _local = register(&f, "alpha");
    assert_eq!(
        diagnose(&f, "alpha")["remote"]["state"],
        "configured",
        "static credential validation is not bind status"
    );
    drop(occupied);
    let reclaimed = std::net::TcpListener::bind(address).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert!(gateway.child.try_wait().unwrap().is_none());
    drop(reclaimed);
    assert!(
        std::net::TcpStream::connect(address).is_err(),
        "no background rebind"
    );
    gateway.child.kill().unwrap();
    gateway.child.wait().unwrap();
    let mut stderr = String::new();
    gateway
        .child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    assert_eq!(stderr.trim(), "remote degraded: remote-listen-unavailable");
}

#[test]
fn import_existing_checks_snapshot_while_gateway_holds_floor_before_runtime_effects() {
    let f = Fixture::new();
    let (creator, alpha, _) = f.issued();
    let _gateway = Gateway::start(
        &f,
        "alpha",
        &alpha,
        json!({"mode":"listen","address":"127.0.0.1:0"}),
    );
    let _local = register(&f, "alpha");
    let floor = alpha["revocationState"].as_str().unwrap();
    let before = fs::read(floor).unwrap();
    let modified = fs::metadata(floor).unwrap().modified().unwrap();
    let mut input = json!({"runtimeDir":f.path("migrated"),"machineId":"alpha","peerMachineId":"beta","rootCertificate":alpha["rootCertificates"][0],"certificate":alpha["certificateChain"][0],"privateKey":alpha["privateKey"],"crl":alpha["crls"][0],"revocationState":floor,"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"});
    let migrated = f.ok("import-existing", &input);
    assert_eq!(migrated["activationRequired"], true);
    assert_eq!(migrated["revocationState"], floor);
    assert_eq!(before, fs::read(floor).unwrap());
    assert_eq!(modified, fs::metadata(floor).unwrap().modified().unwrap());
    input["runtimeDir"] = json!(f.path("missing-runtime"));
    input["revocationState"] = json!(f.path("missing-floor"));
    assert!(!f.run("import-existing", &input).status.success());
    assert!(
        !f.path("missing-runtime").exists(),
        "missing floor fails before runtime creation"
    );
    assert!(!f.path("missing-floor").exists());
    // A newer active floor must also be checked before creating a runtime.
    let inspected = f.ok("inspect", &json!({"runtimeDir":f.path("alpha")}));
    let renewed = f.ok("renew", &json!({"issuerDir":f.path("issuer"),"requestPath":inspected["requestPath"],"confirmedRequestSha256":inspected["requestSha256"]}));
    let staged = f.ok("import", &json!({"runtimeDir":f.path("alpha"),"bundlePath":renewed["bundlePath"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
    // Use a separate explicit floor to avoid mutating the gateway-held floor.
    let newer_floor = f.path("newer-floor.json");
    fs::copy(floor, &newer_floor).unwrap();
    let trust = pi_gateway::tls::Trust::from_der(
        vec![fs::read(staged["rootCertificates"][0].as_str().unwrap()).unwrap()],
        vec![fs::read(staged["crls"][0].as_str().unwrap()).unwrap()],
    )
    .unwrap();
    pi_gateway::revocation::FloorStore::open(&newer_floor)
        .unwrap()
        .apply(&trust)
        .unwrap();
    input["runtimeDir"] = json!(f.path("rollback-runtime"));
    input["revocationState"] = json!(newer_floor);
    assert!(!f.run("import-existing", &input).status.success());
    assert!(
        !f.path("rollback-runtime").exists(),
        "rollback fails before runtime creation"
    );
}
