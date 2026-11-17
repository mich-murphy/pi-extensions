//! Explicit two-machine provisioning. Public exchanges contain DER bytes, never keys.
//! Same-account custody is not privilege isolation; a stolen issuer requires a new root.
use std::io;
use std::path::PathBuf;

use rcgen::{
    CertificateParams, CertificateSigningRequestParams, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use x509_parser::prelude::{FromDer, X509Certificate};

mod issuer;
mod runtime;
mod storage;
use issuer::{create, export, issue, revoke};
use runtime::{import, import_existing, inspect, join};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Offer {
    version: u8,
    pair_id: String,
    machine_id: String,
    peer_machine_id: String,
    root: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u8,
    pair_id: String,
    machine_id: String,
    root_sha256: String,
    csr: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Leaf {
    machine_id: String,
    certificate: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    offer: Offer,
    leaves: Vec<Leaf>,
    crl: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Runtime {
    offer: Offer,
    machine_id: String,
    installed: bool,
    generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revocation_state: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
    #[serde(default)]
    imported: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    bundle_sha256: String,
    generation: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Issued {
    machine_id: String,
    serial: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    offer: Offer,
    next_serial: u64,
    crl_number: u64,
    requests: Vec<Request>,
    issued: Vec<Issued>,
    revoked: Vec<u64>,
    revoked_machines: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    issuer_dir: PathBuf,
    runtime_dir: PathBuf,
    machine_id: String,
    peer_machine_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Join {
    runtime_dir: PathBuf,
    offer_path: PathBuf,
    confirmed_root_sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Issue {
    issuer_dir: PathBuf,
    request_path: PathBuf,
    confirmed_request_sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    runtime_dir: PathBuf,
    bundle_path: PathBuf,
    confirmed_root_sha256: String,
    floor_mode: FloorMode,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum FloorMode {
    New,
    Existing,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IssuerPath {
    issuer_dir: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimePath {
    runtime_dir: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revoke {
    issuer_dir: PathBuf,
    machine_id: String,
}

/// Executes one bounded explicit provisioning action. Returned JSON is public-only.
///
/// # Errors
/// Rejects unknown fields, unsafe paths, existing setup, unconfirmed exchanges,
/// identity/signature failures, missing existing floors and concurrent mutations.
pub fn execute(operation: &str, input: &[u8]) -> io::Result<Value> {
    let value = crate::wire::decode_json(input, crate::wire::Role::LocalClient).map_err(error)?;
    let mut output = match operation {
        "create" => create(parse(value)?)?,
        "join" => join(&parse(value)?)?,
        "issue" | "renew" => issue(&parse(value)?, operation)?,
        "import" => import(&parse(value)?)?,
        "import-existing" => import_existing(&parse(value)?)?,
        "revoke" => revoke(&parse(value)?)?,
        "export" => export(&parse(value)?)?,
        "inspect" => inspect(&parse(value)?)?,
        _ => return Err(reject("unknown pairing operation")),
    };
    output["version"] = json!(1);
    output["operation"] = json!(operation);
    Ok(output)
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> io::Result<T> {
    serde_json::from_value(value).map_err(|_| reject("invalid pairing input"))
}
fn error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}
fn reject(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn machine(machine: &str) -> bool {
    !machine.is_empty()
        && machine.len() <= 32
        && machine.as_bytes()[0].is_ascii_lowercase()
        && machine
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn sha256(bytes: &[u8]) -> String {
    use std::fmt::Write;
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            write!(output, "{byte:02x}").expect("writing to String cannot fail");
            output
        })
}

fn confirm(bytes: &[u8], confirmed: &str) -> io::Result<()> {
    if confirmed.len() != 64 || sha256(bytes) != confirmed {
        return Err(reject("full SHA256 confirmation mismatch"));
    }
    Ok(())
}
fn validate_root(offer: &Offer) -> io::Result<()> {
    if offer.version != 1
        || offer.pair_id != sha256(&offer.root)
        || !machine(&offer.machine_id)
        || !machine(&offer.peer_machine_id)
        || offer.machine_id == offer.peer_machine_id
    {
        return Err(reject("invalid pair binding"));
    }
    let (rest, root) = X509Certificate::from_der(&offer.root).map_err(error)?;
    if !rest.is_empty() || root.subject() != root.issuer() || !root.validity().is_valid() {
        return Err(reject("invalid pair root"));
    }
    root.verify_signature(None).map_err(error)?;
    Ok(())
}
fn validate_offer(offer: &Offer) -> io::Result<()> {
    validate_root(offer)?;
    let (_, root) = X509Certificate::from_der(&offer.root).map_err(error)?;
    let names: Vec<_> = root.subject().iter_common_name().collect();
    let expected = format!("Pi pair {} {}", offer.machine_id, offer.peer_machine_id);
    if names.len() != 1 || names[0].as_str().map_err(error)? != expected {
        return Err(reject(
            "offer machine binding does not match signed pair root",
        ));
    }
    Ok(())
}
fn leaf_params(machine: &str, serial: u64) -> io::Result<CertificateParams> {
    let mut params =
        CertificateParams::new(vec![format!("gateway.{machine}.pi.internal")]).map_err(error)?;
    params.not_before = OffsetDateTime::now_utc() - Duration::minutes(5);
    params.not_after = OffsetDateTime::now_utc() + Duration::days(90);
    params.serial_number = Some(serial.into());
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![
        ExtendedKeyUsagePurpose::ClientAuth,
        ExtendedKeyUsagePurpose::ServerAuth,
    ];
    Ok(params)
}
fn request(offer: &Offer, machine_id: &str, key: &KeyPair) -> io::Result<Request> {
    let mut params = leaf_params(machine_id, 1)?;
    params.serial_number = None;
    let csr = params.serialize_request(key).map_err(error)?;
    Ok(Request {
        version: 1,
        pair_id: offer.pair_id.clone(),
        machine_id: machine_id.into(),
        root_sha256: sha256(&offer.root),
        csr: csr.der().to_vec(),
    })
}

fn clone_json<T: Serialize + serde::de::DeserializeOwned>(value: &T) -> io::Result<T> {
    serde_json::from_value(serde_json::to_value(value).map_err(error)?).map_err(error)
}

fn checked_request(req: &Request, offer: &Offer) -> io::Result<CertificateSigningRequestParams> {
    if req.version != 1
        || req.pair_id != offer.pair_id
        || req.root_sha256 != sha256(&offer.root)
        || (req.machine_id != offer.machine_id && req.machine_id != offer.peer_machine_id)
    {
        return Err(reject("request pair/machine binding mismatch"));
    }
    let (rest, _) =
        x509_parser::certification_request::X509CertificationRequest::from_der(&req.csr)
            .map_err(error)?;
    if !rest.is_empty() {
        return Err(reject("trailing CSR data"));
    }
    let csr =
        CertificateSigningRequestParams::from_der(&req.csr.as_slice().into()).map_err(error)?;
    let expected = leaf_params(&req.machine_id, 1)?;
    if csr.params.subject_alt_names != expected.subject_alt_names
        || !matches!(csr.params.is_ca, IsCa::NoCa)
        || csr.params.key_usages != expected.key_usages
        || (csr.params.extended_key_usages.len() != 2
            || !expected
                .extended_key_usages
                .iter()
                .all(|usage| csr.params.extended_key_usages.contains(usage)))
    {
        return Err(reject("CSR must request exact machine SAN and leaf usages"));
    }
    Ok(csr)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportExisting {
    runtime_dir: PathBuf,
    machine_id: String,
    peer_machine_id: String,
    root_certificate: PathBuf,
    certificate: PathBuf,
    private_key: PathBuf,
    crl: PathBuf,
    revocation_state: PathBuf,
    confirmed_root_sha256: String,
    floor_mode: FloorMode,
}

#[cfg(test)]
mod tests;
