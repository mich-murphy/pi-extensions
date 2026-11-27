//! Explicit private DER credential preparation, durable installation floors and bounded TLS handshakes.
//!
//! These APIs neither install credentials nor initialize revocation state. Every path
//! is explicitly supplied, owner-only and opened without following a leaf symlink.
use std::fmt;
use std::fs::OpenOptions;
use std::io::{self, Read};
use std::net::SocketAddr;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use rustls::pki_types::ServerName;
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::Instant;
use tokio_rustls::{TlsAcceptor, TlsConnector, TlsStream};

use crate::lease::LinkLease;
use crate::revocation::FloorStore;
use crate::tls::{Policy, Trust};
use crate::wire::{self, Role};

const HANDSHAKE: Duration = Duration::from_secs(5);

/// Exactly one configured outbound initiator or inbound listener for the pair.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
#[non_exhaustive]
pub enum Endpoint {
    /// Initiates a TLS connection to this address; identity remains the configured SAN.
    Connect {
        /// Explicit IP dial address, never a certificate identity substitute.
        address: SocketAddr,
    },
    /// Accepts streams from this operator-selected listening address.
    Listen {
        /// Explicit local IP listener address.
        address: SocketAddr,
    },
}

/// Strict explicit single-peer daemon settings, with no inferred trust or credential paths.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    machine_id: String,
    endpoint: Endpoint,
    #[serde(default)]
    root_certificates: Vec<PathBuf>,
    #[serde(default)]
    certificate_chain: Vec<PathBuf>,
    #[serde(default)]
    issuer_certificates: Vec<PathBuf>,
    private_key: PathBuf,
    #[serde(default)]
    crls: Vec<PathBuf>,
    #[serde(default)]
    revocation_state: Option<PathBuf>,
    /// Pinned mode: the peer's raw Ed25519 public key text; excludes every certificate field.
    #[serde(default)]
    peer_public_key: Option<String>,
}
impl fmt::Debug for Settings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Settings")
            .field("machine_id", &self.machine_id)
            .field("endpoint", &self.endpoint)
            .field("credential_paths", &"<redacted>")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Preparation {
    Commit,
    Snapshot,
}

#[derive(Debug)]
enum Crypto {
    Connect(Arc<rustls::ClientConfig>),
    Listen(Arc<rustls::ServerConfig>),
}

/// How the peer is authenticated once the handshake's verifier accepted it.
enum Trusted {
    /// Private-CA certificates, CRLs and a durable revocation floor.
    Certificates(Box<Certificates>),
    /// One pinned raw public key; carries this gateway's own public key for diagnostics.
    Pinned([u8; crate::keys::PUBLIC_KEY_LEN]),
}

/// Private-CA state with one bounded persistence job and an exclusive floor-store lock.
struct Certificates {
    trust: Trust,
    own_policy: Policy,
    peer_policy: Policy,
    own_chain: Vec<Vec<u8>>,
    expires_at: u64,
    floors: Arc<Mutex<FloorStore>>,
    persistence: Arc<Semaphore>,
}

/// Prepared credentials for one configured peer.
pub struct Prepared {
    machine_id: String,
    endpoint: Endpoint,
    crypto: Crypto,
    trusted: Trusted,
}
impl fmt::Debug for Prepared {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Prepared")
            .field("machine_id", &self.machine_id)
            .field("endpoint", &self.endpoint)
            .finish_non_exhaustive()
    }
}

/// A completed normal mTLS handshake whose floor commit succeeded before activation.
#[derive(Debug)]
pub struct Authenticated {
    stream: TlsStream<TcpStream>,
    lease: LinkLease,
}
impl Authenticated {
    /// Transfers the authenticated stream and mandatory lease to the bounded route owner.
    ///
    /// The owner must run its stream task under this lease, generation-fence route
    /// removal, and drop unforwarded frames on withdrawal. No routes are installed here.
    pub fn into_parts(self) -> (TlsStream<TcpStream>, LinkLease) {
        (self.stream, self.lease)
    }
}

impl Settings {
    /// Parses bounded strict JSON without reading files or connecting to any address.
    ///
    /// # Errors
    /// Rejects ambiguous JSON, unknown fields, invalid machine identity, excessive path
    /// arrays and relative credential/state paths.
    pub fn parse(bytes: &[u8]) -> io::Result<Self> {
        let value = wire::decode_json(bytes, Role::LocalClient).map_err(io::Error::other)?;
        let settings: Self = serde_json::from_value(value).map_err(io::Error::other)?;
        settings.validate()?;
        Ok(settings)
    }

    /// Returns the independently configured authenticated remote machine.
    pub fn machine_id(&self) -> &str {
        &self.machine_id
    }

