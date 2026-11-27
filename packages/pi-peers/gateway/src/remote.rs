//! Tailscale-identified remote settings and link setup over plain TCP.
//!
//! The peer's identity and permissions come only from the local tailscaled. Before any byte is
//! read or written, both sides check that the socket's local address is one of this node's own
//! tailnet IPs, that the peer is not this node, and that whois names a peer node at exactly the
//! peer's IP. whois never resolves loopback, LAN or other-VPN addresses, so those paths fail
//! closed. There is no bypass.
use std::fmt;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::net::TcpStream;

use crate::tailscale::{Cli, Failure, Peer, SelfNode};

/// One deadline for the status and whois calls and the TCP connect of a link setup.
const SETUP: Duration = Duration::from_secs(5);

/// Exactly one configured outbound initiator or inbound listener for the pair.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Endpoint {
    /// Dials this address; the peer is whoever whois says holds its IP.
    Connect { address: SocketAddr },
    /// Accepts streams on this address, which must be one of this node's tailnet IPs.
    Listen { address: SocketAddr },
}
impl Endpoint {
    fn report(self) -> Value {
        match self {
            Self::Connect { address } => json!({"mode":"connect","address":address.to_string()}),
            Self::Listen { address } => json!({"mode":"listen","address":address.to_string()}),
        }
    }
}

/// Strict remote settings: where to link, and optionally which Tailscale CLI to trust.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    endpoint: Endpoint,
    #[serde(default)]
    tailscale: Option<PathBuf>,
}

/// A resolved CLI for one configured endpoint.
#[derive(Debug)]
pub(crate) struct Prepared {
    cli: Cli,
    endpoint: Endpoint,
    machine_id: String,
}

/// A TCP stream whose peer passed every identity check, with what whois said about it.
#[derive(Debug)]
pub(crate) struct Authenticated {
    pub(crate) stream: TcpStream,
    pub(crate) peer: Peer,
    pub(crate) local: SocketAddr,
    pub(crate) remote: SocketAddr,
}

/// Why a link setup did not produce a link; `peer` is set once whois identified the target.
#[derive(Debug)]
pub(crate) struct Refusal {
    pub(crate) failure: Failure,
    pub(crate) peer: Option<Box<Peer>>,
    pub(crate) address: Option<IpAddr>,
}
impl Refusal {
    fn new(failure: Failure, address: Option<IpAddr>) -> Self {
        Self {
            failure,
            peer: None,
            address,
        }
    }
}

impl Settings {
    /// A CLI path must be absolute, and a dialed address must name a real port.
    pub(crate) fn valid(&self) -> bool {
        self.tailscale
            .as_ref()
            .is_none_or(|path| path.is_absolute())
            && !matches!(self.endpoint, Endpoint::Connect { address } if address.port() == 0)
    }

    /// Resolves the trusted CLI; runs nothing and opens no socket.
    pub(crate) fn prepare(&self, machine_id: &str) -> Result<Prepared, Failure> {
        Ok(Prepared {
            cli: Cli::resolve(self.tailscale.as_deref())?,
            endpoint: self.endpoint,
            machine_id: machine_id.to_owned(),
        })
    }

    /// The `--diagnose` remote section: what this node is and, when dialing, who it would reach
    /// and what that peer may do here. Never binds or connects.
    pub(crate) async fn diagnose(&self, machine_id: &str) -> Value {
        let degraded = |failure: Failure| json!({"state":"degraded","reason":failure.reason()});
        let prepared = match self.prepare(machine_id) {
            Ok(prepared) => prepared,
            Err(failure) => return degraded(failure),
        };
        let own = match prepared.cli.status().await {
            Ok(own) => own,
            Err(failure) => return degraded(failure),
        };
        let mut report = json!({"state":"configured","trust":"tailscale","endpoint":self.endpoint.report(),"self":{"name":own.name,"stableId":own.stable_id,"addresses":own.addresses}});
        match self.endpoint {
            Endpoint::Listen { address } => {
                if !own.addresses.contains(&address.ip().to_canonical()) {
                    return degraded(Failure::NotFound);
                }
            }
            Endpoint::Connect { address } => {
                match prepared.cli.whois(address.ip(), &own, machine_id).await {
                    Ok(peer) => {
                        report["peer"] = json!({"name":peer.machine_id,"stableId":peer.stable_id,"tags":peer.tags,"allow":peer.caps.report()});
                    }
                    Err(failure) => return degraded(failure),
                }
            }
        }
        report
    }
}

