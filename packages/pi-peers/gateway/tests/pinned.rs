//! Pinned raw-public-key mutual TLS: the `key` command, strict configuration, live loopback
//! handshakes and two real gateways linking with nothing but each other's public key.
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use pi_gateway::config::Config;
use pi_gateway::remote::Settings;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod support;

static NEXT: AtomicU64 = AtomicU64::new(1);

/// An owner-only temporary directory, removed on drop.
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .canonicalize()
            .expect("temporary root")
            .join(format!(
                "pi-k-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&path).expect("isolated key directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("owner-only key directory");
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    /// Generates a key named `name` and returns its path and public key text.
    fn key(&self, name: &str) -> (PathBuf, String) {
        let path = self.path(name);
        let public = pi_gateway::keys::generate(&path).expect("generated test key");
        (path, public)
    }
    fn run(&self, operation: &str, input: &Value) -> Output {
        let path = self.path("input.json");
        fs::write(&path, serde_json::to_vec(input).expect("input JSON")).expect("input file");
        Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .args(["key", operation, "--input"])
            .arg(path)
            .output()
            .expect("run key command")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn remote(key: &Path, peer: &str, peer_key: &str, mode: &str, address: &str) -> Value {
    json!({"machineId":peer,"endpoint":{"mode":mode,"address":address},"privateKey":key,"peerPublicKey":peer_key})
}
fn settings(key: &Path, peer: &str, peer_key: &str, mode: &str, address: &str) -> Settings {
    Settings::parse(
        &serde_json::to_vec(&remote(key, peer, peer_key, mode, address)).expect("settings JSON"),
    )
    .expect("strict pinned settings")
}
fn spki(public: &str) -> Vec<u8> {
    let raw = pi_gateway::keys::parse_public(public).expect("valid public key text");
    rustls::sign::public_key_to_spki(&rustls::pki_types::alg_id::ED25519, raw)
        .as_ref()
        .to_vec()
}

// ---------------------------------------------------------------------------------------------
// The key command

#[test]
fn key_generate_creates_one_owner_only_key_and_show_reports_the_same_public_key() {
    let dir = Dir::new();
    let key = dir.path("gateway.key");
    let output = dir.run("generate", &json!({"version":1,"privateKey":key}));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let generated: Value = serde_json::from_slice(&output.stdout).expect("one JSON line");
    let public = generated["publicKey"].as_str().expect("public key text");
    assert_eq!(
        generated,
        json!({"version":1,"operation":"generate","publicKey":public}),
        "only the public key is printed"
    );
    assert!(pi_gateway::keys::parse_public(public).is_some());
    let metadata = fs::metadata(&key).expect("key file");
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600, "owner-only");
    let bytes = fs::read(&key).expect("key bytes");
    assert!(
        ring::signature::Ed25519KeyPair::from_pkcs8(&bytes).is_ok(),
        "PKCS#8 v2 Ed25519 document"
    );

    let shown = dir.run("show", &json!({"version":1,"privateKey":key}));
    assert!(shown.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&shown.stdout).expect("show JSON"),
        json!({"version":1,"operation":"show","publicKey":public})
    );

    let again = dir.run("generate", &json!({"version":1,"privateKey":key}));
    assert!(!again.status.success(), "an existing key is never replaced");
    assert!(again.stdout.is_empty(), "a refusal prints no key material");
    assert_eq!(fs::read(&key).expect("key bytes"), bytes, "key unchanged");
}

#[test]
fn key_command_refuses_unsafe_files_directories_and_input() {
    let dir = Dir::new();
    let (key, _) = dir.key("gateway.key");
    let refuse = |operation: &str, input: Value, why: &str| {
        let output = dir.run(operation, &input);
        assert!(!output.status.success(), "{why}");
        assert!(output.stdout.is_empty(), "{why}: no output on failure");
    };
    // A symlink to a valid key is not followed, for show or generate.
    let link = dir.path("link.key");
    std::os::unix::fs::symlink(&key, &link).expect("symlink");
    refuse(
        "show",
        json!({"version":1,"privateKey":link}),
        "symlink show",
    );
    refuse(
        "generate",
        json!({"version":1,"privateKey":link}),
        "symlink generate",
    );
    // A group- or world-readable key is refused.
    fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).expect("chmod");
    refuse("show", json!({"version":1,"privateKey":key}), "0644 key");
    fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).expect("chmod");
    // A file that is not an Ed25519 PKCS#8 key is refused.
    let junk = dir.path("junk.key");
    fs::write(&junk, [7_u8; 83]).expect("junk");
    fs::set_permissions(&junk, fs::Permissions::from_mode(0o600)).expect("chmod");
    refuse("show", json!({"version":1,"privateKey":junk}), "not a key");
    refuse(
        "show",
        json!({"version":1,"privateKey":dir.path("missing.key")}),
        "missing key",
    );
    // Generation needs an owner-only directory.
    let open = dir.path("open");
    fs::create_dir(&open).expect("open directory");
    fs::set_permissions(&open, fs::Permissions::from_mode(0o755)).expect("chmod");
    refuse(
        "generate",
        json!({"version":1,"privateKey":open.join("gateway.key")}),
        "group-readable directory",
    );
    assert!(!open.join("gateway.key").exists(), "nothing created");
    // Strict input.
    refuse(
        "show",
        json!({"version":1,"privateKey":"relative.key"}),
        "relative path",
    );
    refuse("show", json!({"version":2,"privateKey":key}), "version");
    refuse(
        "show",
        json!({"version":1,"privateKey":key,"extra":true}),
        "unknown field",
    );
    refuse("show", json!({"version":1}), "missing path");
    refuse(
        "rotate",
        json!({"version":1,"privateKey":key}),
        "unknown operation",
    );
    let output = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .args(["key", "show", "--input", "input.json"])
        .output()
        .expect("run key command");
    assert!(!output.status.success(), "relative input path");
}

