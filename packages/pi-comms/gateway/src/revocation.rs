//! Explicit, owner-only durable revocation floors; never automatically initialized or reset.
//!
//! Applying a bundle requires authenticated operator provisioning and completed TLS
//! policy validation first. This store prevents a later restart/configuration rollback
//! from enabling an older issuer CRL. Retired issuer floors remain protected.
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use x509_parser::prelude::FromDer;
use x509_parser::revocation_list::CertificateRevocationList;

use crate::tls::Trust;

const MAX_STATE_BYTES: usize = 1_048_576;
const MAX_ISSUERS: usize = 64;
static TEMPORARY: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Floor {
    issuer: String,
    number: Vec<u8>,
    this_update: i64,
    fingerprint: [u8; 32],
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    issuers: Vec<Floor>,
}

/// An explicitly opened persistent floor store, exclusively locked until dropped.
#[derive(Debug)]
pub struct FloorStore {
    path: PathBuf,
    _lock: File,
    floors: BTreeMap<String, Floor>,
}
impl FloorStore {
    /// Explicitly bootstraps a new empty store; an existing path is never overwritten.
    ///
    /// This is an operator action, not a startup fallback. Missing state during normal
    /// startup must fail closed via [`Self::open`], never call this method automatically.
    ///
    /// # Errors
    /// Rejects unsafe permissions/paths, concurrent ownership, existing state and I/O failures.
    pub fn initialize(path: &Path) -> io::Result<Self> {
        let lock = lock(path)?;
        let mut file = private_options().create_new(true).open(path)?;
        file.write_all(br#"{"version":1,"issuers":[]}"#)?;
        file.sync_all()?;
        File::open(path.parent().ok_or_else(rejected)?)?.sync_all()?;
        Ok(Self {
            path: path.to_owned(),
            _lock: lock,
            floors: BTreeMap::new(),
        })
    }

    /// Opens required existing state without treating absence/corruption as first use.
    ///
    /// # Errors
    /// Rejects unsafe paths/permissions, concurrent owners, malformed/oversized state,
    /// duplicate issuers and unknown versions or fields.
    pub fn open(path: &Path) -> io::Result<Self> {
        Self::read_state(path, lock(path)?)
    }

    pub(crate) fn snapshot(path: &Path) -> io::Result<Self> {
        crate::paths::private_parent(path)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
                    .bits()
                    .cast_signed(),
            )
            .open(path)?;
        Self::read_state(path, file)
    }

    fn read_state(path: &Path, lock: File) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
                    .bits()
                    .cast_signed(),
            )
            .open(path)?;
        validate_file(&file)?;
        let mut bytes = Vec::new();
        file.take(u64::try_from(MAX_STATE_BYTES + 1).map_err(io::Error::other)?)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err(rejected());
        }
        let state: State = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if state.version != 1 || state.issuers.len() > MAX_ISSUERS {
            return Err(rejected());
        }
        let mut floors = BTreeMap::new();
        for floor in state.issuers {
            if floor.issuer.is_empty()
                || floor.issuer.len() > 131_072
                || floor.issuer.len() % 2 != 0
                || !floor
                    .issuer
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || floor.number.is_empty()
                || floor.number.len() > 20
                || (floor.number.len() > 1 && floor.number[0] == 0)
                || floors.insert(floor.issuer.clone(), floor).is_some()
            {
                return Err(rejected());
            }
        }
        Ok(Self {
            path: path.to_owned(),
            _lock: lock,
            floors,
        })
    }

    /// Atomically persists nondecreasing issuer floors before any new routes may activate.
    ///
    /// Caller must first authenticate operator provisioning and validate credential/CRL
    /// signatures, issuer coverage and times. This method enforces monotonicity only.
    /// Removed issuers remain in the floor store; no automatic retirement/reset exists.
    ///
    /// # Errors
    /// Rejects rollback/equivocation, issuer exhaustion, unsafe files and any persistence
    /// failure. A failure must prevent remote activation; no in-memory-only fallback.
    pub fn apply(&mut self, trust: &Trust) -> io::Result<()> {
        let next = self.checked(trust)?;
        let bytes = serde_json::to_vec(&State {
            version: 1,
            issuers: next.values().cloned().collect(),
        })
        .map_err(io::Error::other)?;
        if bytes.len() > MAX_STATE_BYTES {
            return Err(rejected());
        }
        self.persist(&bytes)?;
        self.floors = next;
        Ok(())
    }

    pub(crate) fn check(&self, trust: &Trust) -> io::Result<()> {
        self.checked(trust).map(|_| ())
    }

    fn checked(&self, trust: &Trust) -> io::Result<BTreeMap<String, Floor>> {
        extend_floors(self.floors.clone(), trust)
    }

    fn persist(&self, bytes: &[u8]) -> io::Result<()> {
        crate::paths::private_parent(&self.path)?;
        validate_file(&private_options().open(&self.path)?)?;
        let parent = self.path.parent().ok_or_else(rejected)?;
        let temporary = parent.join(format!(
            ".revocations-{}-{}.tmp",
            std::process::id(),
            TEMPORARY.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = private_options().create_new(true).open(&temporary)?;
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &self.path)?;
            File::open(parent)?.sync_all()
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}
fn rejected() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "revocation state rejected")
}
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true).mode(0o600).custom_flags(
        (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
            .bits()
            .cast_signed(),
    );
    options
}
fn validate_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(rejected());
    }
    Ok(())
}
fn lock(path: &Path) -> io::Result<File> {
    crate::paths::private_parent(path)?;
    let parent = path.parent().ok_or_else(rejected)?;
    if !path.is_absolute() || parent.canonicalize()? != parent {
        return Err(rejected());
    }
    let metadata = std::fs::symlink_metadata(parent)?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(rejected());
    }
    let name = path
        .file_name()
        .ok_or_else(rejected)?
        .to_str()
        .ok_or_else(rejected)?;
    let file = private_options()
        .create(true)
        .truncate(false)
        .open(parent.join(format!(".{name}.lock")))?;
    validate_file(&file)?;
    rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive)?;
    Ok(file)
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    output
}

fn extend_floors(
    mut next: BTreeMap<String, Floor>,
    trust: &Trust,
) -> io::Result<BTreeMap<String, Floor>> {
    for bytes in trust.crls() {
        let (_, crl) = CertificateRevocationList::from_der(bytes).map_err(|_| rejected())?;
        let number = crl.crl_number().ok_or_else(rejected)?.to_bytes_be();
        if number.len() > 20 {
            return Err(rejected());
        }
        let issuer = hex(crl.issuer().as_raw());
        let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
        let fingerprint = digest.as_ref().try_into().map_err(|_| rejected())?;
        let floor = Floor {
            issuer: issuer.clone(),
            number,
            this_update: crl.last_update().timestamp(),
            fingerprint,
        };
        if let Some(prior) = next.get(&issuer) {
            let order =
                (floor.number.len(), &floor.number).cmp(&(prior.number.len(), &prior.number));
            if order.is_lt()
                || floor.this_update < prior.this_update
                || (order.is_eq() && floor.fingerprint != prior.fingerprint)
            {
                return Err(rejected());
            }
        }
        next.insert(issuer, floor);
    }
    if next.len() > MAX_ISSUERS {
        return Err(rejected());
    }
    Ok(next)
}
pub(crate) fn check_successor(prior: &Trust, next: &Trust) -> io::Result<()> {
    extend_floors(extend_floors(BTreeMap::new(), prior)?, next).map(|_| ())
}
