//! Deterministic durable transaction failure injection, with real generated keys.
use super::runtime::{install, install_transaction};
use super::storage::{create_dir, lock, read, read_json, write_new};
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .canonicalize()
            .expect("temp root")
            .join(format!(
                "pi-pf-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir(&path).expect("fixture directory");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("private fixture");
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).expect("owned cleanup");
    }
}
#[test]
fn interrupted_new_floor_install_resumes_exact_owned_bundle_without_reset() {
    let f = Fixture::new();
    let issuer = f.0.join("issuer");
    let beta = f.0.join("beta");
    let creator = create(Create {
        issuer_dir: issuer.clone(),
        runtime_dir: f.0.join("alpha"),
        machine_id: "alpha".into(),
        peer_machine_id: "beta".into(),
    })
    .unwrap();
    let joined = join(&Join {
        runtime_dir: beta.clone(),
        offer_path: issuer.join("offer.json"),
        confirmed_root_sha256: creator["rootSha256"].as_str().unwrap().into(),
    })
    .unwrap();
    issue(
        &Issue {
            issuer_dir: issuer.clone(),
            request_path: beta.join("request.json"),
            confirmed_request_sha256: joined["requestSha256"].as_str().unwrap().into(),
        },
        "issue",
    )
    .unwrap();
    let bundle: Bundle = read_json(&issuer.join("bundle.json")).unwrap();
    let result = install_transaction(&beta, &bundle, FloorMode::New, || {
        Err(io::Error::other(
            "injected interruption after durable floor",
        ))
    });
    assert!(result.is_err(), "fault injected");
    let floor_path = beta.join("revocation-floor.json");
    let floor = read(&floor_path).unwrap();
    assert!(!floor.is_empty(), "floor persisted before interruption");
    let retained = beta.join("retained-floor.json");
    std::fs::rename(&floor_path, &retained).unwrap();
    assert!(
        install(&beta, &bundle, FloorMode::New).is_err(),
        "pending enrollment cannot repair missing existing floor"
    );
    assert!(
        !floor_path.exists(),
        "no reinitialization even with an owned pending marker"
    );
    std::fs::rename(retained, &floor_path).unwrap();
    // A torn known generation file is resumed only under its durable transaction.
    let generation = beta.join("credentials-1");
    create_dir(&generation).unwrap();
    write_new(&generation.join("root.der"), b"interrupted partial bytes").unwrap();
    let output = resume_explicit_cached_bundle(&issuer, &beta, &bundle);
    assert_eq!(
        floor,
        read(&floor_path).unwrap(),
        "resume never reinitializes existing floor"
    );
    assert_eq!(output["machineId"], "beta");
    assert_eq!(
        read(&generation.join("root.der")).unwrap(),
        bundle.offer.root
    );
    assert!(
        install(&beta, &bundle, FloorMode::New).is_err(),
        "new is not reusable after commit"
    );
}
#[test]
fn issuer_mutations_are_exclusively_locked() {
    let f = Fixture::new();
    let issuer = f.0.join("issuer");
    create(Create {
        issuer_dir: issuer.clone(),
        runtime_dir: f.0.join("alpha"),
        machine_id: "alpha".into(),
        peer_machine_id: "beta".into(),
    })
    .unwrap();
    let _guard = lock(&issuer).unwrap();
    assert!(
        export(&IssuerPath {
            issuer_dir: issuer.clone()
        })
        .is_err(),
        "export cannot observe concurrent publication"
    );
    assert!(
        revoke(&Revoke {
            issuer_dir: issuer,
            machine_id: "beta".into()
        })
        .is_err(),
        "no concurrent CRL mutation"
    );
}

