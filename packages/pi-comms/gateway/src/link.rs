//! Single-pair connection acquisition and bounded reconnect episodes, without application replay.
use std::io;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::remote::{Authenticated, Endpoint, Prepared};

const EPISODE: Duration = Duration::from_secs(60);
const MAX_ATTEMPTS: u8 = 6;

#[derive(Debug)]
pub(crate) struct Driver {
    prepared: Arc<Prepared>,
    listener: Option<TcpListener>,
    pub(crate) pending: JoinSet<io::Result<Authenticated>>,
    episode: Episode,
}
impl Driver {
    pub(crate) fn new(prepared: Prepared) -> io::Result<Self> {
        let listener = match prepared.endpoint() {
            Endpoint::Listen { address } => {
                let listener = std::net::TcpListener::bind(address)?;
                listener.set_nonblocking(true)?;
                Some(TcpListener::from_std(listener)?)
            }
            Endpoint::Connect { .. } => None,
        };
        let due = listener.is_none().then(Instant::now);
        Ok(Self {
            prepared: Arc::new(prepared),
            listener,
            pending: JoinSet::new(),
            episode: Episode {
                attempts: 0,
                started: Instant::now(),
                due,
            },
        })
    }
    /// The socket address the listener actually bound; `None` for a connecting endpoint.
    pub(crate) fn local_address(&self) -> Option<std::net::SocketAddr> {
        self.listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok())
    }
    pub(crate) fn start(&mut self) {
        if self.listener.is_some()
            || !self.pending.is_empty()
            || self.episode.due.is_none_or(|due| due > Instant::now())
        {
            return;
        }
        self.episode.due = None;
        self.episode.attempts += 1;
        let prepared = Arc::clone(&self.prepared);
        self.pending.spawn(async move { prepared.connect().await });
    }
    pub(crate) fn retry(&mut self) {
        if self.listener.is_some() {
            self.episode.due = None;
            return;
        }
        if self.episode.failed() {
            // No payload, paths or credential diagnostics cross this operator boundary.
            let _ = std::io::stderr().write_all(
                b"{\"event\":\"remote_unavailable\",\"reason\":\"reconnect_exhausted\"}\n",
            );
        }
    }
    pub(crate) fn local_reconnection(&mut self) {
        if self.listener.is_none() && self.pending.is_empty() {
            self.episode.reconnect();
        }
    }
    pub(crate) fn due(&self) -> Option<Instant> {
        self.episode.due
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
                else { self.retry(); Ok(None) }
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

#[derive(Debug)]
struct Episode {
    attempts: u8,
    started: Instant,
    due: Option<Instant>,
}
impl Episode {
    // Returns true exactly when operator-visible unavailable becomes necessary.
    fn failed(&mut self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.started) >= EPISODE {
            self.attempts = 0;
            self.started = now;
        }
        if self.attempts >= MAX_ATTEMPTS {
            self.due = None;
            true
        } else {
            let mut jitter = [0_u8; 1];
            let _ = ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut jitter);
            self.due = Some(
                now + Duration::from_millis(
                    (1_u64 << self.attempts.min(5)) * 250 + u64::from(jitter[0]),
                ),
            );
            false
        }
    }
    fn reconnect(&mut self) {
        if self.due.is_none() {
            self.attempts = 0;
            self.started = Instant::now();
            self.due = Some(self.started);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn six_failed_handshakes_exhaust_episode_until_explicit_local_reconnection() {
        let mut episode = Episode {
            attempts: 0,
            started: Instant::now(),
            due: Some(Instant::now()),
        };
        for attempt in 1..=6 {
            let due = episode.due.take().expect("bounded attempt scheduled");
            tokio::time::sleep_until(due).await;
            episode.attempts += 1;
            tokio::time::advance(Duration::from_secs(5)).await;
            assert_eq!(episode.failed(), attempt == 6);
        }
        assert!(episode.started.elapsed() < EPISODE);
        assert!(episode.due.is_none());
        tokio::time::advance(Duration::from_secs(3600)).await;
        assert!(
            episode.due.is_none(),
            "elapsed time alone cannot restart exhausted episodes"
        );
        episode.reconnect();
        assert!(episode.due.is_some());
        assert_eq!(episode.attempts, 0);
    }
}
