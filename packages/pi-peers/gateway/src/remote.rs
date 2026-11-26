//! Pinned-key remote settings, owner-only key loading and bounded TLS handshakes.
//!
//! Every path is explicitly supplied, owner-only and opened without following a leaf symlink.
//! The peer is identified only by the one Ed25519 public key the operator pinned.
use std::fmt;
use std::fs::OpenOptions;
use std::io::{self, Read};
use std::net::SocketAddr;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio::time::Instant;
use tokio_rustls::{TlsAcceptor, TlsConnector, TlsStream};

use crate::keys::PUBLIC_KEY_LEN;
use crate::wire::{self, Role};

const HANDSHAKE: Duration = Duration::from_secs(5);

/// Exactly one configured outbound initiator or inbound listener for the pair.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
#[non_exhaustive]
pub enum Endpoint {
    /// Initiates a TLS connection to this address; identity remains the pinned key.
    Connect {
        /// Explicit IP dial address, never an identity substitute.
        address: SocketAddr,
    },
    /// Accepts streams from this operator-selected listening address.
    Listen {
        /// Explicit local IP listener address.
        address: SocketAddr,
    },
}

/// Strict explicit single-peer daemon settings: one own key and one pinned peer key.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    machine_id: String,
    endpoint: Endpoint,
    private_key: PathBuf,
    peer_public_key: String,
}
impl fmt::Debug for Settings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Settings")
            .field("machine_id", &self.machine_id)
            .field("endpoint", &self.endpoint)
            .field("private_key", &"<redacted>")
            .field("peer_public_key", &self.peer_public_key)
            .finish()
    }
}

#[derive(Debug)]
enum Crypto {
    Connect(Arc<rustls::ClientConfig>),
    Listen(Arc<rustls::ServerConfig>),
}

/// Prepared TLS configuration for one configured peer.
pub struct Prepared {
    machine_id: String,
    endpoint: Endpoint,
    crypto: Crypto,
    own: [u8; PUBLIC_KEY_LEN],
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

/// A completed mutual TLS handshake with the pinned peer key.
#[derive(Debug)]
pub struct Authenticated {
    stream: TlsStream<TcpStream>,
}
impl Authenticated {
    /// Transfers the authenticated stream to the bounded route owner. No routes are installed here.
    pub fn into_stream(self) -> TlsStream<TcpStream> {
        self.stream
    }
}

impl Settings {
    /// Parses bounded strict JSON without reading files or connecting to any address.
    ///
    /// # Errors
    /// Rejects ambiguous JSON, unknown fields (including every retired certificate field),
    /// an invalid machine identity, a relative key path and malformed public key text.
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
        if !machine(&self.machine_id)
            || !self.private_key.is_absolute()
            || crate::keys::parse_public(&self.peer_public_key).is_none()
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

    /// Loads the own Ed25519 key and pins the configured peer key; reads nothing else.
    ///
    /// Startup file reads are bounded; this does not start a socket listener or daemon.
    ///
    /// # Errors
    /// Rejects an unsafe or unusable key file and a peer key equal to the own key.
    pub fn prepare(self) -> io::Result<Prepared> {
        let peer = crate::keys::parse_public(&self.peer_public_key).ok_or_else(rejected)?;
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
            machine_id: self.machine_id,
            endpoint: self.endpoint,
            crypto,
            own,
        })
    }
}
impl Prepared {
    /// The read-only `--diagnose` view of prepared credentials.
    pub(crate) fn diagnostic(&self) -> serde_json::Value {
        serde_json::json!({"state":"configured","trust":"pinned","publicKey":crate::keys::hex(&self.own)})
    }
    /// Returns the operator-selected single-pair connection role/address.
    pub fn endpoint(&self) -> Endpoint {
        self.endpoint
    }

    /// Performs one TCP/TLS attempt under one five-second deadline.
    ///
    /// No retry loop is hidden here. The caller must enforce the C7 connection,
    /// pending-handshake and reconnect-episode limits before starting this future.
    ///
    /// # Errors
    /// Rejects listener-role misuse, transport/TLS failures, any key but the pinned one
    /// and deadline expiry. Failure never installs a runtime route.
    pub async fn connect(&self) -> io::Result<Authenticated> {
        let (Endpoint::Connect { address }, Crypto::Connect(config)) =
            (self.endpoint, &self.crypto)
        else {
            return Err(rejected());
        };
        let deadline = Instant::now() + HANDSHAKE;
        tokio::time::timeout_at(deadline, async {
            let stream = TcpStream::connect(address).await?;
            // Raw public keys carry no name; SNI is disabled and this name is never checked.
            let name = ServerName::try_from(format!("gateway.{}.pi.internal", self.machine_id))
                .map_err(io::Error::other)?;
            let stream = TlsConnector::from(Arc::clone(config))
                .connect(name, stream)
                .await?;
            authorize(TlsStream::Client(stream))
        })
        .await
        .map_err(io::Error::other)?
    }

    /// Authenticates one accepted TCP stream under one five-second handshake deadline.
    ///
    /// # Errors
    /// Rejects initiator-role misuse and the same authentication failures as
    /// [`Self::connect`]. The caller must bound accepted handshake tasks before invocation.
    pub async fn accept(&self, stream: TcpStream) -> io::Result<Authenticated> {
        let Crypto::Listen(config) = &self.crypto else {
            return Err(rejected());
        };
        tokio::time::timeout(HANDSHAKE, async {
            let stream = TlsAcceptor::from(Arc::clone(config)).accept(stream).await?;
            authorize(TlsStream::Server(stream))
        })
        .await
        .map_err(io::Error::other)?
    }
}
/// The handshake verifiers already accepted exactly the pinned key; nothing about it expires.
fn authorize(stream: TlsStream<TcpStream>) -> io::Result<Authenticated> {
    let common = stream.get_ref().1;
    if common.is_handshaking() || common.peer_certificates().is_none() {
        return Err(rejected());
    }
    Ok(Authenticated { stream })
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
