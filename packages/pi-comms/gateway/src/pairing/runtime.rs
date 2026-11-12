//! Local key custody, resumable immutable staging and public expiry inspection.
use super::storage::{atomic, create_dir, lock, read, read_json, sync_existing, write_new};
use super::{
    Bundle, FloorMode, Import, ImportExisting, Join, Leaf, Offer, Pending, Request, Runtime,
    RuntimePath, clone_json, confirm, error, reject, request, sha256, validate_offer,
    validate_root,
};
use crate::{
    revocation::FloorStore,
    tls::{Policy, Trust},
};
use rcgen::KeyPair;
use serde_json::{Value, json};
use std::{io, path::Path};
use time::OffsetDateTime;
use x509_parser::prelude::{FromDer, X509Certificate};
pub(super) fn make_runtime(dir: &Path, offer: Offer, machine_id: String) -> io::Result<Request> {
    create_dir(dir)?;
    let key = KeyPair::generate().map_err(error)?;
    write_new(&dir.join("leaf-key.der"), &key.serialize_der())?;
    let req = request(&offer, &machine_id, &key)?;
    write_new(
        &dir.join("request.json"),
        &serde_json::to_vec(&req).map_err(error)?,
    )?;
    write_new(
        &dir.join("runtime.json"),
        &serde_json::to_vec(&Runtime {
            offer,
            machine_id,
            installed: false,
            generation: 0,
            revocation_state: None,
            pending: None,
            imported: false,
        })
        .map_err(error)?,
    )?;
    Ok(req)
}

pub(super) fn join(input: &Join) -> io::Result<Value> {
    let offer: Offer = read_json(&input.offer_path)?;
    validate_offer(&offer)?;
    confirm(&offer.root, &input.confirmed_root_sha256)?;
    let machine_id = offer.peer_machine_id.clone();
    let req = make_runtime(&input.runtime_dir, offer, machine_id)?;
    let path = input.runtime_dir.join("request.json");
    Ok(
        json!({"requestPath":path,"requestSha256":sha256(&read(&path)?),"rootSha256":req.root_sha256,"pairId":req.pair_id}),
    )
}

pub(super) fn import(input: &Import) -> io::Result<Value> {
    let bundle: Bundle = read_json(&input.bundle_path)?;
    confirm(&bundle.offer.root, &input.confirmed_root_sha256)?;
    install(&input.runtime_dir, &bundle, input.floor_mode)
}

pub(super) fn install(dir: &Path, bundle: &Bundle, mode: FloorMode) -> io::Result<Value> {
    install_transaction(dir, bundle, mode, || Ok(()))
}

pub(super) fn install_transaction(
    dir: &Path,
    bundle: &Bundle,
    mode: FloorMode,
    after_floor: impl FnOnce() -> io::Result<()>,
) -> io::Result<Value> {
    let _guard = lock(dir)?;
    let mut runtime: Runtime = read_json(&dir.join("runtime.json"))?;
    let (own, trust) = validate_install(dir, &runtime, bundle, mode)?;
    let floor = runtime
        .revocation_state
        .clone()
        .unwrap_or_else(|| dir.join("revocation-floor.json"));
    let bundle_bytes = serde_json::to_vec(bundle).map_err(error)?;
    let bundle_sha256 = sha256(&bundle_bytes);
    let resuming = runtime.pending.is_some();
    if mode == FloorMode::New && resuming && !floor.try_exists()? {
        return Err(reject(
            "owned enrollment floor missing; refusing reinitialization; re-pair with a new root and fresh directories",
        ));
    }
    if mode == FloorMode::Existing || (resuming && floor.try_exists()?) {
        FloorStore::snapshot(&floor)?.check(&trust)?;
    }
    let generation_number = if let Some(pending) = &runtime.pending {
        if pending.bundle_sha256 != bundle_sha256 {
            return Err(reject(
                "incomplete import requires the exact same bundle; floor is never reset",
            ));
        }
        // Explicitly requested bytes must match, and the retained public copy
        // must still authenticate to the durable transaction hash. No fallback.
        pending_bundle(dir, pending)?;
        pending.generation
    } else {
        if mode == FloorMode::New && floor.try_exists()? {
            return Err(reject(
                "new floor already exists without owned import transaction",
            ));
        }
        let next = runtime
            .generation
            .checked_add(1)
            .ok_or_else(|| reject("generation exhausted"))?;
        let cached = bundle_path(dir, &bundle_sha256)?;
        if cached.try_exists()? {
            if read(&cached)? != bundle_bytes {
                return Err(reject("retained public bundle differs from canonical hash"));
            }
            sync_existing(&cached)?;
        } else {
            // Both file and parent are synced before publishing the pending record.
            write_new(&cached, &bundle_bytes)?;
        }
        runtime.pending = Some(Pending {
            bundle_sha256,
            generation: next,
        });
        atomic(
            &dir.join("runtime.json"),
            &serde_json::to_vec(&runtime).map_err(error)?,
        )?;
        next
    };
    if mode == FloorMode::New {
        let mut floors = if resuming {
            FloorStore::open(&floor)?
        } else {
            FloorStore::initialize(&floor)?
        };
        floors.apply(&trust)?;
    }
    after_floor()?;
    let generation = dir.join(format!("credentials-{generation_number}"));
    if !generation.try_exists()? {
        create_dir(&generation)?;
    }
    // A durable pending record owns these exact paths. Resume atomically replaces
    // only these known files, never cleans arbitrary directory entries.
    for (name, bytes) in [
        ("root.der", &bundle.offer.root),
        ("leaf.der", &own.certificate),
        ("crl.der", &bundle.crl),
    ] {
        let path = generation.join(name);
        if path.try_exists()? {
            atomic(&path, bytes)?;
        } else {
            write_new(&path, bytes)?;
        }
    }
    runtime.generation = generation_number;
    runtime.pending = None;
    runtime.installed = true;
    atomic(
        &dir.join("runtime.json"),
        &serde_json::to_vec(&runtime).map_err(error)?,
    )?;
    let mut output = credentials(dir, &runtime);
    output["activationRequired"] = json!(true);
    Ok(output)
}