#[test]
fn inspection_warns_for_root_expiry_even_when_leaf_and_crl_last_longer() {
    let f = Fixture::new();
    let issuer = f.0.join("issuer");
    let runtime_dir = f.0.join("alpha");
    create(Create {
        issuer_dir: issuer.clone(),
        runtime_dir: runtime_dir.clone(),
        machine_id: "alpha".into(),
        peer_machine_id: "beta".into(),
    })
    .unwrap();
    let key =
        rcgen::KeyPair::try_from(read(&issuer.join("issuer-key.der")).unwrap().as_slice()).unwrap();
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Pi pair alpha beta");
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
    params.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::CrlSign,
    ];
    params.not_before = OffsetDateTime::now_utc() - Duration::days(1);
    params.not_after = OffsetDateTime::now_utc() + Duration::days(2);
    let root = params.self_signed(&key).unwrap();
    let mut runtime: Runtime = read_json(&runtime_dir.join("runtime.json")).unwrap();
    runtime.offer.root = root.der().to_vec();
    runtime.offer.pair_id = sha256(&runtime.offer.root);
    super::storage::atomic(
        &runtime_dir.join("runtime.json"),
        &serde_json::to_vec(&runtime).unwrap(),
    )
    .unwrap();
    let result = inspect(&RuntimePath { runtime_dir }).unwrap();
    assert_eq!(result["expiryWarning"], true, "root is the earliest expiry");
    assert!(
        result["rootExpiresAt"].as_i64().unwrap() < result["crlExpiresAt"].as_i64().unwrap(),
        "root bound exposed"
    );
}

fn resume_explicit_cached_bundle(
    issuer: &std::path::Path,
    beta: &std::path::Path,
    bundle: &Bundle,
) -> Value {
    let floor = read(&beta.join("revocation-floor.json")).unwrap();
    let inspected = inspect(&RuntimePath {
        runtime_dir: beta.to_path_buf(),
    })
    .unwrap();
    let cached = PathBuf::from(inspected["pendingBundlePath"].as_str().unwrap());
    let canonical = serde_json::to_vec(&bundle).unwrap();
    assert_eq!(read(&cached).unwrap(), canonical);
    assert_eq!(
        cached.file_name().unwrap().to_str().unwrap(),
        format!("public-bundle-{}.json", sha256(&canonical))
    );
    // The issuer overwrites its sole public source during renewal. It is not
    // silently substituted, nor is a different requested bundle answered by cache.
    issue(
        &Issue {
            issuer_dir: issuer.to_path_buf(),
            request_path: beta.join("request.json"),
            confirmed_request_sha256: sha256(&read(&beta.join("request.json")).unwrap()),
        },
        "renew",
    )
    .unwrap();
    assert_ne!(canonical, read(&issuer.join("bundle.json")).unwrap());
    assert!(
        import(&Import {
            runtime_dir: beta.to_path_buf(),
            bundle_path: issuer.join("bundle.json"),
            confirmed_root_sha256: sha256(&bundle.offer.root),
            floor_mode: FloorMode::New,
        })
        .is_err(),
        "different requested bundle never uses cache implicitly"
    );
    std::fs::remove_file(issuer.join("bundle.json")).unwrap();
    // Both inspect and resume verify the retained exact-byte hash.
    std::fs::write(&cached, b"corrupt retained bytes").unwrap();
    assert!(
        inspect(&RuntimePath {
            runtime_dir: beta.to_path_buf()
        })
        .is_err()
    );
    assert!(install(beta, bundle, FloorMode::New).is_err());
    assert_eq!(floor, read(&beta.join("revocation-floor.json")).unwrap());
    std::fs::write(&cached, &canonical).unwrap();
    let output = import(&Import {
        runtime_dir: beta.to_path_buf(),
        bundle_path: cached,
        confirmed_root_sha256: sha256(&bundle.offer.root),
        floor_mode: FloorMode::New,
    })
    .unwrap();
    assert!(
        inspect(&RuntimePath {
            runtime_dir: beta.to_path_buf()
        })
        .unwrap()
        .get("pendingBundlePath")
        .is_none()
    );
    output
}
