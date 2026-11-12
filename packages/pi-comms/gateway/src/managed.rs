//! Opt-in on-demand ownership. No PID files, process polling or wire extensions.
//!
//! The private lock file is permanent: never unlink it (that would split the lock).
//! An interrupted ownership-record write fails closed. Only an exact recorded socket
//! incarnation may be recovered, while holding the same lifetime lock.
//!
//! Live-owner safety comes from the lifetime flock, not connection refusal:
//! Darwin can refuse a live listener with a saturated backlog. This process
//! never forks or transfers its listener, and keeps the guard until the daemon
//! drops. A stopped/live managed owner therefore still holds the lock. Unknown
//! or replaced sockets fail the durable incarnation check before any probe.
//! Like the socket directory, the record trusts the current Unix account: an
//! account process deliberately forging records is outside this boundary.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rustix::fs::{FlockOperation, OFlags, flock};
use serde::{Deserialize, Serialize};

use crate::{config::Config, daemon::Daemon};

/// Maximum idle startup interval before the first successful local registration.
pub const STARTUP_GRACE: Duration = Duration::from_secs(10);
/// Reload/reconnect handoff interval after the last local participant disappears.
pub const DISCONNECT_GRACE: Duration = Duration::from_millis(750);

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    socket: PathBuf,
    device: u64,
    inode: u64,
    changed: i64,
    changed_ns: i64,
}
impl Record {
    fn read(socket: &Path) -> io::Result<Self> {
        let metadata = std::fs::symlink_metadata(socket)?;
        if !metadata.file_type().is_socket() {
            return Err(io::Error::other("managed path is not a socket"));
        }
        Ok(Self {
            socket: socket.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
            changed: metadata.ctime(),
            changed_ns: metadata.ctime_nsec(),
        })
    }
    fn matches(&self, other: &Self) -> bool {
        self.socket == other.socket
            && self.device == other.device
            && self.inode == other.inode
            && self.changed == other.changed
            && self.changed_ns == other.changed_ns
    }
}

/// Lifetime lock for a managed daemon. Keep alive until the daemon has stopped.
#[derive(Debug)]
pub struct ManagedGuard {
    file: File,
}
impl ManagedGuard {
    /// Locks before any remote preparation, recovers only recorded dead sockets,
    /// then binds and durably records this daemon's socket incarnation.
    ///
    /// # Errors
    /// Fails on contention, unsafe files, unknown/live sockets, ambiguous records,
    /// failed durability operations, or ordinary daemon bind errors.
    pub fn bind(config: Config) -> io::Result<(Daemon, Self)> {
        let mut guard = Self::acquire(&config.socket_path)?;
        let daemon = Daemon::bind(config)?;
        let record = Record::read(daemon.socket_path())?;
        let bytes = serde_json::to_vec(&record)?;
        guard.file.seek(SeekFrom::Start(0))?;
        guard.file.set_len(0)?;
        guard.file.write_all(&bytes)?;
        guard.file.sync_all()?;
        // Persist the socket and initial lock directory entries as well.
        File::open(
            daemon
                .socket_path()
                .parent()
                .ok_or_else(|| io::Error::other("missing parent"))?,
        )?
        .sync_all()?;
        Ok((daemon, guard))
    }

    fn acquire(socket: &Path) -> io::Result<Self> {
        crate::paths::private_parent(socket)?;
        let mut name = socket.as_os_str().to_owned();
        name.push(".managed.lock");
        let path = PathBuf::from(name);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(
                OFlags::NOFOLLOW
                    .bits()
                    .try_into()
                    .map_err(io::Error::other)?,
            )
            .open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.nlink() != 1
        {
            return Err(io::Error::other("unsafe managed lock file"));
        }
        flock(&file, FlockOperation::NonBlockingLockExclusive)?;
        let named = std::fs::symlink_metadata(&path)?;
        if named.dev() != metadata.dev() || named.ino() != metadata.ino() {
            return Err(io::Error::other("managed lock path changed"));
        }
        let mut bytes = Vec::new();
        (&mut file).take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(io::Error::other("oversized managed ownership record"));
        }
        // A nonempty corrupt record is ambiguous even if the socket is absent.
        let record: Option<Record> = if bytes.is_empty() {
            None
        } else {
            Some(serde_json::from_slice(&bytes).map_err(io::Error::other)?)
        };
        match Record::read(socket) {
            Ok(actual) => {
                if !record
                    .as_ref()
                    .is_some_and(|record| record.matches(&actual))
                {
                    return Err(io::Error::other("socket is not recorded managed ownership"));
                }
                // Never block on a live listener's saturated backlog while holding
                // the lifetime lock. EINPROGRESS/EAGAIN and all other ambiguous
                // outcomes fail closed. Only immediate ECONNREFUSED permits recovery,
                // after the lifetime-lock and recorded-incarnation proofs above.
                let probe = rustix::net::socket(
                    rustix::net::AddressFamily::UNIX,
                    rustix::net::SocketType::STREAM,
                    None,
                )?;
                rustix::fs::fcntl_setfl(&probe, OFlags::NONBLOCK)?;
                rustix::io::fcntl_setfd(&probe, rustix::io::FdFlags::CLOEXEC)?;
                let address = rustix::net::SocketAddrUnix::new(socket)?;
                match rustix::net::connect(&probe, &address) {
                    Err(rustix::io::Errno::CONNREFUSED) => {}
                    _ => return Err(io::Error::other("managed socket is live or ambiguous")),
                }
                if !actual.matches(&Record::read(socket)?) {
                    return Err(io::Error::other("managed socket changed during recovery"));
                }
                std::fs::remove_file(socket)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(Self { file })
    }
}