fn own_address(own: &SelfNode, address: SocketAddr) -> bool {
    own.addresses.contains(&address.ip().to_canonical())
}

impl Prepared {
    /// Returns the operator-selected single-pair connection role/address.
    pub(crate) fn endpoint(&self) -> Endpoint {
        self.endpoint
    }

    /// Asks tailscaled again who holds `ip` and what it may do here.
    #[expect(dead_code, reason = "the 15 s refresh calls this in the next step")]
    pub(crate) async fn identify(&self, ip: IpAddr) -> Result<Peer, Failure> {
        let own = self.cli.status().await?;
        self.cli.whois(ip, &own, &self.machine_id).await
    }

    /// Identifies the target, dials it and checks the socket, all before any byte is sent.
    ///
    /// No retry loop is hidden here; the link breaker paces attempts.
    pub(crate) async fn connect(&self) -> Result<Authenticated, Refusal> {
        let Endpoint::Connect { address } = self.endpoint else {
            return Err(Refusal::new(Failure::Error, None));
        };
        let target = Some(address.ip().to_canonical());
        tokio::time::timeout(SETUP, async {
            let own = self
                .cli
                .status()
                .await
                .map_err(|failure| Refusal::new(failure, target))?;
            let peer = self
                .cli
                .whois(address.ip(), &own, &self.machine_id)
                .await
                .map_err(|failure| Refusal::new(failure, target))?;
            let refused = |detail, peer: &Peer| Refusal {
                failure: Failure::Refused(detail),
                peer: Some(Box::new(peer.clone())),
                address: target,
            };
            let stream = TcpStream::connect(address)
                .await
                .map_err(|_| refused("unreachable", &peer))?;
            let (Ok(local), Ok(remote)) = (stream.local_addr(), stream.peer_addr()) else {
                return Err(refused("unreachable", &peer));
            };
            // The route must have gone through the Tailscale interface to the node whois named.
            if !own_address(&own, local) {
                return Err(refused("local-address", &peer));
            }
            if remote.ip().to_canonical() != peer.ip {
                return Err(refused("address", &peer));
            }
            if peer.caps.is_empty() {
                return Err(refused("no-caps", &peer));
            }
            Ok(Authenticated {
                stream,
                peer,
                local,
                remote,
            })
        })
        .await
        .unwrap_or_else(|_| Err(Refusal::new(Failure::Refused("timeout"), target)))
    }

    /// Identifies one accepted stream before reading any byte from it.
    ///
    /// The caller bounds concurrent setups before invocation.
    pub(crate) async fn accept(&self, stream: TcpStream) -> Result<Authenticated, Refusal> {
        let (Ok(local), Ok(remote)) = (stream.local_addr(), stream.peer_addr()) else {
            return Err(Refusal::new(Failure::Refused("unreachable"), None));
        };
        let address = Some(remote.ip().to_canonical());
        tokio::time::timeout(SETUP, async {
            let own = self
                .cli
                .status()
                .await
                .map_err(|failure| Refusal::new(failure, address))?;
            if !own_address(&own, local) {
                return Err(Refusal::new(Failure::Refused("local-address"), address));
            }
            let peer = self
                .cli
                .whois(remote.ip(), &own, &self.machine_id)
                .await
                .map_err(|failure| Refusal::new(failure, address))?;
            if peer.caps.is_empty() {
                return Err(Refusal {
                    failure: Failure::Refused("no-caps"),
                    peer: Some(Box::new(peer)),
                    address,
                });
            }
            Ok(Authenticated {
                stream,
                peer,
                local,
                remote,
            })
        })
        .await
        .unwrap_or_else(|_| Err(Refusal::new(Failure::Refused("timeout"), address)))
    }
}

#[derive(Debug)]
struct Degraded {
    reason: &'static str,
    source: io::Error,
}
impl fmt::Display for Degraded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.reason)
    }
}
impl std::error::Error for Degraded {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}
pub(crate) fn degradation(error: &io::Error) -> Option<&'static str> {
    error
        .get_ref()?
        .downcast_ref::<Degraded>()
        .map(|failure| failure.reason)
}

