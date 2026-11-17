//! Explicit local maintenance helpers. No PID signalling, socket unlink or retry.
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Holds a permanent private setup flock while the caller keeps stdin open.
///
/// # Errors
/// Rejects unsafe paths/files, contention, identity replacement and I/O failures.
pub fn setup_lock(path: &Path) -> io::Result<()> {
    crate::paths::private_parent(path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
                .bits()
                .cast_signed(),
        )
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != rustix::process::geteuid().as_raw()
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
    {
        return Err(io::Error::other("unsafe setup lock"));
    }
    rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive)?;
    let named = std::fs::symlink_metadata(path)?;
    if named.dev() != meta.dev() || named.ino() != meta.ino() {
        return Err(io::Error::other("setup lock changed"));
    }
    file.sync_all()?;
    File::open(
        path.parent()
            .ok_or_else(|| io::Error::other("missing parent"))?,
    )?
    .sync_all()?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &json!({"version":1,"state":"locked"}))?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    drop(stdout);
    let mut buffer = [0; 4096];
    while io::stdin().read(&mut buffer)? != 0 {}
    drop(file);
    Ok(())
}

/// Requests one machine-bound managed restart, requiring exact acknowledgement and EOF.
///
/// # Errors
/// Any error may represent an uncertain outcome. Caller must reconnect and inspect;
/// this function never retries or treats a path/PID as ownership proof.
pub async fn request_restart(config: &crate::config::Config) -> io::Result<()> {
    crate::paths::private_parent(&config.socket_path)?;
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut stream = tokio::net::UnixStream::connect(&config.socket_path).await?;
        if stream.peer_cred()?.uid() != rustix::process::geteuid().as_raw() { return Err(io::Error::other("restart peer owner mismatch")); }
        let mut nonce = [0; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce).map_err(|_| io::Error::other("restart nonce unavailable"))?;
        let rid = nonce.iter().fold(String::new(), |mut output, byte| { use std::fmt::Write; write!(output,"{byte:02x}").expect("writing to String"); output });
        let body = serde_json::to_vec(&json!({"v":1,"op":"gateway.restart","rid":rid,"expectedMachineId":config.machine_id}))?;
        stream.write_all(&u32::try_from(body.len()).map_err(io::Error::other)?.to_be_bytes()).await?;
        stream.write_all(&body).await?;
        let length = stream.read_u32().await?;
        let length = crate::wire::body_length(length.to_be_bytes()).map_err(io::Error::other)?;
        let mut body = vec![0;length];
        stream.read_exact(&mut body).await?;
        let value = crate::wire::decode_body(&body, crate::wire::Role::LocalClient).map_err(io::Error::other)?;
        if value != json!({"v":1,"op":"result","rid":rid,"forOp":"gateway.restart","outcome":{"tag":"ok","value":{}}}) { return Err(io::Error::other("restart acknowledgement mismatch; outcome uncertain")); }
        if stream.read(&mut [0;1]).await? != 0 { return Err(io::Error::other("restart did not close; outcome uncertain")); }
        Ok(())
    }).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut,"restart outcome uncertain; reconnect and inspect, do not blindly retry"))?
}
