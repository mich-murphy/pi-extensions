//! Explicit foreground gateway CLI; it never installs or starts a background service.
use std::io;
use std::io::Write;
use std::path::PathBuf;

use pi_gateway::config::Config;
use pi_gateway::daemon::Daemon;

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let mut command = arguments.next();
    if command.as_deref() == Some(std::ffi::OsStr::new("--version")) {
        let json = arguments.next();
        if arguments.next().is_some() || json.as_deref().is_some_and(|arg| arg != "--json") {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "usage: pi-gateway --version [--json]",
            ));
        }
        let mut stdout = io::stdout().lock();
        if json.is_some() {
            serde_json::to_writer(
                &mut stdout,
                &serde_json::json!({"name":"pi-gateway","version":env!("CARGO_PKG_VERSION"),"wireVersions":[1],"capabilities":["managed-on-demand-v1"]}),
            )?;
        } else {
            write!(stdout, "pi-gateway {}", env!("CARGO_PKG_VERSION"))?;
        }
        return stdout.write_all(b"\n");
    }
    let managed = command.as_deref() == Some(std::ffi::OsStr::new("--managed"));
    if managed {
        command = arguments.next();
    }
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
    if managed && command.as_deref() != Some(std::ffi::OsStr::new("--config")) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "--managed requires --config",
        ));
    }
    if command.as_deref() == Some(std::ffi::OsStr::new("--initialize-revocation-floor")) {
        drop(pi_gateway::revocation::FloorStore::initialize(&path)?);
        return Ok(());
    }
    let config = Config::read(&path).map_err(io::Error::other)?;
    let (daemon, _managed_guard) = if managed {
        let (daemon, guard) = pi_gateway::managed::ManagedGuard::bind(config)?;
        (daemon, Some(guard))
    } else {
        (Daemon::bind(config)?, None)
    };
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
    let shutdown = async move {
        tokio::select! { _ = terminate.recv() => {}, _ = interrupt.recv() => {} }
    };
    if managed {
        daemon.run_managed(shutdown).await
    } else {
        daemon.run(shutdown).await
    }
}
