//! Generated private PKI and memory-stream TLS; no normal credentials or remote services.
use pi_session_gateway::tls::{Policy, Trust};
use rcgen::{
    BasicConstraints, Certificate, CertificateParams, CertificateRevocationListParams, DnType,
    ExtendedKeyUsagePurpose, IsCa, Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose,
    RevokedCertParams,
};
use rustls::pki_types::ServerName;
use std::sync::Arc;
use time::{Duration, OffsetDateTime};
use tokio_rustls::{TlsAcceptor, TlsConnector};

struct Authority {
    params: CertificateParams,
    key: KeyPair,
    cert: Certificate,
}
impl Authority {
    fn new(name: &str) -> Self {
        let mut params = CertificateParams::new(Vec::<String>::new()).expect("empty SAN list");
        params.distinguished_name.push(DnType::CommonName, name);
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
        params.not_after = OffsetDateTime::now_utc() + Duration::days(30);
        let key = KeyPair::generate().expect("temporary CA key");
        let cert = params.self_signed(&key).expect("temporary self-signed CA");
        Self { params, key, cert }
    }
    fn issuer(&self) -> Issuer<'_, &KeyPair> {
        Issuer::from_params(&self.params, &self.key)
    }
    fn leaf(&self, machine: &str) -> (Vec<Vec<u8>>, Vec<u8>) {
        let mut params = CertificateParams::new(vec![format!("gateway.{machine}.pi.internal")])
            .expect("fixed SAN");
        params.not_before = OffsetDateTime::now_utc() - Duration::hours(1);
        params.not_after = OffsetDateTime::now_utc() + Duration::days(1);
        params.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ClientAuth,
            ExtendedKeyUsagePurpose::ServerAuth,
        ];
        params.serial_number = Some(42_u64.into());
        self.sign_leaf(&params)
    }
    fn sign_leaf(&self, params: &CertificateParams) -> (Vec<Vec<u8>>, Vec<u8>) {
        let key = KeyPair::generate().expect("temporary leaf key");
        let certificate = params
            .signed_by(&key, &self.issuer())
            .expect("temporary signed leaf");
        (vec![certificate.der().to_vec()], key.serialize_der())
    }
    fn crl(
        &self,
        number: u64,
        this: OffsetDateTime,
        next: OffsetDateTime,
        revoked: Vec<RevokedCertParams>,
    ) -> Vec<u8> {
        CertificateRevocationListParams {
            this_update: this,
            next_update: next,
            crl_number: number.into(),
            issuing_distribution_point: None,
            revoked_certs: revoked,
            key_identifier_method: KeyIdMethod::Sha256,
        }
        .signed_by(&self.issuer())
        .expect("temporary signed complete CRL")
        .der()
        .to_vec()
    }
    fn current_crl(&self) -> Vec<u8> {
        self.crl(
            1,
            OffsetDateTime::now_utc() - Duration::hours(1),
            OffsetDateTime::now_utc() + Duration::hours(12),
            vec![],
        )
    }
    fn trust(&self, crl: Vec<u8>) -> Trust {
        Trust::from_der(vec![self.cert.der().to_vec()], vec![crl]).expect("complete private trust")
    }
}
fn now() -> u64 {
    u64::try_from(OffsetDateTime::now_utc().unix_timestamp()).expect("current positive Unix time")
}

