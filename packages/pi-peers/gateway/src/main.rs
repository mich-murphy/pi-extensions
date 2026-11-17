//! Explicit foreground gateway CLI; it never installs or starts a background service.
use std::io;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
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
                &serde_json::json!({"name":"pi-gateway","version":env!("CARGO_PKG_VERSION"),"wireVersions":[1],"capabilities":["managed-on-demand-v1","pairing-v1","gateway-control-v1","setup-lock-v1","config-generation-v1"]}),
            )?;
        } else {
            write!(stdout, "pi-gateway {}", env!("CARGO_PKG_VERSION"))?;
        }
        return stdout.write_all(b"\n");
    }
    if command.as_deref() == Some(std::ffi::OsStr::new("pair")) {
        return pair(arguments);
    }
    let managed = command.as_deref() == Some(std::ffi::OsStr::new("--managed"));
    if managed {
        command = arguments.next();
    }
    if !matches!(
        command.as_deref().and_then(|value| value.to_str()),
        Some(
            "--config"
                | "--initialize-revocation-floor"
                | "--diagnose"
                | "--request-restart"
                | "--setup-lock"
        )
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
    if command.as_deref() == Some(std::ffi::OsStr::new("--setup-lock")) {
        return pi_gateway::control::setup_lock(&path);
    }
    let config = Config::read(&path).map_err(io::Error::other)?;
    if command.as_deref() == Some(std::ffi::OsStr::new("--request-restart")) {
        pi_gateway::control::request_restart(&config).await?;
        serde_json::to_writer(
            io::stdout().lock(),
            &serde_json::json!({"version":1,"state":"restart-requested"}),
        )?;
        return io::stdout().write_all(b"\n");
    }
    if command.as_deref() == Some(std::ffi::OsStr::new("--diagnose")) {
        serde_json::to_writer(io::stdout().lock(), &config.diagnose()?)?;
        return io::stdout().write_all(b"\n");
    }
    serve(config, if managed { Mode::Managed } else { Mode::Manual }).await
}

enum Mode {
    Managed,
    Manual,
}
async fn serve(config: Config, mode: Mode) -> io::Result<()> {
    let managed = matches!(mode, Mode::Managed);
    let (daemon, _managed_guard) = if managed {
        let (daemon, guard) = pi_gateway::managed::ManagedGuard::bind(config)?;
        (daemon, Some(guard))
    } else {
        (Daemon::bind(config)?, None)
    };
    if let Some(reason) = daemon.remote_degraded_reason() {
        let _ = writeln!(io::stderr(), "remote degraded: {reason}");
    }
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

fn pair(mut arguments: impl Iterator<Item = std::ffi::OsString>) -> io::Result<()> {
    let operation = arguments
        .next()
        .and_then(|arg| arg.into_string().ok())
        .ok_or_else(|| io::Error::other("missing pair operation"))?;
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--input")) {
        return Err(io::Error::other("pair requires --input ABS_JSON"));
    }
    let path = PathBuf::from(
        arguments
            .next()
            .ok_or_else(|| io::Error::other("missing input path"))?,
    );
    if !path.is_absolute() || arguments.next().is_some() {
        return Err(io::Error::other(
            "pair requires one absolute JSON input path",
        ));
    }

    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK)
                .bits()
                .cast_signed(),
        )
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("pair input must be a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(32766).read_to_end(&mut bytes)?;
    let output = pi_gateway::pairing::execute(&operation, &bytes)?;
    serde_json::to_writer(io::stdout().lock(), &output)?;
    io::stdout().write_all(b"\n")
}
