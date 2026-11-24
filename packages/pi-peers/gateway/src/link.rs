//! Single-pair connection acquisition driven by the link circuit breaker, without application replay.
use std::io;
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::breaker::Breaker;
use crate::remote::{Authenticated, Endpoint, Prepared};

#[derive(Debug)]
pub(crate) struct Driver {
    prepared: Arc<Prepared>,
    listener: Option<TcpListener>,
    pub(crate) pending: JoinSet<io::Result<Authenticated>>,
    breaker: Breaker,
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
        })
    }
    /// The socket address the listener actually bound; `None` for a connecting endpoint.
    pub(crate) fn local_address(&self) -> Option<std::net::SocketAddr> {
        self.listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok())
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
    /// An authenticated link became the active remote.
    pub(crate) fn connected(&mut self) {
        self.breaker.connected(Instant::now());
    }
    /// The active link was lost.
    pub(crate) fn lost(&mut self) {
        self.breaker.failed(Instant::now(), random());
    }
    /// A handshake failed or was refused; an established link is unaffected.
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

    pub(crate) async fn progress(&mut self) -> io::Result<Option<Authenticated>> {
        tokio::select! {
            accepted = async {
                match &self.listener {
                    Some(listener) => listener.accept().await.map(|(stream, _)| stream),
                    None => std::future::pending().await,
                }
            } => { self.handshake(accepted?); Ok(None) }
            joined = self.pending.join_next(), if !self.pending.is_empty() => {
                if let Some(Ok(Ok(authenticated))) = joined { Ok(Some(authenticated)) }
                else { self.handshake_failed(); Ok(None) }
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