async fn handshake(client: rustls::ClientConfig, server: rustls::ServerConfig) -> bool {
    let (outbound, inbound) = tokio::io::duplex(65536);
    let client = TlsConnector::from(Arc::new(client));
    let server = TlsAcceptor::from(Arc::new(server));
    let name = ServerName::try_from("gateway.beta.pi.internal").expect("configured server name");
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(client.connect(name, outbound), server.accept(inbound))
    })
    .await
    .expect("bounded memory-stream handshake");
    if let (Ok(client), Ok(server)) = result {
        assert_eq!(
            client.get_ref().1.protocol_version(),
            Some(rustls::ProtocolVersion::TLSv1_3),
            "TLS1.3 only"
        );
        assert_eq!(
            server.get_ref().1.handshake_kind(),
            Some(rustls::HandshakeKind::Full),
            "no server resumption"
        );
        assert_eq!(
            client.get_ref().1.handshake_kind(),
            Some(rustls::HandshakeKind::Full),
            "no client resumption"
        );
        true
    } else {
        false
    }
}
#[tokio::test]
async fn private_ca_mutual_exact_sans_tls13_and_no_resumption() {
    let ca = Authority::new("test CA");
    let trust = ca.trust(ca.current_crl());
    let (chain, key) = ca.leaf("alpha");
    let client = Policy::new(trust.clone(), "beta")
        .unwrap()
        .client_config(chain, key)
        .unwrap();
    let (chain, key) = ca.leaf("beta");
    let server = Policy::new(trust, "alpha")
        .unwrap()
        .server_config(chain, key)
        .unwrap();
    assert!(!client.enable_early_data);
    assert_eq!(server.max_early_data_size, 0);
    assert_eq!(server.send_tls13_tickets, 0);
    assert!(handshake(client.clone(), server.clone()).await);
    assert!(handshake(client, server).await);
}
#[tokio::test]
async fn trusted_wrong_client_and_server_identity_are_rejected() {
    let ca = Authority::new("test CA");
    for (client_machine, server_machine) in [("imposter", "beta"), ("alpha", "imposter")] {
        let trust = ca.trust(ca.current_crl());
        let (chain, key) = ca.leaf(client_machine);
        let client = Policy::new(trust.clone(), "beta")
            .unwrap()
            .client_config(chain, key)
            .unwrap();
        let (chain, key) = ca.leaf(server_machine);
        let server = Policy::new(trust, "alpha")
            .unwrap()
            .server_config(chain, key)
            .unwrap();
        assert!(!handshake(client, server).await);
    }
}
#[test]
fn future_stale_missing_issuer_bad_signature_and_revoked_crls_fail_closed() {
    let ca = Authority::new("test CA");
    let other = Authority::new("unrelated CA");
    let time = OffsetDateTime::now_utc();
    let mut bad_signature = ca.current_crl();
    *bad_signature.last_mut().unwrap() ^= 1;
    let revoked = RevokedCertParams {
        serial_number: 42_u64.into(),
        revocation_time: time,
        reason_code: None,
        invalidity_date: None,
    };
    let cases = [
        ca.crl(
            1,
            time + Duration::hours(1),
            time + Duration::hours(2),
            vec![],
        ),
        ca.crl(
            1,
            time - Duration::hours(2),
            time - Duration::hours(1),
            vec![],
        ),
        other.current_crl(),
        bad_signature,
        ca.crl(
            1,
            time - Duration::hours(1),
            time + Duration::hours(1),
            vec![revoked],
        ),
    ];
    let (chain, _) = ca.leaf("beta");
    for crl in cases {
        let policy = Policy::new(ca.trust(crl), "beta").unwrap();
        assert!(policy.credential_expiry(&chain, now()).is_err());
    }
    assert!(Trust::from_der(vec![ca.cert.der().to_vec()], vec![]).is_err());
}
#[test]
fn credential_expiry_bounds_active_lifetime_and_replacement_rejects_rollback() {
    let ca = Authority::new("test CA");
    let time = OffsetDateTime::now_utc();
    let first = ca.crl(
        1,
        time - Duration::hours(2),
        time + Duration::hours(1),
        vec![],
    );
    let second = ca.crl(
        2,
        time - Duration::hours(1),
        time + Duration::hours(2),
        vec![],
    );
    let prior = ca.trust(first);
    let current = ca.trust(second);
    assert!(prior.check_replacement(&current).is_ok());
    assert!(current.check_replacement(&prior).is_err());
    let (chain, _) = ca.leaf("beta");
    let policy = Policy::new(current, "beta").unwrap();
    let expiry = policy.credential_expiry(&chain, now()).unwrap();
    assert_eq!(
        expiry,
        u64::try_from((time + Duration::hours(2)).unix_timestamp()).unwrap()
    );
    assert!(policy.credential_expiry(&chain, expiry).is_err());
}