#[hegel::test(support::property_settings(200, 25_519))]
fn public_key_text_is_exactly_lowercase_hex_of_32_bytes(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let raw = tc.draw(gs::binary().min_size(32).max_size(32));
    let text = pi_gateway::keys::hex(&raw);
    assert_eq!(
        pi_gateway::keys::parse_public(&text).map(Vec::from),
        Some(raw),
        "hex round-trips"
    );
    let other = tc.draw(gs::text().max_size(70));
    let valid = other.len() == 64
        && other
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    assert_eq!(
        pi_gateway::keys::parse_public(&other).is_some(),
        valid,
        "{other:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// Configuration

fn config(remote: &Value) -> Value {
    json!({"machineId":"alpha","socketPath":"/private/tmp/not-bound","scopeIds":["team"],"policies":[{"machineId":"beta","scopeId":"team","permissions":["discover"]}],"remote":remote})
}
fn parses(value: &Value) -> bool {
    Config::parse(&serde_json::to_vec(value).expect("config JSON")).is_ok()
}

#[test]
fn pinned_config_is_strict_and_never_mixes_with_certificate_fields() {
    let peer = "ab".repeat(32);
    let valid = remote(
        Path::new("/abs/key.der"),
        "beta",
        &peer,
        "connect",
        "127.0.0.1:7000",
    );
    assert!(parses(&config(&valid)), "pinned remote parses");
    for bad in [
        "AB".repeat(32),
        "ab".repeat(31),
        "ab".repeat(33),
        format!("{}g", "a".repeat(63)),
        String::new(),
    ] {
        let mut value = valid.clone();
        value["peerPublicKey"] = json!(bad);
        assert!(!parses(&config(&value)), "bad key text {bad:?}");
    }
    for (field, extra) in [
        ("rootCertificates", json!(["/abs/root.der"])),
        ("certificateChain", json!(["/abs/leaf.der"])),
        ("issuerCertificates", json!(["/abs/issuer.der"])),
        ("crls", json!(["/abs/crl.der"])),
        ("revocationState", json!("/abs/floors.json")),
    ] {
        let mut value = valid.clone();
        value[field] = extra;
        assert!(!parses(&config(&value)), "pinned with CA field {field}");
    }
    let mut value = valid.clone();
    value["privateKey"] = json!("relative.der");
    assert!(!parses(&config(&value)), "relative key path");
    let mut value = valid.clone();
    value.as_object_mut().expect("object").remove("privateKey");
    assert!(!parses(&config(&value)), "missing key path");
    let mut value = valid.clone();
    value["peerPublicKey"] = json!(null);
    assert!(!parses(&config(&value)), "null pin");
    let mut value = valid.clone();
    value["machineId"] = json!("alpha");
    assert!(!parses(&config(&value)), "peer named as ourselves");
    let mut value = valid.clone();
    value
        .as_object_mut()
        .expect("object")
        .remove("peerPublicKey");
    assert!(
        !parses(&config(&value)),
        "without a pin, the certificate fields are all required"
    );
    let mut value = valid;
    value["endpoint"] = json!({"mode":"connect","address":"127.0.0.1:0"});
    assert!(!parses(&config(&value)), "connector port 0");
}

#[test]
fn pinning_our_own_key_or_an_unusable_key_never_prepares() {
    let dir = Dir::new();
    let (key, public) = dir.key("alpha.key");
    assert!(
        settings(&key, "beta", &public, "connect", "127.0.0.1:7000")
            .prepare("alpha")
            .is_err(),
        "a gateway that pins its own key would accept a reflected connection"
    );
    let (_, beta) = dir.key("beta.key");
    fs::set_permissions(&key, fs::Permissions::from_mode(0o640)).expect("chmod");
    assert!(
        settings(&key, "beta", &beta, "connect", "127.0.0.1:7000")
            .prepare("alpha")
            .is_err(),
        "group-readable key"
    );
    assert!(
        settings(
            &dir.path("missing.key"),
            "beta",
            &beta,
            "connect",
            "127.0.0.1:7000"
        )
        .prepare("alpha")
        .is_err(),
        "missing key"
    );
}

// ---------------------------------------------------------------------------------------------
// Live loopback handshakes

struct Keys {
    _dir: Dir,
    alpha: (PathBuf, String),
    beta: (PathBuf, String),
    gamma: (PathBuf, String),
}
fn keys() -> Keys {
    let dir = Dir::new();
    Keys {
        alpha: dir.key("alpha.key"),
        beta: dir.key("beta.key"),
        gamma: dir.key("gamma.key"),
        _dir: dir,
    }
}

/// One loopback attempt: the connector holds `client_key` and pins `client_pin`, the listener
/// holds `server_key` and pins `server_pin`. Returns both sides' outcomes.
async fn attempt(
    client_key: &Path,
    client_pin: &str,
    server_key: &Path,
    server_pin: &str,
) -> (
    std::io::Result<pi_gateway::remote::Authenticated>,
    std::io::Result<pi_gateway::remote::Authenticated>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback listener");
    let address = listener.local_addr().expect("bound address").to_string();
    let client = settings(client_key, "beta", client_pin, "connect", &address)
        .prepare("alpha")
        .expect("connector prepares");
    let server = settings(server_key, "alpha", server_pin, "listen", &address)
        .prepare("beta")
        .expect("listener prepares");
    tokio::join!(client.connect(), async {
        server
            .accept(listener.accept().await.expect("accepted TCP").0)
            .await
    })
}

/// Whether a side that believes it authenticated can actually use the stream.
async fn usable(side: std::io::Result<pi_gateway::remote::Authenticated>) -> bool {
    let Ok(authenticated) = side else {
        return false;
    };
    let (mut stream, _lease) = authenticated.into_parts();
    let mut byte = [0];
    matches!(
        tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte)).await,
        Ok(Ok(1))
    )
}

