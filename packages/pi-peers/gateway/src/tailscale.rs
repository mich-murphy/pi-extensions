//! The local Tailscale CLI as the only source of remote identity and capabilities.
//!
//! The CLI is run from a resolved absolute path whose every symlink, file and wrapper target
//! belongs to root or this user and is neither group- nor world-writable. Each call has a fixed
//! argv (an IP formatted here, never `ip:port`), an environment holding only a fixed system
//! `PATH`, a null stdin, a two-second kill of the whole process group and a 64 KiB stdout cap.
//! Any failure refuses: nothing here ever widens what a remote may do.
use std::collections::HashMap;
use std::io::{self, Read};
use std::net::IpAddr;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::io::AsyncReadExt;

use crate::caps::{self, Caps, Ignored};

/// Where the CLI is looked for when the configuration names none. `PATH` is never searched.
pub(crate) const PROBES: [&str; 6] = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
    "/run/current-system/sw/bin/tailscale",
    "/nix/var/nix/profiles/default/bin/tailscale",
];
const TIMEOUT: Duration = Duration::from_secs(2);
const MAX_OUTPUT: usize = 64 * 1024;
const MAX_STDERR: u64 = 4096;
const MAX_SCRIPT: u64 = 4096;
const MAX_LINKS: usize = 8;
/// The only environment variable a CLI call sees: root-owned system directories, so a wrapper
/// script or the CLI itself can still find tools such as `lsof`.
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
/// At most this many CLI processes at once, across link setup, refresh and diagnosis.
static CALLS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

/// Why a Tailscale lookup did not produce a usable answer. Every variant refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Failure {
    /// No trusted CLI binary.
    Missing,
    /// tailscaled is not running, or not logged in.
    NotRunning,
    /// whois knows no node for the address (HTTP 404 in the local API).
    NotFound,
    /// A timeout, oversized or malformed output, or any other non-zero exit.
    Error,
    /// whois answered, but this node may not link: the detail says why.
    Refused(&'static str),
}
impl Failure {
    /// The `--diagnose` degraded reason.
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::Missing => "tailscale-missing",
            Self::NotRunning => "tailscale-not-running",
            Self::NotFound | Self::Refused(_) => "not-tailnet-address",
            Self::Error => "tailscale-error",
        }
    }
    /// A short audit detail; it never contains output from the CLI.
    pub(crate) fn detail(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::NotRunning => "not-running",
            Self::NotFound => "not-found",
            Self::Error => "error",
            Self::Refused(detail) => detail,
        }
    }
}

/// This node, from `tailscale status --json --peers=false`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SelfNode {
    pub(crate) stable_id: String,
    /// First label of the `MagicDNS` name.
    pub(crate) name: String,
    pub(crate) addresses: Vec<IpAddr>,
    /// The tailnet's `MagicDNS` suffix, without dots at either end.
    pub(crate) suffix: String,
}

/// A remote node as whois reports it, already checked against this node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Peer {
    /// The IP whois was asked about; the link's peer address.
    pub(crate) ip: IpAddr,
    pub(crate) stable_id: String,
    /// The first label of its `MagicDNS` name: the `machineId` it routes as.
    pub(crate) machine_id: String,
    pub(crate) tags: Vec<String>,
    pub(crate) addresses: Vec<IpAddr>,
    /// What it may do to this node's sessions.
    pub(crate) caps: Caps,
    pub(crate) ignored: Ignored,
}

/// A trusted CLI binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Cli {
    program: PathBuf,
}

fn untrusted() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "untrusted tailscale CLI")
}
fn owner_ok(owner: u32, uid: u32) -> bool {
    owner == 0 || owner == uid
}

