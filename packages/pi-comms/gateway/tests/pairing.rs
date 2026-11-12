//! Actual CLI exchanges in private disposable directories; no user PKI or services.
#[path = "support/pair_fixture.rs"]
mod fixture;
use fixture::Fixture;
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
fn private_tree(path: &Path) {
    for entry in fs::read_dir(path).expect("owned pairing fixture") {
        let path = entry.expect("owned pairing fixture").path();
        if path.file_name().expect("owned pairing fixture") == "input.json" {
            continue;
        }
        let meta = fs::symlink_metadata(&path).expect("owned pairing fixture");
        assert_eq!(meta.mode() & 0o077, 0, "private {}", path.display());
        assert!(!meta.file_type().is_symlink(), "no private symlinks");
        if meta.is_dir() {
            private_tree(&path);
        }
    }
}
#[test]
fn cli_create_join_issue_import_renew_revoke_custody_and_monotonic_floors() {
    let f = Fixture::new();
    let (creator, alpha, beta) = f.issued();
    assert_eq!(alpha["peerMachineId"], "beta");
    assert_eq!(beta["peerMachineId"], "alpha");
    assert_eq!(creator["credentials"]["machineId"], "alpha");
    let alpha_key = fs::read(alpha["privateKey"].as_str().unwrap()).unwrap();
    let beta_key = fs::read(beta["privateKey"].as_str().unwrap()).unwrap();
    assert_ne!(alpha_key, beta_key, "each host generates its key locally");
    let old_bundle = fs::read(f.path("issuer/bundle.json")).unwrap();
    let before = fs::read(alpha["revocationState"].as_str().unwrap()).unwrap();
    let inspect = f.ok("inspect", &json!({"runtimeDir":f.path("beta")}));
    assert_eq!(inspect["expiryWarning"], false);
    let renewed = f.ok("renew", &json!({"issuerDir":f.path("issuer"),"requestPath":inspect["requestPath"],"confirmedRequestSha256":inspect["requestSha256"]}));
    let alpha2 = f.ok("import", &json!({"runtimeDir":f.path("alpha"),"bundlePath":renewed["bundlePath"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
    assert_ne!(
        alpha["certificateChain"], alpha2["certificateChain"],
        "immutable generations"
    );
    assert_eq!(
        before,
        fs::read(alpha["revocationState"].as_str().unwrap()).unwrap()
    );
    assert_eq!(
        alpha_key,
        fs::read(alpha["privateKey"].as_str().unwrap()).unwrap(),
        "renew retains local key custody"
    );
    fs::write(f.path("old-bundle.json"), old_bundle).unwrap();
    fs::set_permissions(f.path("old-bundle.json"), fs::Permissions::from_mode(0o600)).unwrap();
    f.bad("import", &json!({"runtimeDir":f.path("alpha"),"bundlePath":f.path("old-bundle.json"),"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
    let revoked = f.ok(
        "revoke",
        &json!({"issuerDir":f.path("issuer"),"machineId":"beta"}),
    );
    f.ok("import", &json!({"runtimeDir":f.path("alpha"),"bundlePath":revoked["bundlePath"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
    f.bad("import", &json!({"runtimeDir":f.path("beta"),"bundlePath":revoked["bundlePath"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
    f.bad("renew", &json!({"issuerDir":f.path("issuer"),"requestPath":inspect["requestPath"],"confirmedRequestSha256":inspect["requestSha256"]}));
    fs::remove_file(alpha["revocationState"].as_str().unwrap()).unwrap();
    f.bad("import", &json!({"runtimeDir":f.path("alpha"),"bundlePath":revoked["bundlePath"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
    assert!(
        !Path::new(alpha["revocationState"].as_str().unwrap()).exists(),
        "missing floor never repaired"
    );
    private_tree(&f.0);
}
#[test]
fn cli_rejects_tamper_third_machine_unconfirmed_or_ambiguous_exchange() {
    let f = Fixture::new();
    let (creator, joined) = f.joined();
    f.bad("join", &json!({"runtimeDir":f.path("bad"),"offerPath":creator["offerPath"],"confirmedRootSha256":"00".repeat(32)}));
    f.bad("issue", &json!({"issuerDir":f.path("issuer"),"requestPath":joined["requestPath"],"confirmedRequestSha256":"00".repeat(32)}));
    let path = PathBuf::from(joined["requestPath"].as_str().unwrap());
    let mut req: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    req["machineId"] = json!("third");
    fs::write(&path, serde_json::to_vec(&req).unwrap()).unwrap();
    let fingerprint = ring::digest::digest(&ring::digest::SHA256, &fs::read(&path).unwrap());
    let fingerprint: String = fingerprint.as_ref().iter().fold(String::new(), |mut s, b| {
        use std::fmt::Write;
        write!(s, "{b:02x}").unwrap();
        s
    });
    f.bad("issue", &json!({"issuerDir":f.path("issuer"),"requestPath":path,"confirmedRequestSha256":fingerprint}));
    f.bad("create", &json!({"issuerDir":f.path("issuer"),"runtimeDir":f.path("new-runtime"),"machineId":"third","peerMachineId":"fourth"}));
    f.bad(
        "export",
        &json!({"issuerDir":f.path("issuer"),"execute":"evil"}),
    );
}

impl Fixture {
    fn bad(&self, op: &str, input: &Value) {
        let output = self.run(op, input);
        assert!(!output.status.success(), "must reject {op}");
        assert!(
            output.stdout.is_empty(),
            "no false success or private material"
        );
    }
}

fn public_request(f: &Fixture, value: &Value) -> (PathBuf, String) {
    use std::fmt::Write;
    let path = f.path("tampered-request.json");
    let bytes = serde_json::to_vec(value).expect("public request JSON");
    fs::write(&path, &bytes).expect("test exchange");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("private public exchange");
    let fingerprint = ring::digest::digest(&ring::digest::SHA256, &bytes)
        .as_ref()
        .iter()
        .fold(String::new(), |mut s, b| {
            write!(s, "{b:02x}").expect("String write");
            s
        });
    (path, fingerprint)
}
#[test]
fn confirmed_root_cannot_authorize_offer_name_tamper_and_renewal_pins_machine_keys() {
    let f = Fixture::new();
    let (creator, _, _) = f.issued();
    let offer_path = PathBuf::from(creator["offerPath"].as_str().unwrap());
    let mut offer: Value = serde_json::from_slice(&fs::read(&offer_path).unwrap()).unwrap();
    offer["peerMachineId"] = json!("third");
    fs::write(&offer_path, serde_json::to_vec(&offer).unwrap()).unwrap();
    f.bad("join",&json!({"runtimeDir":f.path("third"),"offerPath":offer_path,"confirmedRootSha256":creator["rootSha256"]}));
    assert!(
        !f.path("third").exists(),
        "signed-root name tamper rejected before creating state"
    );
    let original: Value =
        serde_json::from_slice(&fs::read(f.path("beta/request.json")).unwrap()).unwrap();
    let before = fs::read(f.path("issuer/issuer.json")).unwrap();
    for name in ["beta", "alpha"] {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params =
            rcgen::CertificateParams::new(vec![format!("gateway.{name}.pi.internal")]).unwrap();
        params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![
            rcgen::ExtendedKeyUsagePurpose::ClientAuth,
            rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        ];
        let csr = params.serialize_request(&key).unwrap();
        let mut request = original.clone();
        request["machineId"] = json!(name);
        request["csr"] = json!(csr.der().to_vec());
        let (path, fingerprint) = public_request(&f, &request);
        f.bad("renew",&json!({"issuerDir":f.path("issuer"),"requestPath":path,"confirmedRequestSha256":fingerprint}));
    }
    let mut request = original;
    let array = request["csr"].as_array_mut().unwrap();
    let last = array.last_mut().unwrap();
    *last = json!(last.as_u64().unwrap() ^ 1);
    let (path, fingerprint) = public_request(&f, &request);
    f.bad("renew",&json!({"issuerDir":f.path("issuer"),"requestPath":path,"confirmedRequestSha256":fingerprint}));
    assert_eq!(
        before,
        fs::read(f.path("issuer/issuer.json")).unwrap(),
        "rejected signed-CSR/key tampering cannot reserve serials"
    );
}
#[test]
fn existing_material_import_preserves_explicit_floor_and_private_key_custody() {
    let f = Fixture::new();
    let (creator, alpha, _) = f.issued();
    let mut input = json!({"runtimeDir":f.path("existing"),"machineId":"alpha","peerMachineId":"beta","rootCertificate":alpha["rootCertificates"][0],"certificate":alpha["certificateChain"][0],"privateKey":alpha["privateKey"],"crl":alpha["crls"][0],"revocationState":alpha["revocationState"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"});
    let before = fs::read(alpha["revocationState"].as_str().unwrap()).unwrap();
    let imported = f.ok("import-existing", &input);
    assert_eq!(imported["activationRequired"], true);
    assert_eq!(
        imported["revocationState"], alpha["revocationState"],
        "existing floor remains in place"
    );
    assert_eq!(
        before,
        fs::read(alpha["revocationState"].as_str().unwrap()).unwrap(),
        "staging cannot advance live floor"
    );
    assert_eq!(
        fs::read(imported["privateKey"].as_str().unwrap()).unwrap(),
        fs::read(alpha["privateKey"].as_str().unwrap()).unwrap(),
        "explicit same-host key import"
    );
    input["runtimeDir"] = json!(f.path("missing-existing"));
    input["revocationState"] = json!(f.path("never-floor"));
    f.bad("import-existing", &input);
    assert!(
        !f.path("never-floor").exists(),
        "missing existing floor never created"
    );
    input["runtimeDir"] = json!(f.path("new-existing"));
    input["floorMode"] = json!("new");
    f.ok("import-existing", &input);
    assert!(
        f.path("never-floor").exists(),
        "only explicit new initialization"
    );
}