#[tokio::test]
async fn wrong_role_eku_is_not_bypassed_by_supplemental_identity_checks() {
    let ca = Authority::new("test CA");
    for machine in ["alpha", "beta"] {
        let mut params =
            CertificateParams::new(vec![format!("gateway.{machine}.pi.internal")]).unwrap();
        params.extended_key_usages = vec![if machine == "alpha" {
            ExtendedKeyUsagePurpose::ServerAuth
        } else {
            ExtendedKeyUsagePurpose::ClientAuth
        }];
        let (client_chain, client_key) = if machine == "alpha" {
            ca.sign_leaf(&params)
        } else {
            ca.leaf("alpha")
        };
        let (server_chain, server_key) = if machine == "beta" {
            ca.sign_leaf(&params)
        } else {
            ca.leaf("beta")
        };
        let trust = ca.trust(ca.current_crl());
        let client = Policy::new(trust.clone(), "beta")
            .unwrap()
            .client_config(client_chain, client_key)
            .unwrap();
        let server = Policy::new(trust, "alpha")
            .unwrap()
            .server_config(server_chain, server_key)
            .unwrap();
        assert!(!handshake(client, server).await);
    }
}

#[test]
fn exact_single_dns_san_no_wildcards_or_cn_fallback_and_expired_root_rejected() {
    let mut ca = Authority::new("test CA");
    for sans in [
        vec![],
        vec!["*.beta.pi.internal".to_owned()],
        vec![
            "gateway.beta.pi.internal".to_owned(),
            "gateway.alpha.pi.internal".to_owned(),
        ],
    ] {
        let mut params = CertificateParams::new(sans).unwrap();
        params
            .distinguished_name
            .push(DnType::CommonName, "gateway.beta.pi.internal");
        let (chain, _) = ca.sign_leaf(&params);
        let policy = Policy::new(ca.trust(ca.current_crl()), "beta").unwrap();
        assert!(policy.credential_expiry(&chain, now()).is_err());
    }
    ca.params.not_after = OffsetDateTime::now_utc() - Duration::hours(1);
    ca.cert = ca.params.self_signed(&ca.key).unwrap();
    let (chain, _) = ca.leaf("beta");
    let policy = Policy::new(ca.trust(ca.current_crl()), "beta").unwrap();
    assert!(
        policy.credential_expiry(&chain, now()).is_err(),
        "configured trust-anchor expiry must be enforced separately"
    );
}

#[test]
fn every_non_anchor_including_intermediate_requires_current_issuer_crl() {
    let root = Authority::new("root CA");
    let mut intermediate = Authority::new("intermediate CA");
    intermediate.cert = intermediate
        .params
        .signed_by(&intermediate.key, &root.issuer())
        .unwrap();
    let (mut chain, _) = intermediate.leaf("beta");
    chain.push(intermediate.cert.der().to_vec());
    let root_crl = root.current_crl();
    let intermediate_crl = intermediate.current_crl();
    let trust = Trust::from_der(
        vec![root.cert.der().to_vec()],
        vec![root_crl.clone(), intermediate_crl.clone()],
    )
    .unwrap();
    assert!(
        Policy::new(trust, "beta")
            .unwrap()
            .credential_expiry(&chain, now())
            .is_ok()
    );
    for missing in [vec![root_crl], vec![intermediate_crl]] {
        let trust = Trust::from_der(vec![root.cert.der().to_vec()], missing).unwrap();
        assert!(
            Policy::new(trust, "beta")
                .unwrap()
                .credential_expiry(&chain, now())
                .is_err()
        );
    }
}