fn bundle_path(dir: &Path, hash: &str) -> io::Result<std::path::PathBuf> {
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(reject("invalid pending bundle hash"));
    }
    Ok(dir.join(format!("public-bundle-{hash}.json")))
}

fn pending_bundle(dir: &Path, pending: &Pending) -> io::Result<std::path::PathBuf> {
    let path = bundle_path(dir, &pending.bundle_sha256)?;
    if sha256(&read(&path)?) != pending.bundle_sha256 {
        return Err(reject("retained public bundle hash mismatch"));
    }
    Ok(path)
}

pub(super) fn credentials(dir: &Path, runtime: &Runtime) -> Value {
    let generation = dir.join(format!("credentials-{}", runtime.generation));
    let peer = if runtime.machine_id == runtime.offer.machine_id {
        &runtime.offer.peer_machine_id
    } else {
        &runtime.offer.machine_id
    };
    json!({"pairId":runtime.offer.pair_id,"machineId":runtime.machine_id,"peerMachineId":peer,"rootCertificates":[generation.join("root.der")],"certificateChain":[generation.join("leaf.der")],"issuerCertificates":[],"privateKey":dir.join("leaf-key.der"),"crls":[generation.join("crl.der")],"revocationState":runtime.revocation_state.clone().unwrap_or_else(|| dir.join("revocation-floor.json"))})
}

pub(super) fn inspect(input: &RuntimePath) -> io::Result<Value> {
    let runtime: Runtime = read_json(&input.runtime_dir.join("runtime.json"))?;
    let mut result = credentials(&input.runtime_dir, &runtime);
    result["installed"] = json!(runtime.installed);
    if let Some(pending) = &runtime.pending {
        result["pendingBundlePath"] = json!(pending_bundle(&input.runtime_dir, pending)?);
    }
    result["rootSha256"] = json!(sha256(&runtime.offer.root));
    result["requestPath"] = json!(input.runtime_dir.join("request.json"));
    result["requestSha256"] = json!(sha256(&read(&input.runtime_dir.join("request.json"))?));
    if runtime.installed {
        let generation = input
            .runtime_dir
            .join(format!("credentials-{}", runtime.generation));
        let bytes = read(&generation.join("leaf.der"))?;
        let (_, leaf) = X509Certificate::from_der(&bytes).map_err(error)?;
        let bytes = read(&generation.join("crl.der"))?;
        let (_, crl) = x509_parser::revocation_list::CertificateRevocationList::from_der(&bytes)
            .map_err(error)?;
        let (_, root) = X509Certificate::from_der(&runtime.offer.root).map_err(error)?;
        let root_expiry = root.validity().not_after.timestamp();
        let leaf_expiry = leaf.validity().not_after.timestamp();
        result["rootExpiresAt"] = json!(root_expiry);
        let crl_expiry = crl
            .next_update()
            .ok_or_else(|| reject("missing CRL nextUpdate"))?
            .timestamp();
        result["leafExpiresAt"] = json!(leaf_expiry);
        result["crlExpiresAt"] = json!(crl_expiry);
        result["expiryWarning"] = json!(
            root_expiry.min(leaf_expiry).min(crl_expiry)
                - OffsetDateTime::now_utc().unix_timestamp()
                <= 7 * 86400
        );
    }
    Ok(result)
}