// Only known operational errors from the TCP bind call degrade remote startup.
// Descriptor exhaustion, invalid arguments and subsequent listener setup defects
// remain fatal; diagnostics never call this or attempt a bind.
pub(crate) fn listen_error(error: io::Error) -> io::Error {
    match error.kind() {
        io::ErrorKind::AddrInUse
        | io::ErrorKind::AddrNotAvailable
        | io::ErrorKind::PermissionDenied => io::Error::other(Degraded {
            reason: "remote-listen-unavailable",
            source: error,
        }),
        _ => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tailscale::fake::{self, Fake, SCRIPT};

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

    fn settings(fake: &Fake, mode: &str, address: &str) -> Settings {
        serde_json::from_value(
            json!({"endpoint":{"mode":mode,"address":address},"tailscale":fake.program()}),
        )
        .expect("settings")
    }

    #[tokio::test]
    async fn diagnose_reports_self_peer_caps_and_each_degraded_reason() {
        let fake = Fake::new(SCRIPT);
        let connect = settings(&fake, "connect", "100.64.0.2:7443");
        assert_eq!(
            connect.diagnose("laptop").await,
            json!({"state":"degraded","reason":"not-tailnet-address"}),
            "no status answer reads as an unknown address"
        );
        fake.write(
            "stderr",
            "failed to connect to local tailscaled; it doesn't appear to be running\n",
        );
        assert_eq!(
            connect.diagnose("laptop").await["reason"],
            "tailscale-not-running"
        );
        fake.remove("stderr");
        fake.write(
            "status.json",
            &fake::status("laptop", "nSelf", "100.64.0.1"),
        );
        assert_eq!(
            connect.diagnose("laptop").await["reason"],
            "not-tailnet-address",
            "whois does not know the target"
        );
        fake.write(
            "whois-100.64.0.2.json",
            &fake::whois(
                "dev-01",
                "nDev",
                "100.64.0.2",
                &json!([{"scopes":["local"],"allow":["discover","reply"]}]),
            ),
        );
        assert_eq!(
            connect.diagnose("laptop").await,
            json!({"state":"configured","trust":"tailscale","endpoint":{"mode":"connect","address":"100.64.0.2:7443"},"self":{"name":"laptop","stableId":"nSelf","addresses":["100.64.0.1"]},"peer":{"name":"dev-01","stableId":"nDev","tags":["tag:dev"],"allow":[{"scope":"local","actions":["discover","reply"]}]}})
        );
        assert_eq!(
            settings(&fake, "listen", "100.64.0.1:7443")
                .diagnose("laptop")
                .await,
            json!({"state":"configured","trust":"tailscale","endpoint":{"mode":"listen","address":"100.64.0.1:7443"},"self":{"name":"laptop","stableId":"nSelf","addresses":["100.64.0.1"]}})
        );
        for address in ["0.0.0.0:7443", "127.0.0.1:7443", "100.64.0.2:7443"] {
            assert_eq!(
                settings(&fake, "listen", address).diagnose("laptop").await["reason"],
                "not-tailnet-address",
                "{address}"
            );
        }
        fake.write("status.json", "{\"BackendState\":\"Running\"");
        assert_eq!(
            connect.diagnose("laptop").await["reason"],
            "tailscale-error"
        );
        fake.mode("tailscale", 0o722);
        assert_eq!(
            connect.diagnose("laptop").await["reason"],
            "tailscale-missing"
        );
    }

    #[tokio::test]
    async fn accept_refuses_before_reading_unless_the_peer_is_a_known_other_node() {
        let fake = Fake::new(SCRIPT);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback listener");
        let address = listener.local_addr().expect("bound");
        let prepared = settings(&fake, "listen", &address.to_string())
            .prepare("beta")
            .expect("trusted fake");
        let attempt = async || {
            let _client = TcpStream::connect(address).await.expect("dial");
            let (stream, _) = listener.accept().await.expect("accept");
            prepared.accept(stream).await
        };
        fake.write("status.json", &fake::status("beta", "nBeta", "100.64.0.1"));
        let refused = attempt()
            .await
            .expect_err("loopback is not a tailnet address");
        assert_eq!(refused.failure, Failure::Refused("local-address"));
        fake.write("status.json", &fake::status("beta", "nBeta", "127.0.0.1"));
        let refused = attempt().await.expect_err("the peer is this node");
        assert_eq!(refused.failure, Failure::Refused("self"));
    }
}
