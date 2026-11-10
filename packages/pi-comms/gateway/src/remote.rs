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
    root_certificates: Vec<PathBuf>,
    certificate_chain: Vec<PathBuf>,
    #[serde(default)]
    issuer_certificates: Vec<PathBuf>,
    private_key: PathBuf,
    crls: Vec<PathBuf>,
    revocation_state: PathBuf,
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

#[derive(Debug)]
enum Crypto {
    Connect(Arc<rustls::ClientConfig>),
    Listen(Arc<rustls::ServerConfig>),
}

/// Prepared credentials with one bounded persistence job and an exclusive floor-store lock.
pub struct Prepared {
    machine_id: String,
    endpoint: Endpoint,
    crypto: Crypto,
    trust: Trust,
    own_policy: Policy,
    peer_policy: Policy,
    own_chain: Vec<Vec<u8>>,
    floors: Arc<Mutex<FloorStore>>,
    persistence: Arc<Semaphore>,
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
        if self.root_certificates.is_empty()
            || self.root_certificates.len() > 4
            || self.certificate_chain.is_empty()
            || self.certificate_chain.len() > 8
            || self.issuer_certificates.len() > 8
            || self.crls.is_empty()
            || self.crls.len() > 16
            || self.machine_id.is_empty()
            || self.machine_id.len() > 32
            || !self.machine_id.as_bytes()[0].is_ascii_lowercase()
            || !self
                .machine_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || self
                .root_certificates
                .iter()
                .chain(&self.certificate_chain)
                .chain(&self.issuer_certificates)
                .chain(&self.crls)
                .chain([&self.private_key, &self.revocation_state])
                .any(|path| !path.is_absolute())
        {
            return Err(rejected());
        }
        // Port 0 asks the OS for an ephemeral listener port, reported at readiness. It is
        // never a valid destination, so a connecting endpoint must name a real port.
        if matches!(self.endpoint, Endpoint::Connect { address } if address.port() == 0) {
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
        let roots = self
            .root_certificates
            .iter()
            .map(|path| read_private(path))
            .collect::<io::Result<Vec<_>>>()?;
        let crls = self
            .crls
            .iter()
            .map(|path| read_private(path))
            .collect::<io::Result<Vec<_>>>()?;
        let own_chain = self
            .certificate_chain
            .iter()
            .map(|path| read_private(path))
            .collect::<io::Result<Vec<_>>>()?;
        let key = read_private(&self.private_key)?;
        let trust = Trust::from_der(roots, crls).map_err(io::Error::other)?;
        let own_policy = Policy::new(trust.clone(), own_machine).map_err(io::Error::other)?;
        own_policy
            .credential_expiry(&own_chain, unix_now()?)
            .map_err(io::Error::other)?;
        let peer_policy = Policy::new(trust.clone(), &self.machine_id).map_err(io::Error::other)?;
        let crypto = match self.endpoint {
            Endpoint::Connect { .. } => Crypto::Connect(Arc::new(
                peer_policy
                    .client_config(own_chain.clone(), key)
                    .map_err(io::Error::other)?,
            )),
            Endpoint::Listen { .. } => Crypto::Listen(Arc::new(
                peer_policy
                    .server_config(own_chain.clone(), key)
                    .map_err(io::Error::other)?,
            )),
        };
        let mut issuers = own_chain.clone();
        for path in &self.issuer_certificates {
            issuers.push(read_private(path)?);
        }
        trust
            .validate_revocation_bundle(&issuers, unix_now()?)
            .map_err(io::Error::other)?;
        let mut floors = FloorStore::open(&self.revocation_state)?;
        // Installing a CRL that rejects every peer must still protect its floor.
        // Do this before listener binding/readiness, never only after a successful peer.
        floors.apply(&trust)?;
        Ok(Prepared {
            machine_id: self.machine_id,
            endpoint: self.endpoint,
            crypto,
            trust,
            own_policy,
            peer_policy,
            own_chain,
            floors: Arc::new(Mutex::new(floors)),
            persistence: Arc::new(Semaphore::new(1)),
        })
    }
}
impl Prepared {
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
        if common.is_handshaking() {
            return Err(rejected());
        }
        let chain: Vec<_> = common
            .peer_certificates()
            .ok_or_else(rejected)?
            .iter()
            .map(|certificate| certificate.to_vec())
            .collect();
        self.peer_policy
            .credential_expiry(&chain, unix_now()?)
            .map_err(io::Error::other)?;
        // The permit lives inside the blocking job, even if its awaiter times out.
        // A stuck filesystem can therefore never create an unbounded blocking waitlist.
        let permit = Arc::clone(&self.persistence)
            .try_acquire_owned()
            .map_err(|_| io::Error::new(io::ErrorKind::WouldBlock, "revocation commit busy"))?;
        let floors = Arc::clone(&self.floors);
        let trust = self.trust.clone();
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
        let peer = self
            .peer_policy
            .credential_expiry(&chain, now)
            .map_err(io::Error::other)?;
        let own = self
            .own_policy
            .credential_expiry(&self.own_chain, now)
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
fn rejected() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "remote credentials rejected",
    )
}
fn read_private(path: &Path) -> io::Result<Vec<u8>> {
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
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits().cast_signed())
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