fn der_parts(bytes: &[u8]) -> Vec<&[u8]> {
    fn element_length(bytes: &[u8]) -> usize {
        let first = usize::from(bytes[1]);
        if first < 128 {
            return first + 2;
        }
        let octets = first - 128;
        let length = bytes[2..2 + octets]
            .iter()
            .fold(0_usize, |length, byte| length * 256 + usize::from(*byte));
        length + 2 + octets
    }
    let header = if bytes[1] < 128 {
        2
    } else {
        2 + usize::from(bytes[1] - 128)
    };
    let mut remaining = &bytes[header..];
    let mut parts = Vec::new();
    while !remaining.is_empty() {
        let length = element_length(remaining);
        parts.push(&remaining[..length]);
        remaining = &remaining[length..];
    }
    parts
}
#[test]
fn correctly_signed_crl_without_next_update_is_rejected() {
    use rcgen::SigningKey;
    use x509_parser::prelude::FromDer;
    let ca = Authority::new("test CA");
    let original = ca.current_crl();
    let outer = der_parts(&original);
    let tbs = der_parts(outer[0]);
    assert_eq!(tbs[4][0], 0x17, "rcgen fixture nextUpdate must be UTCTime");
    let unsigned = yasna::construct_der(|writer| {
        writer.write_sequence(|writer| {
            for (index, part) in tbs.iter().enumerate() {
                if index != 4 {
                    writer.next().write_der(part);
                }
            }
        });
    });
    let signature = ca.key.sign(&unsigned).unwrap();
    let missing_next_update = yasna::construct_der(|writer| {
        writer.write_sequence(|writer| {
            writer.next().write_der(&unsigned);
            writer.next().write_der(outer[1]);
            writer
                .next()
                .write_bitvec_bytes(&signature, signature.len() * 8);
        });
    });
    // Verify the negative fixture is valid DER with a genuine issuer signature;
    // failure must not be attributed to a broken signature or malformed bytes.
    let (_, crl) =
        x509_parser::revocation_list::CertificateRevocationList::from_der(&missing_next_update)
            .unwrap();
    let (_, issuer) = x509_parser::prelude::X509Certificate::from_der(ca.cert.der()).unwrap();
    assert!(crl.verify_signature(issuer.public_key()).is_ok());
    assert!(crl.next_update().is_none());
    assert!(Trust::from_der(vec![ca.cert.der().to_vec()], vec![missing_next_update]).is_err());
}

#[test]
fn partitioned_distribution_point_crl_is_explicitly_unsupported_not_assumed_complete() {
    let ca = Authority::new("test CA");
    let time = OffsetDateTime::now_utc();
    let crl = CertificateRevocationListParams {
        this_update: time - Duration::hours(1),
        next_update: time + Duration::hours(1),
        crl_number: 1_u64.into(),
        issuing_distribution_point: Some(rcgen::CrlIssuingDistributionPoint {
            distribution_point: rcgen::CrlDistributionPoint {
                uris: vec!["https://invalid.example/partition.crl".to_owned()],
            },
            scope: Some(rcgen::CrlScope::UserCertsOnly),
        }),
        revoked_certs: vec![],
        key_identifier_method: KeyIdMethod::Sha256,
    }
    .signed_by(&ca.issuer())
    .unwrap();
    assert!(Trust::from_der(vec![ca.cert.der().to_vec()], vec![crl.der().to_vec()]).is_err());
}

#[tokio::test]
async fn missing_client_certificate_is_rejected() {
    let ca = Authority::new("test CA");
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca.cert.der().clone()).unwrap();
    let client = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let (chain, key) = ca.leaf("beta");
    let server = Policy::new(ca.trust(ca.current_crl()), "alpha")
        .unwrap()
        .server_config(chain, key)
        .unwrap();
    assert!(!handshake(client, server).await);
}

#[derive(Clone, Copy)]
enum AttackedVerifier {
    ClientCertificate,
    ServerCertificate,
}
async fn crossed_expired_anchor_handshake(role: AttackedVerifier) -> bool {
    let mut expired_a = Authority::new("expired configured A");
    expired_a.params.not_after = OffsetDateTime::now_utc() - Duration::hours(1);
    expired_a.cert = expired_a
        .params
        .self_signed(&expired_a.key)
        .expect("expired anchor fixture");
    let valid_b = Authority::new("valid configured B");
    let mut cross = expired_a.params.clone();
    cross.not_after = valid_b.params.not_after;
    cross.name_constraints = Some(rcgen::NameConstraints {
        permitted_subtrees: vec![rcgen::GeneralSubtree::DnsName(
            "excluded.invalid".to_owned(),
        )],
        excluded_subtrees: vec![],
    });
    let cross_a = cross
        .signed_by(&expired_a.key, &valid_b.issuer())
        .expect("B cross-signs A with incompatible name constraints");
    let both = Trust::from_der(
        vec![expired_a.cert.der().to_vec(), valid_b.cert.der().to_vec()],
        vec![expired_a.current_crl(), valid_b.current_crl()],
    )
    .expect("both configured roots");
    let only_b = valid_b.trust(valid_b.current_crl());
    let (client_policy, server_policy, client_chain, client_key, server_chain, server_key) =
        match role {
            AttackedVerifier::ClientCertificate => {
                let (mut chain, key) = expired_a.leaf("alpha");
                chain.push(cross_a.der().to_vec());
                let (other_chain, other_key) = valid_b.leaf("beta");
                (
                    Policy::new(only_b, "beta"),
                    Policy::new(both, "alpha"),
                    chain,
                    key,
                    other_chain,
                    other_key,
                )
            }
            AttackedVerifier::ServerCertificate => {
                let (mut chain, key) = expired_a.leaf("beta");
                chain.push(cross_a.der().to_vec());
                let (other_chain, other_key) = valid_b.leaf("alpha");
                (
                    Policy::new(both, "beta"),
                    Policy::new(only_b, "alpha"),
                    other_chain,
                    other_key,
                    chain,
                    key,
                )
            }
        };
    let client = client_policy
        .expect("configured client policy")
        .client_config(client_chain, client_key)
        .expect("client fixture config");
    let server = server_policy
        .expect("configured server policy")
        .server_config(server_chain, server_key)
        .expect("server fixture config");
    handshake(client, server).await
}
#[tokio::test]
async fn cross_signed_alternate_path_cannot_hide_expired_client_trust_anchor() {
    assert!(!crossed_expired_anchor_handshake(AttackedVerifier::ClientCertificate).await);
}
#[tokio::test]
async fn cross_signed_alternate_path_cannot_hide_expired_server_trust_anchor() {
    assert!(!crossed_expired_anchor_handshake(AttackedVerifier::ServerCertificate).await);
}