/// Resolves `path` to a trusted executable and returns its canonical path.
///
/// Every symlink on the way must belong to root or `uid`; the file must too and may be neither
/// group- nor world-writable. A `#!` script also has its interpreter and every absolute file it
/// names checked the same way, one level deep.
fn trusted(path: &Path, uid: u32, depth: u8) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(untrusted());
    }
    let mut current = path.to_path_buf();
    let mut links = 0;
    loop {
        let metadata = std::fs::symlink_metadata(&current)?;
        if !metadata.file_type().is_symlink() {
            break;
        }
        links += 1;
        if links > MAX_LINKS || !owner_ok(metadata.uid(), uid) {
            return Err(untrusted());
        }
        let target = std::fs::read_link(&current)?;
        current = if target.is_absolute() {
            target
        } else {
            current.parent().ok_or_else(untrusted)?.join(target)
        };
    }
    let program = std::fs::canonicalize(&current)?;
    let metadata = std::fs::metadata(&program)?;
    if !metadata.is_file()
        || !owner_ok(metadata.uid(), uid)
        || metadata.mode() & 0o022 != 0
        || metadata.mode() & 0o111 == 0
    {
        return Err(untrusted());
    }
    let mut file = std::fs::File::open(&program)?;
    let mut magic = [0_u8; 2];
    if file.read(&mut magic)? == 2 && magic == *b"#!" {
        if depth > 0 {
            return Err(untrusted());
        }
        let mut text = Vec::new();
        file.take(MAX_SCRIPT).read_to_end(&mut text)?;
        if text.len() >= usize::try_from(MAX_SCRIPT - 2).map_err(io::Error::other)? {
            return Err(untrusted());
        }
        let text = String::from_utf8(text).map_err(|_| untrusted())?;
        script(&text, uid, depth)?;
    }
    Ok(program)
}

/// Checks a wrapper script's interpreter and every absolute file path it mentions.
fn script(text: &str, uid: u32, depth: u8) -> io::Result<()> {
    let mut lines = text.lines();
    let interpreter = lines
        .next()
        .and_then(|line| line.split_whitespace().next())
        .ok_or_else(untrusted)?;
    trusted(Path::new(interpreter), uid, depth + 1)?;
    for line in lines.filter(|line| !line.trim_start().starts_with('#')) {
        for token in line
            .split(|c: char| c.is_whitespace() || "\"'`;=:(){}<>|&$".contains(c))
            .filter(|token| token.starts_with('/'))
        {
            if std::fs::metadata(token).is_ok_and(|metadata| metadata.is_file()) {
                trusted(Path::new(token), uid, depth + 1)?;
            }
        }
    }
    Ok(())
}

fn classify(stderr: &[u8]) -> Failure {
    let text = String::from_utf8_lossy(stderr);
    if text.contains("no match for IP") || text.contains("peer not found") {
        Failure::NotFound
    } else if text.contains("doesn't appear to be running")
        || text.contains("failed to connect to local tailscale")
    {
        Failure::NotRunning
    } else {
        Failure::Error
    }
}

impl Cli {
    /// The configured absolute path, or else the first probe that exists. Never `PATH`.
    pub(crate) fn resolve(configured: Option<&Path>) -> Result<Self, Failure> {
        let uid = rustix::process::geteuid().as_raw();
        let path = match configured {
            Some(path) => path,
            None => PROBES
                .iter()
                .map(Path::new)
                .find(|path| std::fs::symlink_metadata(path).is_ok())
                .ok_or(Failure::Missing)?,
        };
        trusted(path, uid, 0)
            .map(|program| Self { program })
            .map_err(|_| Failure::Missing)
    }

    async fn run(&self, args: &[&str]) -> Result<Vec<u8>, Failure> {
        let _permit = CALLS.acquire().await.map_err(|_| Failure::Error)?;
        let mut child = tokio::process::Command::new(&self.program)
            .args(args)
            .env_clear()
            .env("PATH", SYSTEM_PATH)
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0)
            .spawn()
            .map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    Failure::Missing
                } else {
                    Failure::Error
                }
            })?;
        let group = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .and_then(rustix::process::Pid::from_raw);
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err(Failure::Error);
        };
        let limit = u64::try_from(MAX_OUTPUT + 1).map_err(|_| Failure::Error)?;
        let finished = tokio::time::timeout(TIMEOUT, async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let (mut stdout, mut stderr) = (stdout.take(limit), stderr.take(MAX_STDERR));
            let (read_out, read_err) =
                tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
            read_out?;
            read_err?;
            let status = child.wait().await?;
            io::Result::Ok((status, out, err))
        })
        .await;
        let Ok(Ok((status, out, err))) = finished else {
            // A wrapper's child shares the group, so it cannot outlive the call either.
            if let Some(group) = group {
                let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
            }
            return Err(Failure::Error);
        };
        if !status.success() {
            return Err(classify(&err));
        }
        if out.len() > MAX_OUTPUT {
            return Err(Failure::Error);
        }
        Ok(out)
    }

    /// This node's identity; `NotRunning` unless the backend is `Running`.
    pub(crate) async fn status(&self) -> Result<SelfNode, Failure> {
        parse_status(&self.run(&["status", "--json", "--peers=false"]).await?)
    }

    /// The node behind `ip`, checked against this node and `own_machine`.
    pub(crate) async fn whois(
        &self,
        ip: IpAddr,
        own: &SelfNode,
        own_machine: &str,
    ) -> Result<Peer, Failure> {
        let ip = ip.to_canonical();
        if own.addresses.contains(&ip) {
            return Err(Failure::Refused("self"));
        }
        let address = ip.to_string();
        identify(
            &self.run(&["whois", "--json", &address]).await?,
            ip,
            own,
            own_machine,
        )
    }
}

