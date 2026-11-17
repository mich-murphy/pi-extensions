//! Pair-specific issuer custody and locked monotonic public bundle publication.
use super::runtime::{install, make_runtime};
use super::storage::{atomic, create_dir, lock, read, read_json, write_new};
use super::{
    Bundle, Create, FloorMode, Issue, Issued, IssuerPath, Leaf, Offer, Revoke, State,
    checked_request, clone_json, confirm, error, leaf_params, machine, reject, sha256,
    validate_offer,
};
use super::{Request, storage};
use rcgen::{
    BasicConstraints, CertificateParams, CertificateRevocationListParams, DnType, IsCa, Issuer,
    KeyIdMethod, KeyPair, KeyUsagePurpose, RevokedCertParams,
};
use serde_json::{Value, json};
use std::{io, path::Path};
use time::{Duration, OffsetDateTime};
pub(super) fn create(input: Create) -> io::Result<Value> {
    if !machine(&input.machine_id)
        || !machine(&input.peer_machine_id)
        || input.machine_id == input.peer_machine_id
        || input.issuer_dir == input.runtime_dir
        || input.issuer_dir.starts_with(&input.runtime_dir)
        || input.runtime_dir.starts_with(&input.issuer_dir)
    {
        return Err(reject("invalid pair identities or custody paths"));
    }
    create_dir(&input.issuer_dir)?;
    let _guard = lock(&input.issuer_dir)?;
    let key = KeyPair::generate().map_err(error)?;
    let mut params = CertificateParams::new(Vec::<String>::new()).map_err(error)?;
    params.distinguished_name.push(
        DnType::CommonName,
        format!("Pi pair {} {}", input.machine_id, input.peer_machine_id),
    );
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.not_before = OffsetDateTime::now_utc() - Duration::minutes(5);
    params.not_after = OffsetDateTime::now_utc() + Duration::days(365);
    let root = params.self_signed(&key).map_err(error)?.der().to_vec();
    let offer = Offer {
        version: 1,
        pair_id: sha256(&root),
        machine_id: input.machine_id.clone(),
        peer_machine_id: input.peer_machine_id,
        root,
    };
    write_new(
        &input.issuer_dir.join("issuer-key.der"),
        &key.serialize_der(),
    )?;
    write_new(
        &input.issuer_dir.join("offer.json"),
        &serde_json::to_vec(&offer).map_err(error)?,
    )?;
    let req = make_runtime(&input.runtime_dir, clone_json(&offer)?, input.machine_id)?;
    let mut state = State {
        offer,
        next_serial: 1,
        crl_number: 0,
        requests: vec![req],
        issued: vec![],
        revoked: vec![],
        revoked_machines: vec![],
    };
    write_new(
        &input.issuer_dir.join("issuer.json"),
        &serde_json::to_vec(&state).map_err(error)?,
    )?;
    let bundle = publish(&input.issuer_dir, &mut state)?;
    let bundle_path = input.issuer_dir.join("bundle.json");
    let credentials = install(&input.runtime_dir, &bundle, FloorMode::New)?;
    Ok(
        json!({"offerPath":input.issuer_dir.join("offer.json"),"rootSha256":sha256(&state.offer.root),"pairId":state.offer.pair_id,"runtimeDir":input.runtime_dir,"bundlePath":bundle_path,"credentials":credentials}),
    )
}

pub(super) fn issue(input: &Issue, operation: &str) -> io::Result<Value> {
    let _guard = lock(&input.issuer_dir)?;
    let mut state: State = read_json(&input.issuer_dir.join("issuer.json"))?;
    validate_offer(&state.offer)?;
    let bytes = read(&input.request_path)?;
    confirm(&bytes, &input.confirmed_request_sha256)?;
    let req: Request = storage::decode(&bytes)?;
    checked_request(&req, &state.offer)?;
    if state.revoked_machines.contains(&req.machine_id) {
        return Err(reject("revoked machine requires explicit new-root re-pair"));
    }
    let prior = state
        .requests
        .iter()
        .position(|prior| prior.machine_id == req.machine_id);
    if prior.is_some() != (operation == "renew") {
        return Err(reject(
            "use issue for initial peer and renew for existing bound machine",
        ));
    }
    if let Some(index) = prior {
        if state.requests[index].csr != req.csr {
            return Err(reject(
                "renewal must reuse the pinned signed CSR/key; rotation requires new-root re-pair",
            ));
        }
        state.requests[index] = req;
    } else {
        state.requests.push(req);
    }
    publish(&input.issuer_dir, &mut state)?;
    Ok(bundle_output(&input.issuer_dir, &state.offer))
}