#[test]
fn unused_configured_roots_still_bound_local_and_peer_credential_expiry() {
    let selected = Authority::new("selected CA");
    let mut unused = Authority::new("unused CA");
    let time = OffsetDateTime::now_utc();
    unused.params.not_after = time + Duration::minutes(30);
    unused.cert = unused.params.self_signed(&unused.key).unwrap();
    let (chain, _) = selected.leaf("beta");
    let roots = || vec![selected.cert.der().to_vec(), unused.cert.der().to_vec()];
    let trust =
        Trust::from_der(roots(), vec![selected.current_crl(), unused.current_crl()]).unwrap();
    let policy = Policy::new(trust, "beta").unwrap();
    let expiry = u64::try_from(unused.params.not_after.unix_timestamp()).unwrap();
    assert_eq!(
        policy.credential_expiry(&chain, now()).unwrap(),
        expiry,
        "unused configured root must bound every link and own-credential check"
    );
    assert!(policy.credential_expiry(&chain, expiry).is_err());
    unused.params.not_before = time + Duration::minutes(1);
    unused.cert = unused.params.self_signed(&unused.key).unwrap();
    let trust = Trust::from_der(
        vec![selected.cert.der().to_vec(), unused.cert.der().to_vec()],
        vec![selected.current_crl(), unused.current_crl()],
    )
    .unwrap();
    assert!(
        Policy::new(trust, "beta")
            .unwrap()
            .credential_expiry(&chain, now())
            .is_err(),
        "not-yet-valid unused configured root must also fail closed"
    );
}

