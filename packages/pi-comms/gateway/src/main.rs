//! Explicit foreground gateway CLI; it never installs or starts a background service.
use std::io;
use std::io::Write;
use std::path::PathBuf;

use pi_gateway::config::Config;
use pi_gateway::daemon::Daemon;

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let command = arguments.next();
    if !matches!(
        command.as_deref().and_then(|value| value.to_str()),
        Some("--config" | "--initialize-revocation-floor")
    ) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: pi-gateway --config <absolute-path> | --initialize-revocation-floor <absolute-path>",
        ));
    }
    let path = PathBuf::from(
        arguments
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing config path"))?,
    );
    if arguments.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unexpected argument",
        ));
    }
    if command.as_deref() == Some(std::ffi::OsStr::new("--initialize-revocation-floor")) {
        drop(pi_gateway::revocation::FloorStore::initialize(&path)?);
        return Ok(());
    }
    let config = Config::read(&path).map_err(io::Error::other)?;
    let daemon = Daemon::bind(config)?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut stdout = io::stdout().lock();
    let mut ready = serde_json::json!({"event":"ready","socketPath":daemon.socket_path(),"machineId":daemon.machine_id()});
    if let Some(address) = daemon.remote_listen_address() {
        // The bound address, so a configured port 0 is reported as the port the OS chose.
        ready["remoteListenAddress"] = serde_json::Value::String(address.to_string());
    }
    serde_json::to_writer(&mut stdout, &ready)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    drop(stdout);
    daemon
        .run(async move {
            tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
        })
        .await
}