#[tokio::test]
async fn matching_pins_link_with_raw_keys_over_tls13_and_exchange_bytes() {
    let keys = keys();
    let (client, server) = attempt(&keys.alpha.0, &keys.beta.1, &keys.beta.0, &keys.alpha.1).await;
    let (mut client, _) = client.expect("connector authenticated").into_parts();
    let (mut server, _) = server.expect("listener authenticated").into_parts();
    for (stream, presented) in [(&client, &keys.beta.1), (&server, &keys.alpha.1)] {
        let state = stream.get_ref().1;
        assert_eq!(
            state.protocol_version(),
            Some(rustls::ProtocolVersion::TLSv1_3)
        );
        assert_eq!(state.handshake_kind(), Some(rustls::HandshakeKind::Full));
        let certificates = state.peer_certificates().expect("peer identity");
        assert_eq!(certificates.len(), 1, "one raw public key, no chain");
        assert_eq!(
            certificates[0].as_ref(),
            spki(presented).as_slice(),
            "the peer presented exactly the pinned key"
        );
    }
    client.write_all(b"ping").await.expect("client write");
    client.flush().await.expect("client flush");
    let mut bytes = [0; 4];
    server.read_exact(&mut bytes).await.expect("server read");
    assert_eq!(&bytes, b"ping");
    server.write_all(b"pong").await.expect("server write");
    server.flush().await.expect("server flush");
    client.read_exact(&mut bytes).await.expect("client read");
    assert_eq!(&bytes, b"pong");
}