#[test]
fn durable_revocation_floors_reject_restart_rollback_and_keep_retired_issuers() {
    use pi_session_gateway::revocation::FloorStore;
    use std::os::unix::fs::PermissionsExt;
    let directory = std::path::PathBuf::from("/tmp")
        .canonicalize()
        .unwrap()
        .join(format!("gw-floor-{}-{}", std::process::id(), now()));
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("floors.json");
    assert!(
        FloorStore::open(&path).is_err(),
        "missing floors must not silently bootstrap"
    );
    let ca = Authority::new("original issuer");
    let other = Authority::new("replacement issuer");
    let time = OffsetDateTime::now_utc();
    let old = ca.trust(ca.crl(
        1,
        time - Duration::hours(2),
        time + Duration::hours(1),
        vec![],
    ));
    let current = ca.trust(ca.crl(
        2,
        time - Duration::hours(1),
        time + Duration::hours(2),
        vec![],
    ));
    let mut store = FloorStore::initialize(&path).unwrap();
    assert!(
        FloorStore::open(&path).is_err(),
        "only one installer/gateway may own persistent floors"
    );
    store.apply(&current).unwrap();
    drop(store);
    let mut restarted = FloorStore::open(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(restarted.apply(&old).is_err());
    assert!(
        before == std::fs::read(&path).unwrap(),
        "rollback refusal must leave durable state unchanged"
    );
    restarted.apply(&other.trust(other.current_crl())).unwrap();
    drop(restarted);
    let mut restarted = FloorStore::open(&path).unwrap();
    assert!(
        restarted.apply(&old).is_err(),
        "retiring an active issuer must not erase its floor"
    );
    drop(restarted);
    assert!(
        FloorStore::initialize(&path).is_err(),
        "explicit initialize still must not reset existing state"
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        FloorStore::open(&path).is_err(),
        "publicly accessible floor file must be rejected"
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let moved = directory.join("original.json");
    std::fs::rename(&path, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &path).unwrap();
    assert!(
        FloorStore::open(&path).is_err(),
        "floor paths must not follow symlinks"
    );
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test(start_paused = true)]
async fn active_memory_tls_stream_is_dropped_at_verified_expiry_or_applied_withdrawal() {
    use pi_session_gateway::lease::{LinkEnd, LinkLease};
    use tokio::io::AsyncReadExt;
    let ca = Authority::new("lease test CA");
    for reason in [LinkEnd::Expired, LinkEnd::Withdrawn] {
        let trust = ca.trust(ca.current_crl());
        let client_policy = Policy::new(trust.clone(), "beta").unwrap();
        let server_policy = Policy::new(trust.clone(), "alpha").unwrap();
        let (client_chain, client_key) = ca.leaf("alpha");
        let (server_chain, server_key) = ca.leaf("beta");
        let peer_expiry = server_policy
            .credential_expiry(&client_chain, now())
            .unwrap();
        let own_expiry = Policy::new(trust, "beta")
            .unwrap()
            .credential_expiry(&server_chain, now())
            .unwrap();
        let client = TlsConnector::from(Arc::new(
            client_policy
                .client_config(client_chain, client_key)
                .unwrap(),
        ));
        let server = TlsAcceptor::from(Arc::new(
            server_policy
                .server_config(server_chain, server_key)
                .unwrap(),
        ));
        let (outbound, inbound) = tokio::io::duplex(65536);
        let name = ServerName::try_from("gateway.beta.pi.internal").unwrap();
        let (client, server) = tokio::join!(client.connect(name, outbound), server.accept(inbound));
        let mut client = client.unwrap();
        let mut server = server.unwrap();
        let lease = LinkLease::new(own_expiry, peer_expiry, std::time::SystemTime::now()).unwrap();
        let (withdrawal, notified) = tokio::sync::oneshot::channel::<()>();
        let retained_sender = if reason == LinkEnd::Withdrawn {
            withdrawal.send(()).unwrap();
            None
        } else {
            Some(withdrawal)
        };
        let outcome = lease
            .guard(
                async move {
                    let _ = server.read_u8().await;
                },
                async move {
                    let _ = notified.await;
                },
            )
            .await;
        assert_eq!(outcome, reason);
        assert!(
            client.read_u8().await.is_err(),
            "active TLS peer must observe termination, not an idle live stream"
        );
        drop(retained_sender);
    }
}

struct CredentialDirectory(std::path::PathBuf);
impl CredentialDirectory {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let path = std::path::PathBuf::from("/tmp")
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!(
                "gw-der-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        std::fs::create_dir(&path).expect("isolated credential directory");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("owner-only credential directory");
        Self(path)
    }
    fn settings(
        &self,
        ca: &Authority,
        own: &str,
        peer: &str,
        mode: &str,
        address: std::net::SocketAddr,
    ) -> pi_session_gateway::remote::Settings {
        use std::os::unix::fs::PermissionsExt;
        let (chain, key) = ca.leaf(own);
        for (name, bytes) in [
            ("root.der", ca.cert.der().to_vec()),
            ("leaf.der", chain[0].clone()),
            ("key.der", key),
            ("current.crl", ca.current_crl()),
        ] {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).expect("write only generated temporary credential");
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .expect("private generated credential");
        }
        let state = self.0.join("floors.json");
        drop(
            pi_session_gateway::revocation::FloorStore::initialize(&state)
                .expect("explicit test-only floor bootstrap"),
        );
        let settings = serde_json::json!({"machineId":peer,"endpoint":{"mode":mode,"address":address.to_string()},"rootCertificates":[self.0.join("root.der")],"certificateChain":[self.0.join("leaf.der")],"privateKey":self.0.join("key.der"),"crls":[self.0.join("current.crl")],"revocationState":state});
        pi_session_gateway::remote::Settings::parse(
            &serde_json::to_vec(&settings).expect("settings encoding"),
        )
        .expect("strict temporary remote settings")
    }
}
impl Drop for CredentialDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn explicit_private_der_settings_complete_local_tcp_mtls_and_durable_floor_commit() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let ca = Authority::new("explicit DER test CA");
    let alpha_directory = CredentialDirectory::new();
    let beta_directory = CredentialDirectory::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let alpha_settings = alpha_directory.settings(&ca, "alpha", "beta", "connect", address);
    assert!(
        !format!("{alpha_settings:?}").contains("key.der"),
        "settings diagnostics must redact credential paths"
    );
    let alpha = alpha_settings.prepare("alpha").unwrap();
    let beta = beta_directory
        .settings(&ca, "beta", "alpha", "listen", address)
        .prepare("beta")
        .unwrap();
    let (client, server) = tokio::join!(alpha.connect(), async {
        beta.accept(listener.accept().await.unwrap().0).await
    });
    let (mut client, _client_lease) = client.unwrap().into_parts();
    let (mut server, _server_lease) = server.unwrap().into_parts();
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(beta_directory.0.join("floors.json")).unwrap())
            .unwrap();
    assert_eq!(
        state["issuers"].as_array().unwrap().len(),
        1,
        "revocation floor must be durable before authenticated stream is returned"
    );
    client.write_all(b"authenticated").await.unwrap();
    let mut bytes = [0; 13];
    server.read_exact(&mut bytes).await.unwrap();
    assert_eq!(&bytes, b"authenticated");
}