#[derive(Deserialize)]
struct StatusJson {
    #[serde(rename = "BackendState")]
    backend_state: String,
    #[serde(rename = "Self")]
    own: Option<SelfJson>,
    #[serde(rename = "MagicDNSSuffix", default)]
    suffix: String,
    #[serde(rename = "CurrentTailnet")]
    tailnet: Option<TailnetJson>,
}
#[derive(Deserialize)]
struct SelfJson {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "DNSName")]
    dns_name: String,
    #[serde(rename = "TailscaleIPs")]
    addresses: Option<Vec<IpAddr>>,
}
#[derive(Deserialize)]
struct TailnetJson {
    #[serde(rename = "MagicDNSSuffix", default)]
    suffix: String,
}

fn label<'name>(name: &'name str, suffix: &str) -> Option<&'name str> {
    name.strip_suffix('.')?
        .strip_suffix(suffix)?
        .strip_suffix('.')
        .filter(|label| !label.is_empty() && !label.contains('.'))
}

pub(crate) fn parse_status(bytes: &[u8]) -> Result<SelfNode, Failure> {
    let status: StatusJson = serde_json::from_slice(bytes).map_err(|_| Failure::Error)?;
    if status.backend_state != "Running" {
        return Err(Failure::NotRunning);
    }
    let own = status.own.ok_or(Failure::Error)?;
    let suffix = status
        .tailnet
        .map(|tailnet| tailnet.suffix)
        .filter(|suffix| !suffix.is_empty())
        .unwrap_or(status.suffix);
    let suffix = suffix.trim_matches('.').to_owned();
    let addresses: Vec<IpAddr> = own
        .addresses
        .unwrap_or_default()
        .into_iter()
        .map(|ip| ip.to_canonical())
        .collect();
    let name = label(&own.dns_name, &suffix).ok_or(Failure::Error)?;
    if suffix.is_empty() || own.id.is_empty() || addresses.is_empty() {
        return Err(Failure::Error);
    }
    Ok(SelfNode {
        stable_id: own.id,
        name: name.to_owned(),
        addresses,
        suffix,
    })
}

#[derive(Deserialize)]
struct WhoisJson {
    #[serde(rename = "Node")]
    node: Option<NodeJson>,
    #[serde(rename = "CapMap")]
    cap_map: Option<HashMap<String, Box<RawValue>>>,
}
#[derive(Deserialize)]
struct NodeJson {
    #[serde(rename = "StableID")]
    stable_id: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Addresses")]
    addresses: Option<Vec<String>>,
    #[serde(rename = "Tags")]
    tags: Option<Vec<String>>,
    #[serde(rename = "Expired")]
    expired: Option<bool>,
}

/// One `Node.Addresses` entry: a single-host prefix such as `100.64.0.1/32`.
fn host(prefix: &str) -> Option<IpAddr> {
    let (address, length) = prefix.split_once('/')?;
    let address: IpAddr = address.parse().ok()?;
    let full = if address.is_ipv4() { "32" } else { "128" };
    (length == full).then(|| address.to_canonical())
}