#[tokio::test]
async fn a_wrong_pin_on_either_side_refuses_the_link_for_both() {
    let keys = keys();
    // The connector pins gamma, but beta answers.
    let (client, server) = attempt(&keys.alpha.0, &keys.gamma.1, &keys.beta.0, &keys.alpha.1).await;
    assert!(client.is_err(), "connector refuses an unpinned server key");
    assert!(server.is_err(), "listener sees the refusal");
    // The listener pins gamma, but alpha connects.
    let (client, server) = attempt(&keys.alpha.0, &keys.beta.1, &keys.beta.0, &keys.gamma.1).await;
    assert!(server.is_err(), "listener refuses an unpinned client key");
    assert!(
        !usable(client).await,
        "the connector never gets a usable link"
    );
    // Gamma holds no pinned key at all on either side.
    let (client, server) = attempt(&keys.gamma.0, &keys.beta.1, &keys.beta.0, &keys.alpha.1).await;
    assert!(server.is_err(), "an unknown key cannot connect");
    assert!(!usable(client).await);
}

#[tokio::test]
async fn a_connection_reflected_to_ourselves_is_refused() {
    let keys = keys();
    // Alpha's outbound connection lands on a listener holding alpha's own key.
    let (client, server) = attempt(&keys.alpha.0, &keys.beta.1, &keys.alpha.0, &keys.beta.1).await;
    assert!(client.is_err(), "our own key is not the peer's");
    assert!(server.is_err());
}

#[tokio::test]
async fn a_certificate_presenting_peer_cannot_link_to_a_pinned_listener() {
    let keys = keys();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback listener");
    let address = listener.local_addr().expect("bound address").to_string();
    let server = settings(&keys.beta.0, "alpha", &keys.alpha.1, "listen", &address)
        .prepare("beta")
        .expect("listener prepares");
    // An ordinary X.509 TLS 1.3 client that would accept anything still cannot link.
    let mut client = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .expect("TLS 1.3")
    .dangerous()
    .with_custom_certificate_verifier(Arc::new(AcceptAnything))
    .with_no_client_auth();
    client.resumption = rustls::client::Resumption::disabled();
    let (client, server) = tokio::join!(
        async {
            let stream = tokio::net::TcpStream::connect(&address)
                .await
                .expect("TCP connect");
            tokio_rustls::TlsConnector::from(Arc::new(client))
                .connect(
                    rustls::pki_types::ServerName::try_from("gateway.beta.pi.internal")
                        .expect("name"),
                    stream,
                )
                .await
        },
        async {
            server
                .accept(listener.accept().await.expect("accepted TCP").0)
                .await
        }
    );
    assert!(server.is_err(), "no raw-key negotiation, no link");
    assert!(client.is_err(), "the listener refuses X.509 negotiation");
}

#[tokio::test]
async fn a_pinned_connector_cannot_link_to_a_certificate_presenting_server() {
    let keys = keys();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback listener");
    let address = listener.local_addr().expect("bound address").to_string();
    let client = settings(&keys.alpha.0, "beta", &keys.beta.1, "connect", &address)
        .prepare("alpha")
        .expect("connector prepares");
    // An ordinary X.509 TLS 1.3 server whose certificate carries a fresh key.
    let key = rcgen::KeyPair::generate().expect("server key");
    let certificate = rcgen::CertificateParams::new(vec!["gateway.beta.pi.internal".to_owned()])
        .expect("server name")
        .self_signed(&key)
        .expect("self-signed certificate");
    let server = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .expect("TLS 1.3")
    .with_no_client_auth()
    .with_single_cert(
        vec![certificate.der().clone()],
        rustls::pki_types::PrivateKeyDer::try_from(key.serialize_der()).expect("server key DER"),
    )
    .expect("X.509 server");
    let (client, server) = tokio::join!(client.connect(), async {
        let stream = listener.accept().await.expect("accepted TCP").0;
        tokio_rustls::TlsAcceptor::from(Arc::new(server))
            .accept(stream)
            .await
    });
    assert!(client.is_err(), "a certificate is never a pinned raw key");
    assert!(server.is_err(), "the server cannot negotiate raw keys");
}

use std::sync::Arc;