#[test]
fn explicit_credentials_fail_closed_on_public_key_file_and_missing_floor_state() {
    use std::os::unix::fs::PermissionsExt;
    let ca = Authority::new("explicit DER test CA");
    let directory = CredentialDirectory::new();
    let settings = directory.settings(
        &ca,
        "alpha",
        "beta",
        "connect",
        "127.0.0.1:1".parse().unwrap(),
    );
    std::fs::set_permissions(
        directory.0.join("key.der"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(settings.prepare("alpha").is_err());
    std::fs::set_permissions(
        directory.0.join("key.der"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    std::fs::remove_file(directory.0.join("floors.json")).unwrap();
    let settings = serde_json::json!({"machineId":"beta","endpoint":{"mode":"connect","address":"127.0.0.1:1"},"rootCertificates":[directory.0.join("root.der")],"certificateChain":[directory.0.join("leaf.der")],"privateKey":directory.0.join("key.der"),"crls":[directory.0.join("current.crl")],"revocationState":directory.0.join("floors.json")});
    assert!(
        pi_session_gateway::remote::Settings::parse(&serde_json::to_vec(&settings).unwrap())
            .unwrap()
            .prepare("alpha")
            .is_err(),
        "startup must not implicitly initialize missing revocation state"
    );
}

#[tokio::test]
async fn startup_and_tcp_stream_are_refused_when_restart_configuration_rolls_crl_back() {
    let ca = Authority::new("rollback activation CA");
    let alpha_directory = CredentialDirectory::new();
    let beta_directory = CredentialDirectory::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let alpha_settings = alpha_directory.settings(&ca, "alpha", "beta", "connect", address);
    let beta_settings = beta_directory.settings(&ca, "beta", "alpha", "listen", address);
    let path = beta_directory.0.join("floors.json");
    let time = OffsetDateTime::now_utc();
    let newer = ca.trust(ca.crl(
        2,
        time - Duration::minutes(30),
        time + Duration::hours(12),
        vec![],
    ));
    let mut installed = pi_session_gateway::revocation::FloorStore::open(&path).unwrap();
    installed.apply(&newer).unwrap();
    drop(installed);
    let expected = std::fs::read(&path).unwrap();
    // Both TLS configurations have valid signed current CRL #1, but the receiving
    // gateway's durable authenticated state has already protected newer CRL #2.
    let _alpha = alpha_settings.prepare("alpha").unwrap();
    assert!(
        beta_settings.prepare("beta").is_err(),
        "restart rollback must now fail before any listener or application stream is created"
    );
    assert!(
        expected == std::fs::read(path).unwrap(),
        "rollback activation must not alter persistent state"
    );
}

#[path = "cases/remote_process.rs"]
mod remote_process;

#[test]
fn durable_bundle_validation_checks_unused_issuer_crls_before_installing_their_floors() {
    let ca = Authority::new("own bundle issuer");
    let other = Authority::new("explicit non-trust issuer");
    let trust = Trust::from_der(
        vec![ca.cert.der().to_vec()],
        vec![ca.current_crl(), other.current_crl()],
    )
    .unwrap();
    assert!(
        trust.validate_revocation_bundle(&[], now()).is_err(),
        "unknown unused CRL issuer cannot protect an unverified floor"
    );
    let material = vec![other.cert.der().to_vec()];
    trust.validate_revocation_bundle(&material, now()).unwrap();
    let wrong_key = Authority::new("explicit non-trust issuer");
    let bad = Trust::from_der(
        vec![ca.cert.der().to_vec()],
        vec![ca.current_crl(), wrong_key.current_crl()],
    )
    .unwrap();
    assert!(
        bad.validate_revocation_bundle(&material, now()).is_err(),
        "same-DN wrong key cannot install a CRL floor"
    );
    for (this, next) in [
        (
            OffsetDateTime::now_utc() + Duration::minutes(1),
            OffsetDateTime::now_utc() + Duration::hours(1),
        ),
        (
            OffsetDateTime::now_utc() - Duration::hours(1),
            OffsetDateTime::now_utc() - Duration::minutes(1),
        ),
    ] {
        let stale = Trust::from_der(
            vec![ca.cert.der().to_vec()],
            vec![ca.current_crl(), other.crl(2, this, next, vec![])],
        )
        .unwrap();
        assert!(
            stale.validate_revocation_bundle(&material, now()).is_err(),
            "every configured CRL must be current even before a peer handshake"
        );
    }
}

#[test]
fn durable_floor_rejects_swappable_private_directory_beneath_nonsticky_writable_ancestor() {
    use std::os::unix::fs::PermissionsExt;
    let directory = CredentialDirectory::new();
    let ancestor = directory.0.join("shared");
    let parent = ancestor.join("private");
    std::fs::create_dir(&ancestor).unwrap();
    std::fs::set_permissions(&ancestor, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::create_dir(&parent).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = parent.join("floors.json");
    drop(pi_session_gateway::revocation::FloorStore::initialize(&path).unwrap());
    // A second old victim-owned 0700 tree can be substituted through an unprotected
    // ancestor without a leaf symlink. Never actually involve another UID/root.
    let backup = ancestor.join("backup");
    std::fs::create_dir(&backup).unwrap();
    std::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o700)).unwrap();
    drop(
        pi_session_gateway::revocation::FloorStore::initialize(&backup.join("floors.json"))
            .unwrap(),
    );
    let ca = Authority::new("ancestor regression CA");
    let bundle = ca.trust(ca.current_crl());
    let mut active = pi_session_gateway::revocation::FloorStore::open(&path).unwrap();
    active.apply(&bundle).unwrap();
    std::fs::set_permissions(&ancestor, std::fs::Permissions::from_mode(0o777)).unwrap();
    std::fs::rename(&parent, ancestor.join("displaced")).unwrap();
    std::fs::rename(&backup, &parent).unwrap();
    assert!(
        pi_session_gateway::revocation::FloorStore::open(&path).is_err(),
        "new process cannot follow a swapped old floor/lock through an unprotected ancestor"
    );
    assert!(
        active.apply(&bundle).is_err(),
        "existing locked owner must not persist through a substituted parent"
    );
    assert!(
        pi_session_gateway::revocation::FloorStore::initialize(&parent.join("new.json")).is_err(),
        "bootstrap cannot legitimize unsafe ancestry"
    );
    std::fs::set_permissions(&ancestor, std::fs::Permissions::from_mode(0o1777)).unwrap();
    assert!(
        pi_session_gateway::revocation::FloorStore::open(&path).is_ok(),
        "trusted-owner sticky ancestor protects a victim-owned child just like canonical macOS/Linux temporary roots"
    );
}