pub(super) fn import_existing(input: &ImportExisting) -> io::Result<Value> {
    let root = read(&input.root_certificate)?;
    confirm(&root, &input.confirmed_root_sha256)?;
    let offer = Offer {
        version: 1,
        pair_id: sha256(&root),
        machine_id: input.machine_id.clone(),
        peer_machine_id: input.peer_machine_id.clone(),
        root,
    };
    validate_root(&offer)?;
    let certificate = read(&input.certificate)?;
    let crl = read(&input.crl)?;
    let key_bytes = read(&input.private_key)?;
    let key = KeyPair::try_from(key_bytes.as_slice()).map_err(error)?;
    let trust = Trust::from_der(vec![offer.root.clone()], vec![crl.clone()]).map_err(error)?;
    let now = u64::try_from(OffsetDateTime::now_utc().unix_timestamp()).map_err(error)?;
    trust.validate_revocation_bundle(&[], now).map_err(error)?;
    let policy = Policy::new(trust.clone(), &input.machine_id).map_err(error)?;
    policy
        .credential_expiry(std::slice::from_ref(&certificate), now)
        .map_err(error)?;
    policy
        .client_config(vec![certificate.clone()], key_bytes.clone())
        .map_err(error)?;
    // Check explicit floor semantics before creating any runtime files.
    if input.floor_mode == FloorMode::Existing {
        FloorStore::snapshot(&input.revocation_state)?.check(&trust)?;
    } else if input.revocation_state.try_exists()? {
        return Err(reject("new floor already exists"));
    }
    create_dir(&input.runtime_dir)?;
    write_new(&input.runtime_dir.join("leaf-key.der"), &key_bytes)?;
    let req = request(&offer, &input.machine_id, &key)?;
    write_new(
        &input.runtime_dir.join("request.json"),
        &serde_json::to_vec(&req).map_err(error)?,
    )?;
    let runtime = Runtime {
        offer: clone_json(&offer)?,
        machine_id: input.machine_id.clone(),
        installed: input.floor_mode == FloorMode::Existing,
        generation: 0,
        revocation_state: Some(input.revocation_state.clone()),
        pending: None,
        imported: true,
    };
    write_new(
        &input.runtime_dir.join("runtime.json"),
        &serde_json::to_vec(&runtime).map_err(error)?,
    )?;
    install(
        &input.runtime_dir,
        &Bundle {
            offer,
            leaves: vec![Leaf {
                machine_id: input.machine_id.clone(),
                certificate,
            }],
            crl,
        },
        input.floor_mode,
    )
}

pub(super) fn validate_install<'a>(
    dir: &Path,
    runtime: &Runtime,
    bundle: &'a Bundle,
    mode: FloorMode,
) -> io::Result<(&'a Leaf, Trust)> {
    if runtime.imported {
        validate_root(&bundle.offer)?;
    } else {
        validate_offer(&bundle.offer)?;
    }
    if serde_json::to_vec(&runtime.offer).map_err(error)?
        != serde_json::to_vec(&bundle.offer).map_err(error)?
        || (mode == FloorMode::New) == runtime.installed
        || bundle.leaves.len() > 2
    {
        return Err(reject(
            "runtime binding/floor mode mismatch; existing floor is never reinitialized",
        ));
    }
    let mut names = std::collections::HashSet::new();
    for leaf in &bundle.leaves {
        if (leaf.machine_id != runtime.offer.machine_id
            && leaf.machine_id != runtime.offer.peer_machine_id)
            || !names.insert(&leaf.machine_id)
        {
            return Err(reject("unexpected or duplicate pair leaf"));
        }
    }
    let own = bundle
        .leaves
        .iter()
        .find(|leaf| leaf.machine_id == runtime.machine_id)
        .ok_or_else(|| reject("bundle lacks own leaf (possibly revoked)"))?;
    let trust = Trust::from_der(vec![bundle.offer.root.clone()], vec![bundle.crl.clone()])
        .map_err(error)?;
    let now = u64::try_from(OffsetDateTime::now_utc().unix_timestamp()).map_err(error)?;
    trust.validate_revocation_bundle(&[], now).map_err(error)?;
    for leaf in &bundle.leaves {
        Policy::new(trust.clone(), &leaf.machine_id)
            .map_err(error)?
            .credential_expiry(std::slice::from_ref(&leaf.certificate), now)
            .map_err(error)?;
    }
    if runtime.installed && runtime.generation > 0 {
        let generation = dir.join(format!("credentials-{}", runtime.generation));
        let prior = Trust::from_der(
            vec![read(&generation.join("root.der"))?],
            vec![read(&generation.join("crl.der"))?],
        )
        .map_err(error)?;
        crate::revocation::check_successor(&prior, &trust)?;
    }
    let key = read(&dir.join("leaf-key.der"))?;
    Policy::new(trust.clone(), &runtime.machine_id)
        .map_err(error)?
        .client_config(vec![own.certificate.clone()], key)
        .map_err(error)?;
    Ok((own, trust))
}