#[derive(Debug)]
struct AcceptAnything;
impl rustls::client::danger::ServerCertVerifier for AcceptAnything {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn verify_tls13_signature(
        &self,
        _: &[u8],
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// ---------------------------------------------------------------------------------------------
// Two real gateways

struct Gateway {
    child: Child,
    ready: Value,
}
impl Gateway {
    fn start(dir: &Dir, name: &str, remote: &Value) -> Self {
        let peer = remote["machineId"].clone();
        let config = json!({"machineId":name,"socketPath":dir.path(&format!("{name}.sock")),"scopeIds":["team"],"policies":[{"machineId":name,"scopeId":"team","permissions":["discover"]},{"machineId":peer,"scopeId":"team","permissions":["discover"]},{"machineId":peer,"scopeId":"team","permissions":["discover"],"direction":"incoming"}],"remote":remote});
        let path = dir.path(&format!("{name}-config.json"));
        fs::write(&path, serde_json::to_vec(&config).expect("config JSON")).expect("config");
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .arg("--config")
            .arg(path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn gateway");
        let stdout = child.stdout.take().expect("ready pipe");
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = send.send(line);
        });
        let line = receive
            .recv_timeout(Duration::from_secs(5))
            .expect("bounded startup");
        let ready = serde_json::from_str(&line).expect("ready JSON");
        Self { child, ready }
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
        .write_all(&u32::try_from(body.len()).expect("small").to_be_bytes())
        .expect("length");
    stream.write_all(&body).expect("body");
    loop {
        let mut length = [0; 4];
        stream.read_exact(&mut length).expect("response length");
        let mut body = vec![0; usize::try_from(u32::from_be_bytes(length)).expect("length")];
        stream.read_exact(&mut body).expect("response body");
        let frame: Value = serde_json::from_slice(&body).expect("response JSON");
        if frame["op"] != "link.state" {
            return frame;
        }
    }
}
fn register(dir: &Dir, name: &str) -> UnixStream {
    let mut stream = UnixStream::connect(dir.path(&format!("{name}.sock"))).expect("socket");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read deadline");
    let response = request(
        &mut stream,
        &json!({"v":2,"op":"register","rid":"00000000000000000000000000000001","sessionId":name,"runtimeNonce":"00000000000000000000000000000002","scopeIds":["team"],"label":"Pi"}),
    );
    assert_eq!(response["outcome"]["tag"], "ok", "local registration");
    stream
}
fn diagnose(dir: &Dir, name: &str) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
        .arg("--diagnose")
        .arg(dir.path(&format!("{name}-config.json")))
        .output()
        .expect("diagnose");
    assert!(
        output.status.success(),
        "diagnose is read-only and succeeds"
    );
    serde_json::from_slice(&output.stdout).expect("diagnostic JSON")
}

#[test]
fn two_real_gateways_link_with_pinned_keys_and_diagnose_reports_the_own_key() {
    let dir = Dir::new();
    let (alpha_key, alpha_public) = dir.key("alpha.key");
    let (beta_key, beta_public) = dir.key("beta.key");
    let beta = Gateway::start(
        &dir,
        "beta",
        &remote(&beta_key, "alpha", &alpha_public, "listen", "127.0.0.1:0"),
    );
    let address = beta.ready["remoteListenAddress"]
        .as_str()
        .expect("listener reports its port");
    let _alpha = Gateway::start(
        &dir,
        "alpha",
        &remote(&alpha_key, "beta", &beta_public, "connect", address),
    );
    let mut a = register(&dir, "alpha");
    let _b = register(&dir, "beta");
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let response = request(
            &mut a,
            &json!({"v":2,"op":"discover","rid":"00000000000000000000000000000003","scopeIds":["team"],"watch":false}),
        );
        if response.to_string().contains("\"machineId\":\"beta\"") {
            break;
        }
        assert!(Instant::now() < until, "remote roster arrives: {response}");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        diagnose(&dir, "alpha"),
        json!({"version":1,"machineId":"alpha","remote":{"state":"configured","trust":"pinned","publicKey":alpha_public}})
    );
}

#[test]
fn an_unusable_or_self_pinned_key_degrades_remote_but_local_still_serves() {
    let dir = Dir::new();
    let (key, public) = dir.key("alpha.key");
    let (_, beta_public) = dir.key("beta.key");
    for (case, pin, mode, reason) in [
        ("self", public.as_str(), 0o600, "identity"),
        ("open", beta_public.as_str(), 0o644, "private-key"),
    ] {
        fs::set_permissions(&key, fs::Permissions::from_mode(mode)).expect("chmod");
        let gateway = Gateway::start(
            &dir,
            "alpha",
            &remote(&key, "beta", pin, "listen", "127.0.0.1:0"),
        );
        assert!(
            gateway.ready.get("remoteListenAddress").is_none(),
            "{case}: remote stays closed"
        );
        let _local = register(&dir, "alpha");
        assert_eq!(
            diagnose(&dir, "alpha")["remote"],
            json!({"state":"degraded","reason":reason}),
            "{case}"
        );
        drop(gateway);
        let _ = fs::remove_file(dir.path("alpha.sock"));
    }
}