    pub(crate) fn validate(&self) -> io::Result<()> {
        if !machine(&self.machine_id) || !self.private_key.is_absolute() {
            return Err(rejected());
        }
        // Port 0 asks the OS for an ephemeral listener port, reported at readiness. It is
        // never a valid destination, so a connecting endpoint must name a real port.
        if matches!(self.endpoint, Endpoint::Connect { address } if address.port() == 0) {
            return Err(rejected());
        }
        if let Some(peer) = &self.peer_public_key {
            // Pinned mode takes no certificate, CRL or floor field; mixing the two is refused.
            if crate::keys::parse_public(peer).is_none()
                || !self.root_certificates.is_empty()
                || !self.certificate_chain.is_empty()
                || !self.issuer_certificates.is_empty()
                || !self.crls.is_empty()
                || self.revocation_state.is_some()
            {
                return Err(rejected());
            }
            return Ok(());
        }
        let Some(revocation_state) = &self.revocation_state else {
            return Err(rejected());
        };
        if self.root_certificates.is_empty()
            || self.root_certificates.len() > 4
            || self.certificate_chain.is_empty()
            || self.certificate_chain.len() > 8
            || self.issuer_certificates.len() > 8
            || self.crls.is_empty()
            || self.crls.len() > 16
            || self
                .root_certificates
                .iter()
                .chain(&self.certificate_chain)
                .chain(&self.issuer_certificates)
                .chain(&self.crls)
                .chain([revocation_state])
                .any(|path| !path.is_absolute())
        {
            return Err(rejected());
        }
        Ok(())
    }

    /// Loads only named private DER files and required existing floor state before serving.
    ///
    /// `own_machine` is the gateway's configured identity, never supplied by a wire caller.
    /// Startup file reads are bounded; this does not start a socket listener or daemon.
    ///
    /// # Errors
    /// Rejects unsafe files, invalid own credentials/private trust, busy/missing floor
    /// state and incompatible keys. No default trust, enrollment or initialization occurs.
    pub fn prepare(self, own_machine: &str) -> io::Result<Prepared> {
        self.prepare_mode(own_machine, Preparation::Commit)
    }

    pub(crate) fn diagnose(self, own_machine: &str) -> io::Result<Prepared> {
        self.prepare_mode(own_machine, Preparation::Snapshot)
    }

    fn prepare_mode(self, own_machine: &str, mode: Preparation) -> io::Result<Prepared> {
        if let Some(peer) = &self.peer_public_key {
            return self.prepare_pinned(peer);
        }
        let revocation_state = self.revocation_state.clone().ok_or_else(rejected)?;
        let roots = self
            .root_certificates
            .iter()
            .map(|path| {
                read_private(path).map_err(|error| credential_error("credential-file", error))
            })
            .collect::<io::Result<Vec<_>>>()?;
        let crls = self
            .crls
            .iter()
            .map(|path| {
                read_private(path).map_err(|error| credential_error("credential-file", error))
            })
            .collect::<io::Result<Vec<_>>>()?;
        let own_chain = self
            .certificate_chain
            .iter()
            .map(|path| {
                read_private(path).map_err(|error| credential_error("credential-file", error))
            })
            .collect::<io::Result<Vec<_>>>()?;
        let key = read_private(&self.private_key)
            .map_err(|error| credential_error("private-key", error))?;
        let trust = Trust::from_der(roots, crls)
            .map_err(|error| credential_error("trust-or-crl", error))?;
        let own_policy = Policy::new(trust.clone(), own_machine)
            .map_err(|error| credential_error("identity", error))?;
        let expires_at = own_policy
            .credential_expiry(&own_chain, unix_now()?)
            .map_err(|error| credential_error("leaf-or-crl-invalid", error))?;
        let peer_policy = Policy::new(trust.clone(), &self.machine_id)
            .map_err(|error| credential_error("identity", error))?;
        let crypto = match self.endpoint {
            Endpoint::Connect { .. } => Crypto::Connect(Arc::new(
                peer_policy
                    .client_config(own_chain.clone(), key)
                    .map_err(|error| credential_error("key-or-chain", error))?,
            )),
            Endpoint::Listen { .. } => Crypto::Listen(Arc::new(
                peer_policy
                    .server_config(own_chain.clone(), key)
                    .map_err(|error| credential_error("key-or-chain", error))?,
            )),
        };
        let mut issuers = own_chain.clone();
        for path in &self.issuer_certificates {
            issuers
                .push(read_private(path).map_err(|error| credential_error("issuer-file", error))?);
        }
        trust
            .validate_revocation_bundle(&issuers, unix_now()?)
            .map_err(|error| credential_error("crl-invalid", error))?;
        let mut floors = (if mode == Preparation::Commit {
            FloorStore::open(&revocation_state)
        } else {
            FloorStore::snapshot(&revocation_state)
        })
        .map_err(|error| credential_error("revocation-floor-unavailable", error))?;
        // Installing a CRL that rejects every peer must still protect its floor.
        // Do this before listener binding/readiness, never only after a successful peer.
        if mode == Preparation::Commit {
            floors.apply(&trust)
        } else {
            floors.check(&trust)
        }
        .map_err(|error| credential_error("revocation-floor-rejected", error))?;
        Ok(Prepared {
            machine_id: self.machine_id,
            endpoint: self.endpoint,
            crypto,
            trusted: Trusted::Certificates(Box::new(Certificates {
                trust,
                own_policy,
                peer_policy,
                own_chain,
                expires_at,
                floors: Arc::new(Mutex::new(floors)),
                persistence: Arc::new(Semaphore::new(1)),
            })),
        })
    }