/// Checks one whois answer for `ip` against this node; refuses rather than sanitises.
pub(crate) fn identify(
    bytes: &[u8],
    ip: IpAddr,
    own: &SelfNode,
    own_machine: &str,
) -> Result<Peer, Failure> {
    let whois: WhoisJson = serde_json::from_slice(bytes).map_err(|_| Failure::Error)?;
    let node = whois.node.ok_or(Failure::Error)?;
    let addresses = node
        .addresses
        .unwrap_or_default()
        .iter()
        .map(|prefix| host(prefix))
        .collect::<Option<Vec<_>>>()
        .ok_or(Failure::Refused("address"))?;
    if !addresses.contains(&ip) {
        return Err(Failure::Refused("address"));
    }
    if node.expired == Some(true) {
        return Err(Failure::Refused("expired"));
    }
    if node.stable_id.is_empty()
        || node.stable_id == own.stable_id
        || addresses
            .iter()
            .any(|address| own.addresses.contains(address))
    {
        return Err(Failure::Refused("self"));
    }
    let machine_id = label(&node.name, &own.suffix)
        .filter(|label| crate::config::machine(label) && *label != own_machine)
        .ok_or(Failure::Refused("name"))?;
    let raw = whois
        .cap_map
        .as_ref()
        .and_then(|map| map.get(caps::CAPABILITY))
        .map(AsRef::as_ref);
    let (caps, ignored) = Caps::parse(raw).map_err(|_| Failure::Refused("caps-bounds"))?;
    Ok(Peer {
        ip,
        stable_id: node.stable_id,
        machine_id: machine_id.to_owned(),
        tags: node.tags.unwrap_or_default(),
        addresses,
        caps,
        ignored,
    })
}