pub(super) fn publish(dir: &Path, state: &mut State) -> io::Result<Bundle> {
    if state.requests.len() > 2 || state.issued.len() > 4096 {
        return Err(reject("pair issuance bound exceeded"));
    }
    let key = KeyPair::try_from(read(&dir.join("issuer-key.der"))?.as_slice()).map_err(error)?;
    let issuer =
        Issuer::from_ca_cert_der(&state.offer.root.as_slice().into(), key).map_err(error)?;
    let first = state.next_serial;
    state.next_serial = first
        .checked_add(u64::try_from(state.requests.len()).map_err(error)?)
        .ok_or_else(|| reject("serial exhausted"))?;
    state.crl_number = state
        .crl_number
        .checked_add(1)
        .ok_or_else(|| reject("CRL number exhausted"))?;
    // Reserve counters durably BEFORE signing: a failed action consumes numbers, never reuses them.
    atomic(
        &dir.join("issuer.json"),
        &serde_json::to_vec(state).map_err(error)?,
    )?;
    let mut leaves = Vec::new();
    for (index, req) in state.requests.iter().enumerate() {
        if state.revoked_machines.contains(&req.machine_id) {
            continue;
        }
        let serial = first + u64::try_from(index).map_err(error)?;
        let mut csr = checked_request(req, &state.offer)?;
        csr.params = leaf_params(&req.machine_id, serial)?;
        let certificate = csr.signed_by(&issuer).map_err(error)?.der().to_vec();
        state.issued.push(Issued {
            machine_id: req.machine_id.clone(),
            serial,
        });
        leaves.push(Leaf {
            machine_id: req.machine_id.clone(),
            certificate,
        });
    }
    let now = OffsetDateTime::now_utc();
    let crl = CertificateRevocationListParams {
        this_update: now,
        next_update: now + Duration::days(30),
        crl_number: state.crl_number.into(),
        issuing_distribution_point: None,
        key_identifier_method: KeyIdMethod::Sha256,
        revoked_certs: state
            .revoked
            .iter()
            .map(|serial| RevokedCertParams {
                serial_number: (*serial).into(),
                revocation_time: now,
                reason_code: Some(rcgen::RevocationReason::KeyCompromise),
                invalidity_date: None,
            })
            .collect(),
    }
    .signed_by(&issuer)
    .map_err(error)?
    .der()
    .to_vec();
    let bundle = Bundle {
        offer: clone_json(&state.offer)?,
        leaves,
        crl,
    };
    atomic(
        &dir.join("issuer.json"),
        &serde_json::to_vec(state).map_err(error)?,
    )?;
    let path = dir.join("bundle.json");
    let bytes = serde_json::to_vec(&bundle).map_err(error)?;
    if path.try_exists()? {
        atomic(&path, &bytes)?;
    } else {
        write_new(&path, &bytes)?;
    }
    Ok(bundle)
}

pub(super) fn bundle_output(dir: &Path, offer: &Offer) -> Value {
    json!({"bundlePath":dir.join("bundle.json"),"rootSha256":sha256(&offer.root),"pairId":offer.pair_id})
}

pub(super) fn revoke(input: &Revoke) -> io::Result<Value> {
    let _guard = lock(&input.issuer_dir)?;
    let mut state: State = read_json(&input.issuer_dir.join("issuer.json"))?;
    if input.machine_id != state.offer.machine_id && input.machine_id != state.offer.peer_machine_id
    {
        return Err(reject("not a bound pair machine"));
    }
    if !state.revoked_machines.contains(&input.machine_id) {
        state.revoked_machines.push(input.machine_id.clone());
    }
    for issued in &state.issued {
        if issued.machine_id == input.machine_id && !state.revoked.contains(&issued.serial) {
            state.revoked.push(issued.serial);
        }
    }
    publish(&input.issuer_dir, &mut state)?;
    Ok(bundle_output(&input.issuer_dir, &state.offer))
}

pub(super) fn export(input: &IssuerPath) -> io::Result<Value> {
    let _guard = lock(&input.issuer_dir)?;
    let state: State = read_json(&input.issuer_dir.join("issuer.json"))?;
    let _: Bundle = read_json(&input.issuer_dir.join("bundle.json"))?;
    Ok(bundle_output(&input.issuer_dir, &state.offer))
}