    /// Loads the own Ed25519 key and pins the configured peer key; no other state exists.
    fn prepare_pinned(&self, peer: &str) -> io::Result<Prepared> {
        let peer = crate::keys::parse_public(peer).ok_or_else(rejected)?;
        let key = read_private(&self.private_key)
            .map_err(|error| credential_error("private-key", error))?;
        let own = crate::keys::public_key(&key)
            .map_err(|error| credential_error("private-key", error))?;
        // Pinning our own key would let a reflected connection authenticate as the peer.
        if own == peer {
            return Err(credential_error("identity", rejected()));
        }
        let crypto = match self.endpoint {
            Endpoint::Connect { .. } => Crypto::Connect(Arc::new(
                crate::pinned::client_config(key, &peer)
                    .map_err(|error| credential_error("private-key", error))?,
            )),
            Endpoint::Listen { .. } => Crypto::Listen(Arc::new(
                crate::pinned::server_config(key, &peer)
                    .map_err(|error| credential_error("private-key", error))?,
            )),
        };
        Ok(Prepared {
            machine_id: self.machine_id.clone(),
            endpoint: self.endpoint,
            crypto,
            trusted: Trusted::Pinned(own),
        })
    }
}
impl Prepared {
    /// The read-only `--diagnose` view of prepared credentials.
    pub(crate) fn diagnostic(&self) -> io::Result<serde_json::Value> {
        Ok(match &self.trusted {
            Trusted::Certificates(certificates) => {
                let expires_at = certificates.expires_at;
                let warning = expires_at.saturating_sub(unix_now()?) <= 7 * 86400;
                serde_json::json!({"state":"configured","credentialExpiresAt":expires_at,"expiryWarning":warning})
            }
            Trusted::Pinned(own) => {
                serde_json::json!({"state":"configured","trust":"pinned","publicKey":crate::keys::hex(own)})
            }
        })
    }
    /// Returns the operator-selected single-pair connection role/address.
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }

    /// Performs one TCP/TLS/floor-commit attempt under one five-second deadline.
    ///
    /// No retry loop is hidden here. The caller must enforce the C7 connection,
    /// pending-handshake and reconnect-episode limits before starting this future.
    ///
    /// # Errors
    /// Rejects listener-role misuse, transport/TLS/policy failures, busy floor commit,
    /// rollback and deadline expiry. Failure never installs a runtime route.
    pub async fn connect(&self) -> io::Result<Authenticated> {
        let (Endpoint::Connect { address }, Crypto::Connect(config)) =
            (self.endpoint, &self.crypto)
        else {
            return Err(rejected());
        };
        let deadline = Instant::now() + HANDSHAKE;
        tokio::time::timeout_at(deadline, async {
            let stream = TcpStream::connect(address).await?;
            let name = ServerName::try_from(format!("gateway.{}.pi.internal", self.machine_id))
                .map_err(io::Error::other)?;
            let stream = TlsConnector::from(Arc::clone(config))
                .connect(name, stream)
                .await?;
            self.authorize(TlsStream::Client(stream)).await
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Authenticates one accepted TCP stream under one five-second handshake/commit deadline.
    ///
    /// # Errors
    /// Rejects initiator-role misuse and the same authentication/commit failures as
    /// [`Self::connect`]. The caller must bound accepted handshake tasks before invocation.
    pub async fn accept(&self, stream: TcpStream) -> io::Result<Authenticated> {
        let Crypto::Listen(config) = &self.crypto else {
            return Err(rejected());
        };
        tokio::time::timeout(HANDSHAKE, async {
            let stream = TlsAcceptor::from(Arc::clone(config)).accept(stream).await?;
            self.authorize(TlsStream::Server(stream)).await
        })
        .await
        .map_err(io::Error::other)?
    }

    async fn authorize(&self, stream: TlsStream<TcpStream>) -> io::Result<Authenticated> {
        let common = stream.get_ref().1;
        if common.is_handshaking() || common.peer_certificates().is_none() {
            return Err(rejected());
        }
        let certificates = match &self.trusted {
            // The verifier accepted exactly the pinned key; nothing about it expires.
            Trusted::Pinned(_) => {
                return Ok(Authenticated {
                    stream,
                    lease: LinkLease::unbounded(),
                });
            }
            Trusted::Certificates(certificates) => certificates,
        };
        let chain: Vec<_> = common
            .peer_certificates()
            .ok_or_else(rejected)?
            .iter()
            .map(|certificate| certificate.to_vec())
            .collect();
        certificates
            .peer_policy
            .credential_expiry(&chain, unix_now()?)
            .map_err(io::Error::other)?;
        // The permit lives inside the blocking job, even if its awaiter times out.
        // A stuck filesystem can therefore never create an unbounded blocking waitlist.
        let permit = Arc::clone(&certificates.persistence)
            .try_acquire_owned()
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "revocation commit busy"))?;
        let floors = Arc::clone(&certificates.floors);
        let trust = certificates.trust.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            floors
                .lock()
                .expect("revocation floor lock poisoned")
                .apply(&trust)
        })
        .await
        .map_err(io::Error::other)??;
        let now = unix_now()?;
        let peer = certificates
            .peer_policy
            .credential_expiry(&chain, now)
            .map_err(io::Error::other)?;
        let own = certificates
            .own_policy
            .credential_expiry(&certificates.own_chain, now)
            .map_err(io::Error::other)?;
        let lease = LinkLease::new(own, peer, SystemTime::now()).map_err(io::Error::other)?;
        Ok(Authenticated { stream, lease })
    }
}
fn unix_now() -> io::Result<u64> {
    Ok(SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs())
}
fn machine(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn rejected() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "remote credentials rejected",
    )
}
pub(crate) fn read_private(path: &Path) -> io::Result<Vec<u8>> {
    crate::paths::private_parent(path)?;
    let parent = path.parent().ok_or_else(rejected)?;
    if !path.is_absolute() || parent.canonicalize()? != parent {
        return Err(rejected());
    }
    let directory = std::fs::metadata(parent)?;
    let uid = rustix::process::geteuid().as_raw();
    if directory.uid() != uid || directory.mode() & 0o077 != 0 || !directory.is_dir() {
        return Err(rejected());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
                .bits()
                .cast_signed(),
        )
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(rejected());
    }
    let mut bytes = Vec::new();
    file.take(65_537).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() > 65_536 {
        return Err(rejected());
    }
    Ok(bytes)
}

