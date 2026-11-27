//! Single-pair connection acquisition driven by the link circuit breaker, without application replay.
use std::io;
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::breaker::Breaker;
use crate::remote::{Authenticated, Endpoint, Prepared, Refusal};

/// What one turn of the link driver produced.
#[derive(Debug)]
pub(crate) enum Step {
    /// Nothing for the daemon yet.
    Idle,
    /// A stream whose peer passed every identity check.
    Linked(Box<Authenticated>),
    /// A setup that was refused, for the audit log.
    Refused(Refusal),
}

#[derive(Debug)]
pub(crate) struct Driver {
    prepared: Arc<Prepared>,
    listener: Option<TcpListener>,
    pub(crate) pending: JoinSet<Result<Authenticated, Refusal>>,
    breaker: Breaker,
    /// The machineId of the last identified peer; link state names it, and nothing before it.
    machine: Option<String>,
}

fn random() -> u64 {
    let mut bytes = [0_u8; 8];
    let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes);
    u64::from_le_bytes(bytes)
}

impl Driver {
    pub(crate) fn new(prepared: Prepared) -> io::Result<Self> {
        let listener = match prepared.endpoint() {
            Endpoint::Listen { address } => {
                let listener =
                    std::net::TcpListener::bind(address).map_err(crate::remote::listen_error)?;
                listener.set_nonblocking(true)?;
                Some(TcpListener::from_std(listener)?)
            }
            Endpoint::Connect { .. } => None,
        };
        let now = Instant::now();
        let breaker = if listener.is_some() {
            Breaker::listening(now)
        } else {
            Breaker::connecting(now)
        };
        Ok(Self {
            prepared: Arc::new(prepared),
            listener,
            pending: JoinSet::new(),
            breaker,
            machine: None,
        })
    }
    /// The socket address the listener actually bound; `None` for a connecting endpoint.
    pub(crate) fn local_address(&self) -> Option<std::net::SocketAddr> {
        self.listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok())
    }
    #[expect(dead_code, reason = "the 15 s refresh calls this in the next step")]
    pub(crate) fn prepared(&self) -> &Arc<Prepared> {
        &self.prepared
    }
    pub(crate) fn machine(&self) -> Option<&str> {
        self.machine.as_deref()
    }
    /// Records the machineId whois gave the peer this link reaches or last reached.
    pub(crate) fn identified(&mut self, machine: &str) {
        machine.clone_into(self.machine.get_or_insert_with(String::new));
    }
    pub(crate) fn breaker(&self) -> &Breaker {
        &self.breaker
    }
    pub(crate) fn start(&mut self) {
        if self.listener.is_some() || !self.pending.is_empty() {
            return;
        }
        if self.breaker.attempt(Instant::now()).0 {
            let prepared = Arc::clone(&self.prepared);
            self.pending.spawn(async move { prepared.connect().await });
        }
    }
    /// An identified link became the active remote.
    pub(crate) fn connected(&mut self) {
        self.breaker.connected(Instant::now());
    }
    /// The active link was lost.
    pub(crate) fn lost(&mut self) {
        self.breaker.failed(Instant::now(), random());
    }
    /// A setup failed or was refused; an established link is unaffected.
    pub(crate) fn handshake_failed(&mut self) {
        if self.breaker.fails_fast() {
            self.breaker.failed(Instant::now(), random());
        }
    }
    pub(crate) fn local_reconnection(&mut self) {
        if self.listener.is_none() {
            self.breaker.local_registration(Instant::now());
        }
    }
    pub(crate) fn due(&self) -> Option<Instant> {
        if self.listener.is_some() || !self.pending.is_empty() {
            return None;
        }
        self.breaker.due()
    }

    pub(crate) async fn progress(&mut self) -> io::Result<Step> {
        tokio::select! {
            accepted = async {
                match &self.listener {
                    Some(listener) => listener.accept().await.map(|(stream, _)| stream),
                    None => std::future::pending().await,
                }
            } => { self.handshake(accepted?); Ok(Step::Idle) }
            joined = self.pending.join_next(), if !self.pending.is_empty() => {
                match joined {
                    Some(Ok(Ok(authenticated))) => Ok(Step::Linked(Box::new(authenticated))),
                    Some(Ok(Err(refusal))) => { self.handshake_failed(); Ok(Step::Refused(refusal)) }
                    _ => { self.handshake_failed(); Ok(Step::Idle) }
                }
            }
        }
    }
    pub(crate) fn handshake(&mut self, stream: tokio::net::TcpStream) {
        if self.pending.len() < 4 {
            let prepared = Arc::clone(&self.prepared);
            self.pending
                .spawn(async move { prepared.accept(stream).await });
        }
    }
}