#[cfg(test)]
pub(crate) mod fake {
    //! A fake `tailscale` script for unit tests: owner-only, answering from files beside it.
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    pub(crate) const SCRIPT: &str = r#"#!/bin/sh
d=$(dirname "$0")
if [ -f "$d/delay" ]; then sleep "$(cat "$d/delay")"; fi
case "$1 $2 $3" in
"status --json --peers=false") f="$d/status.json" ;;
"whois --json "*) f="$d/whois-$3.json" ;;
*) echo "unexpected arguments" >&2; exit 2 ;;
esac
if [ -f "$f" ]; then cat "$f"; exit 0; fi
if [ -f "$d/stderr" ]; then cat "$d/stderr" >&2; else echo "no match for IP:port" >&2; fi
exit 1
"#;

    /// An owner-only directory holding the script `tailscale`, removed on drop.
    #[derive(Debug)]
    pub(crate) struct Fake(pub(crate) PathBuf);
    impl Fake {
        pub(crate) fn new(script: &str) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let directory = std::env::temp_dir()
                .canonicalize()
                .expect("canonical temporary directory")
                .join(format!(
                    "gw-ts-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            std::fs::create_dir(&directory).expect("fake directory");
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                .expect("owner-only fake directory");
            let fake = Self(directory);
            fake.write("tailscale", script);
            fake.mode("tailscale", 0o700);
            fake
        }
        pub(crate) fn program(&self) -> PathBuf {
            self.0.join("tailscale")
        }
        pub(crate) fn write(&self, name: &str, contents: &str) {
            std::fs::write(self.0.join(name), contents).expect("fake file");
        }
        pub(crate) fn mode(&self, name: &str, mode: u32) {
            std::fs::set_permissions(self.0.join(name), std::fs::Permissions::from_mode(mode))
                .expect("fake mode");
        }
        pub(crate) fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        pub(crate) fn remove(&self, name: &str) {
            let _ = std::fs::remove_file(self.0.join(name));
        }
    }
    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    /// `status --json --peers=false` for a node named `name` with one address.
    pub(crate) fn status(name: &str, id: &str, address: &str) -> String {
        serde_json::json!({"BackendState":"Running","MagicDNSSuffix":"example.ts.net","Self":{"ID":id,"DNSName":format!("{name}.example.ts.net."),"TailscaleIPs":[address],"HostName":name},"CurrentTailnet":{"Name":"example","MagicDNSSuffix":"example.ts.net"}}).to_string()
    }
    /// `whois --json` for a node `name` at `address` holding `caps`.
    pub(crate) fn whois(name: &str, id: &str, address: &str, caps: &serde_json::Value) -> String {
        let prefix = if address.contains(':') { 128 } else { 32 };
        serde_json::json!({"Node":{"ID":7,"StableID":id,"Name":format!("{name}.example.ts.net."),"Addresses":[format!("{address}/{prefix}")],"Tags":["tag:dev"],"KeyExpiry":"0001-01-01T00:00:00Z"},"UserProfile":{"LoginName":"tagged-devices"},"CapMap":{"github.com/mich-murphy/cap/pi-peers":caps,"other/cap":[{"x":1.5}]}}).to_string()
    }
    pub(crate) fn exists(path: &Path) -> bool {
        path.exists()
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{Fake, SCRIPT};
    use super::*;
    use serde_json::json;
    use std::net::Ipv4Addr;

    fn own() -> SelfNode {
        parse_status(fake::status("laptop", "nSelf", "100.64.0.1").as_bytes()).expect("status")
    }
    fn peer_ip() -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(100, 64, 0, 2))
    }
    fn whois(value: &serde_json::Value) -> Result<Peer, Failure> {
        identify(value.to_string().as_bytes(), peer_ip(), &own(), "laptop")
    }
    fn answer() -> serde_json::Value {
        serde_json::from_str(&fake::whois(
            "dev-01",
            "nDev",
            "100.64.0.2",
            &json!([{"scopes":["team"],"allow":["discover"]}]),
        ))
        .expect("fixture JSON")
    }

    #[test]
    fn status_reports_self_and_requires_a_running_backend() {
        let own = own();
        assert_eq!(own.name, "laptop");
        assert_eq!(own.stable_id, "nSelf");
        assert_eq!(own.suffix, "example.ts.net");
        assert_eq!(
            own.addresses,
            vec![IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))]
        );
        let mut stopped: serde_json::Value =
            serde_json::from_str(&fake::status("laptop", "nSelf", "100.64.0.1")).expect("JSON");
        stopped["BackendState"] = json!("NeedsLogin");
        assert_eq!(
            parse_status(stopped.to_string().as_bytes()),
            Err(Failure::NotRunning)
        );
        for broken in [
            json!({"BackendState":"Running"}),
            json!({"BackendState":"Running","MagicDNSSuffix":"example.ts.net","Self":{"ID":"n","DNSName":"laptop.other.net.","TailscaleIPs":["100.64.0.1"]}}),
            json!({"BackendState":"Running","MagicDNSSuffix":"example.ts.net","Self":{"ID":"n","DNSName":"laptop.example.ts.net.","TailscaleIPs":[]}}),
            json!({"BackendState":"Running","MagicDNSSuffix":"example.ts.net","Self":{"ID":"n","DNSName":"laptop.example.ts.net.","TailscaleIPs":["not-an-ip"]}}),
        ] {
            assert_eq!(
                parse_status(broken.to_string().as_bytes()),
                Err(Failure::Error),
                "{broken}"
            );
        }
        assert_eq!(parse_status(b"not json"), Err(Failure::Error));
    }

    #[test]
    fn whois_yields_the_machine_label_caps_and_tolerates_unknown_fields() {
        let peer = whois(&answer()).expect("valid peer");
        assert_eq!(peer.machine_id, "dev-01");
        assert_eq!(peer.stable_id, "nDev");
        assert_eq!(peer.tags, vec!["tag:dev".to_owned()]);
        assert!(peer.caps.allows("team", caps::Verb::Discover));
        assert!(!peer.caps.allows("team", caps::Verb::Push));
        let mut none = answer();
        none.as_object_mut().expect("object").remove("CapMap");
        assert!(
            whois(&none)
                .expect("no caps is still a node")
                .caps
                .is_empty()
        );
    }

    #[test]
    fn whois_refuses_wrong_addresses_expiry_self_and_bad_names() {
        let mut other = answer();
        other["Node"]["Addresses"] = json!(["100.64.0.3/32"]);
        assert_eq!(whois(&other), Err(Failure::Refused("address")));
        let mut wide = answer();
        wide["Node"]["Addresses"] = json!(["100.64.0.2/24"]);
        assert_eq!(whois(&wide), Err(Failure::Refused("address")));
        let mut expired = answer();
        expired["Node"]["Expired"] = json!(true);
        assert_eq!(whois(&expired), Err(Failure::Refused("expired")));
        let mut same = answer();
        same["Node"]["StableID"] = json!("nSelf");
        assert_eq!(whois(&same), Err(Failure::Refused("self")));
        let mut shared = answer();
        shared["Node"]["Addresses"] = json!(["100.64.0.2/32", "100.64.0.1/32"]);
        assert_eq!(whois(&shared), Err(Failure::Refused("self")));
        for name in [
            "laptop.example.ts.net.",
            "dev-01.other.ts.net.",
            "dev-01.example.ts.net",
            "Dev-01.example.ts.net.",
            "dev_01.example.ts.net.",
            "a.dev-01.example.ts.net.",
            ".example.ts.net.",
            "1dev.example.ts.net.",
            "dev-01-with-a-name-longer-than-32.example.ts.net.",
        ] {
            let mut renamed = answer();
            renamed["Node"]["Name"] = json!(name);
            assert_eq!(whois(&renamed), Err(Failure::Refused("name")), "{name}");
        }
        let mut huge = answer();
        huge["CapMap"][caps::CAPABILITY] =
            json!(vec![json!({"scopes":["team"],"allow":["discover"]}); 65]);
        assert_eq!(whois(&huge), Err(Failure::Refused("caps-bounds")));
        let mut absent = answer();
        absent.as_object_mut().expect("object").remove("Node");
        assert_eq!(whois(&absent), Err(Failure::Error));
    }

    #[test]
    fn failures_map_to_the_diagnose_reasons() {
        assert_eq!(classify(b"no match for IP:port\n"), Failure::NotFound);
        assert_eq!(
            classify(b"failed to connect to local tailscaled; it doesn't appear to be running\n"),
            Failure::NotRunning
        );
        assert_eq!(classify(b"something else"), Failure::Error);
        assert_eq!(Failure::Missing.reason(), "tailscale-missing");
        assert_eq!(Failure::NotRunning.reason(), "tailscale-not-running");
        assert_eq!(Failure::NotFound.reason(), "not-tailnet-address");
        assert_eq!(Failure::Refused("name").reason(), "not-tailnet-address");
        assert_eq!(Failure::Error.reason(), "tailscale-error");
    }

    #[test]
    fn only_owner_root_or_self_non_writable_binaries_and_wrapper_targets_are_trusted() {
        let fake = Fake::new(SCRIPT);
        let uid = rustix::process::geteuid().as_raw();
        assert!(trusted(&fake.program(), uid, 0).is_ok());
        assert_eq!(
            Cli::resolve(Some(&fake.program())).map(|cli| cli.program),
            Ok(fake.program())
        );
        assert_eq!(
            Cli::resolve(Some(Path::new("relative/tailscale"))),
            Err(Failure::Missing)
        );
        assert_eq!(
            Cli::resolve(Some(&fake.path("absent"))),
            Err(Failure::Missing)
        );
        for mode in [0o720, 0o702, 0o600] {
            fake.mode("tailscale", mode);
            assert!(trusted(&fake.program(), uid, 0).is_err(), "mode {mode:o}");
        }
        fake.mode("tailscale", 0o700);
        std::os::unix::fs::symlink(fake.program(), fake.path("link")).expect("symlink");
        assert_eq!(
            trusted(&fake.path("link"), uid, 0).expect("own symlink"),
            fake.program()
        );
        assert!(
            trusted(&fake.program(), uid.wrapping_add(1), 0).is_err(),
            "another user's file"
        );
        // A trusted wrapper whose target is writable by others is not trusted.
        fake.write("target", SCRIPT);
        fake.mode("target", 0o700);
        let wrapper = format!(
            "#!/bin/sh\nexec \"{}\" \"$@\"\n",
            fake.path("target").display()
        );
        fake.write("wrapper", &wrapper);
        fake.mode("wrapper", 0o700);
        assert!(
            trusted(&fake.path("wrapper"), uid, 0).is_err(),
            "a script target is a second wrapper level"
        );
        fake.write("target", "\x7fELF fixture");
        fake.mode("target", 0o700);
        assert!(trusted(&fake.path("wrapper"), uid, 0).is_ok());
        fake.mode("target", 0o722);
        assert!(trusted(&fake.path("wrapper"), uid, 0).is_err());
        fake.write("wrapper", "#!relative/sh\n");
        assert!(trusted(&fake.path("wrapper"), uid, 0).is_err());
        fake.write("wrapper", &format!("#!/bin/sh\n#{}\n", "x".repeat(4096)));
        assert!(
            trusted(&fake.path("wrapper"), uid, 0).is_err(),
            "bounded script"
        );
    }

    #[tokio::test]
    async fn calls_answer_from_a_clean_environment_and_classify_failures() {
        let fake = Fake::new(SCRIPT);
        let cli = Cli::resolve(Some(&fake.program())).expect("trusted fake");
        assert_eq!(cli.status().await, Err(Failure::NotFound), "no answer file");
        fake.write(
            "status.json",
            &fake::status("laptop", "nSelf", "100.64.0.1"),
        );
        let own = cli.status().await.expect("status");
        fake.write(
            "whois-100.64.0.2.json",
            &fake::whois(
                "dev-01",
                "nDev",
                "100.64.0.2",
                &json!([{"scopes":["team"],"allow":["push"]}]),
            ),
        );
        let peer = cli
            .whois(
                "::ffff:100.64.0.2".parse().expect("mapped address"),
                &own,
                "laptop",
            )
            .await
            .expect("whois by canonical IP");
        assert_eq!(peer.machine_id, "dev-01");
        assert_eq!(
            cli.whois(own.addresses[0], &own, "laptop").await,
            Err(Failure::Refused("self")),
            "never asks about its own address"
        );
        assert_eq!(
            cli.whois("100.64.0.9".parse().expect("IP"), &own, "laptop")
                .await,
            Err(Failure::NotFound)
        );
        fake.write("stderr", "it doesn't appear to be running\n");
        assert_eq!(
            cli.whois("100.64.0.9".parse().expect("IP"), &own, "laptop")
                .await,
            Err(Failure::NotRunning)
        );
        fake.write("stderr", "boom\n");
        assert_eq!(
            cli.whois("100.64.0.9".parse().expect("IP"), &own, "laptop")
                .await,
            Err(Failure::Error)
        );
        let env = Fake::new("#!/bin/sh\nenv\n");
        let printed = Cli::resolve(Some(&env.program()))
            .expect("trusted")
            .run(&["x"])
            .await
            .expect("env output");
        let printed = String::from_utf8(printed).expect("text");
        assert!(printed.contains(&format!("PATH={SYSTEM_PATH}")));
        assert!(!printed.contains("HOME="), "{printed}");
        assert!(!printed.contains("CARGO"), "{printed}");
    }

    #[tokio::test]
    async fn slow_or_oversized_calls_are_killed_and_refused() {
        let fake = Fake::new(SCRIPT);
        fake.write(
            "status.json",
            &fake::status("laptop", "nSelf", "100.64.0.1"),
        );
        fake.write("delay", "30");
        let cli = Cli::resolve(Some(&fake.program())).expect("trusted fake");
        let started = std::time::Instant::now();
        assert_eq!(cli.status().await, Err(Failure::Error));
        assert!(started.elapsed() < Duration::from_secs(4), "killed at 2 s");
        let large = Fake::new("#!/bin/sh\nhead -c 70000 /dev/zero\n");
        assert_eq!(
            Cli::resolve(Some(&large.program()))
                .expect("trusted")
                .run(&["x"])
                .await,
            Err(Failure::Error)
        );
        let exact = Fake::new("#!/bin/sh\nhead -c 65536 /dev/zero\n");
        assert_eq!(
            Cli::resolve(Some(&exact.program()))
                .expect("trusted")
                .run(&["x"])
                .await
                .map(|out| out.len()),
            Ok(65_536)
        );
        // The orphaned `sleep` of a killed wrapper dies with its process group.
        let orphan =
            Fake::new("#!/bin/sh\nsleep 30 &\necho $! > \"$(dirname \"$0\")/pid\"\nwait\n");
        let _ = Cli::resolve(Some(&orphan.program()))
            .expect("trusted")
            .run(&["x"])
            .await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        let pid: i32 = std::fs::read_to_string(orphan.path("pid"))
            .expect("pid file")
            .trim()
            .parse()
            .expect("pid");
        let alive = rustix::process::test_kill_process(
            rustix::process::Pid::from_raw(pid).expect("positive pid"),
        )
        .is_ok();
        assert!(!alive || !fake::exists(&orphan.path("pid")), "group killed");
    }
}