#[derive(Debug)]
struct CredentialFailure {
    reason: &'static str,
    source: Box<dyn std::error::Error + Send + Sync>,
}
impl fmt::Display for CredentialFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason)
    }
}
impl std::error::Error for CredentialFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}
fn credential_error(
    reason: &'static str,
    source: impl std::error::Error + Send + Sync + 'static,
) -> io::Error {
    io::Error::other(CredentialFailure {
        reason,
        source: Box::new(source),
    })
}
pub(crate) fn degradation(error: &io::Error) -> Option<&'static str> {
    error
        .get_ref()?
        .downcast_ref::<CredentialFailure>()
        .map(|failure| failure.reason)
}

// Only known operational errors from the TCP bind call degrade remote startup.
// Descriptor exhaustion, invalid arguments and subsequent listener setup defects
// remain fatal; diagnostics never call this or attempt a bind.
pub(crate) fn listen_error(error: io::Error) -> io::Error {
    match error.kind() {
        io::ErrorKind::AddrInUse
        | io::ErrorKind::AddrNotAvailable
        | io::ErrorKind::PermissionDenied => credential_error("remote-listen-unavailable", error),
        _ => error,
    }
}

#[cfg(test)]
mod listen_tests {
    use super::*;
    #[test]
    fn only_known_bind_failures_degrade() {
        for kind in [
            io::ErrorKind::AddrInUse,
            io::ErrorKind::AddrNotAvailable,
            io::ErrorKind::PermissionDenied,
        ] {
            assert_eq!(
                degradation(&listen_error(io::Error::from(kind))),
                Some("remote-listen-unavailable")
            );
        }
        for kind in [
            io::ErrorKind::InvalidInput,
            io::ErrorKind::OutOfMemory,
            io::ErrorKind::Other,
        ] {
            let error = listen_error(io::Error::from(kind));
            assert_eq!(error.kind(), kind);
            assert_eq!(degradation(&error), None);
        }
    }
}
