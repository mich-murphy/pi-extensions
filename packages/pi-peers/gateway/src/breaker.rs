//! Per-remote-machine circuit breaker for the outbound link, with injected time and randomness.
//!
//! Closed keeps the short reconnect episode: up to six attempts within 60 s, backing off from
//! 250 ms. When the episode is exhausted the breaker opens. While open, sends to that machine fail
//! fast and a single half-open probe runs after a jittered exponential delay that starts at 30 s
//! and never exceeds 5 min. A failed probe reopens it with a longer delay; a successful handshake
//! closes it. There is no terminal state: probing continues for as long as the gateway runs.
use std::time::Duration;

use tokio::time::Instant;

/// Reconnect attempts allowed in one closed episode before the breaker opens.
pub const MAX_ATTEMPTS: u8 = 6;
/// Length of one closed reconnect episode.
pub const EPISODE: Duration = Duration::from_secs(60);
/// Smallest delay before a half-open probe.
pub const PROBE_MIN: Duration = Duration::from_secs(30);
/// Largest delay before a half-open probe, jitter included.
pub const PROBE_MAX: Duration = Duration::from_secs(300);
const PROBE_BASE_CAP_MS: u64 = 240_000;

/// What local sessions are told about the link to one remote machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum LinkView {
    /// An authenticated link is established.
    Up,
    /// No link, and no attempt is in flight or imminent; sends fail fast.
    Down,
    /// No link yet, but an attempt is in flight or due soon; sends still fail fast.
    Probing,
}
impl LinkView {
    /// The wire name of this state.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Probing => "probing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Connected {
        attempts: u8,
        started: Instant,
    },
    Listening,
    Retrying {
        attempts: u8,
        started: Instant,
        due: Option<Instant>,
    },
    Open {
        failures: u32,
        due: Instant,
    },
    Probing {
        failures: u32,
    },
}

/// Pure breaker state; every method takes the current time explicitly.
#[derive(Debug, Clone)]
pub struct Breaker {
    phase: Phase,
    since: Instant,
    listener: bool,
}

/// The delay before the half-open probe that follows `failures` failed probes.
///
/// The base doubles from 30 s up to 240 s; jitter adds up to a quarter of the base, so the result
/// always lies within [`PROBE_MIN`], [`PROBE_MAX`].
pub fn probe_delay(failures: u32, random: u64) -> Duration {
    let base = 30_000_u64
        .checked_shl(failures.min(16))
        .unwrap_or(PROBE_BASE_CAP_MS)
        .min(PROBE_BASE_CAP_MS);
    Duration::from_millis(base + random % (base / 4 + 1))
}

fn retry_delay(attempts: u8, random: u64) -> Duration {
    Duration::from_millis((1_u64 << attempts.min(5)) * 250 + random % 256)
}

impl Breaker {
    /// A connecting breaker that attempts its first handshake at `now`.
    pub fn connecting(now: Instant) -> Self {
        Self {
            phase: Phase::Retrying {
                attempts: 0,
                started: now,
                due: Some(now),
            },
            since: now,
            listener: false,
        }
    }
    /// A listening breaker: it never dials, and is down until a peer connects.
    pub fn listening(now: Instant) -> Self {
        Self {
            phase: Phase::Listening,
            since: now,
            listener: true,
        }
    }
    /// The state local sessions see.
    pub fn view(&self) -> LinkView {
        match self.phase {
            Phase::Connected { .. } => LinkView::Up,
            Phase::Listening | Phase::Open { .. } => LinkView::Down,
            Phase::Retrying { .. } | Phase::Probing { .. } => LinkView::Probing,
        }
    }
    /// When the current view began.
    pub fn since(&self) -> Instant {
        self.since
    }
    /// When an attempt is next due; `None` while connected, listening or an attempt is in flight.
    pub fn due(&self) -> Option<Instant> {
        match self.phase {
            Phase::Retrying { due, .. } => due,
            Phase::Open { due, .. } => Some(due),
            _ => None,
        }
    }
    /// The next half-open probe, only while open.
    pub fn next_probe(&self) -> Option<Instant> {
        match self.phase {
            Phase::Open { due, .. } => Some(due),
            _ => None,
        }
    }
    /// Whether sends routed to this machine are refused at once.
    pub fn fails_fast(&self) -> bool {
        self.view() != LinkView::Up
    }
    /// Whether the breaker is open, waiting for its next probe.
    pub fn is_open(&self) -> bool {
        matches!(self.phase, Phase::Open { .. })
    }

    fn change(&mut self, phase: Phase, now: Instant) -> Option<LinkView> {
        let before = self.view();
        self.phase = phase;
        let after = self.view();
        (before != after).then(|| {
            self.since = now;
            after
        })
    }

    /// Starts the due attempt. Returns `false` when none is due at `now`.
    pub fn attempt(&mut self, now: Instant) -> (bool, Option<LinkView>) {
        match self.phase {
            Phase::Retrying {
                attempts,
                started,
                due: Some(due),
            } if due <= now => {
                let attempts = attempts.saturating_add(1);
                let changed = self.change(
                    Phase::Retrying {
                        attempts,
                        started,
                        due: None,
                    },
                    now,
                );
                (true, changed)
            }
            Phase::Open { failures, due } if due <= now => {
                (true, self.change(Phase::Probing { failures }, now))
            }
            _ => (false, None),
        }
    }
    fn episode(
        &mut self,
        attempts: u8,
        started: Instant,
        now: Instant,
        random: u64,
    ) -> Option<LinkView> {
        let (attempts, started) = if now.saturating_duration_since(started) >= EPISODE {
            (0, now)
        } else {
            (attempts, started)
        };
        if attempts >= MAX_ATTEMPTS {
            self.change(
                Phase::Open {
                    failures: 0,
                    due: now + probe_delay(0, random),
                },
                now,
            )
        } else {
            self.change(
                Phase::Retrying {
                    attempts,
                    started,
                    due: Some(now + retry_delay(attempts, random)),
                },
                now,
            )
        }
    }
    /// Records a failed attempt, a refused handshake or a lost link, and schedules the next try.
    ///
    /// A lost link counts against the closed episode it was established in, so a link that keeps
    /// dropping right after its handshake opens the breaker like one that never connects.
    pub fn failed(&mut self, now: Instant, random: u64) -> Option<LinkView> {
        match self.phase {
            Phase::Connected { .. } if self.listener => self.change(Phase::Listening, now),
            Phase::Retrying {
                attempts, started, ..
            }
            | Phase::Connected { attempts, started } => {
                self.episode(attempts, started, now, random)
            }
            Phase::Probing { failures } => {
                let failures = failures.saturating_add(1);
                self.change(
                    Phase::Open {
                        failures,
                        due: now + probe_delay(failures, random),
                    },
                    now,
                )
            }
            Phase::Listening | Phase::Open { .. } => None,
        }
    }
    /// Records an established link: the breaker closes.
    pub fn connected(&mut self, now: Instant) -> Option<LinkView> {
        let (attempts, started) = match self.phase {
            Phase::Retrying {
                attempts, started, ..
            }
            | Phase::Connected { attempts, started } => (attempts, started),
            _ => (0, now),
        };
        self.change(Phase::Connected { attempts, started }, now)
    }
    /// A local session that needs the link registered: an open breaker probes now.
    pub fn local_registration(&mut self, now: Instant) {
        if let Phase::Open { failures, due } = self.phase
            && due > now
        {
            self.phase = Phase::Open { failures, due: now };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exhaust(breaker: &mut Breaker, now: &mut Instant) -> Option<LinkView> {
        let mut last = None;
        for _ in 0..MAX_ATTEMPTS {
            *now = breaker.due().expect("an attempt is scheduled");
            assert!(breaker.attempt(*now).0, "the due attempt starts");
            last = breaker.failed(*now, 0);
        }
        last
    }

    #[test]
    fn six_failures_open_the_breaker_instead_of_latching() {
        let mut now = Instant::now();
        let mut breaker = Breaker::connecting(now);
        assert_eq!(breaker.view(), LinkView::Probing);
        assert_eq!(exhaust(&mut breaker, &mut now), Some(LinkView::Down));
        assert!(breaker.is_open());
        assert!(breaker.fails_fast());
        let probe = breaker
            .next_probe()
            .expect("an open breaker always schedules a probe");
        assert_eq!(probe - now, PROBE_MIN);
    }

    #[test]
    fn probes_back_off_to_the_cap_and_never_stop() {
        let mut now = Instant::now();
        let mut breaker = Breaker::connecting(now);
        exhaust(&mut breaker, &mut now);
        let mut delays = Vec::new();
        for _ in 0..12 {
            let due = breaker.due().expect("probing never stops");
            delays.push(due - now);
            now = due;
            assert_eq!(breaker.attempt(now), (true, Some(LinkView::Probing)));
            assert_eq!(breaker.failed(now, 0), Some(LinkView::Down));
        }
        assert_eq!(delays[0], Duration::from_secs(30));
        assert_eq!(delays[1], Duration::from_secs(60));
        assert_eq!(delays[3], Duration::from_secs(240));
        assert_eq!(delays[11], Duration::from_secs(240));
        assert!(breaker.due().is_some());
    }

    #[test]
    fn successful_probe_closes_and_loss_restarts_a_fast_episode() {
        let mut now = Instant::now();
        let mut breaker = Breaker::connecting(now);
        exhaust(&mut breaker, &mut now);
        now = breaker.due().expect("probe scheduled");
        breaker.attempt(now);
        assert_eq!(breaker.connected(now), Some(LinkView::Up));
        assert!(!breaker.fails_fast());
        assert_eq!(breaker.since(), now);
        assert_eq!(breaker.failed(now, 0), Some(LinkView::Probing));
        assert_eq!(breaker.due(), Some(now + Duration::from_millis(250)));
    }

    #[test]
    fn local_registration_brings_the_probe_forward() {
        let mut now = Instant::now();
        let mut breaker = Breaker::connecting(now);
        exhaust(&mut breaker, &mut now);
        breaker.local_registration(now);
        assert_eq!(breaker.due(), Some(now));
        assert!(breaker.is_open(), "an earlier probe is not a state change");
    }

    #[test]
    fn listeners_are_down_until_a_peer_connects() {
        let now = Instant::now();
        let mut breaker = Breaker::listening(now);
        assert_eq!(breaker.view(), LinkView::Down);
        assert_eq!(breaker.due(), None);
        assert_eq!(breaker.failed(now, 7), None);
        assert_eq!(breaker.connected(now), Some(LinkView::Up));
        assert_eq!(breaker.failed(now, 0), Some(LinkView::Down));
        assert_eq!(breaker.due(), None);
    }

    #[test]
    fn a_link_that_keeps_dropping_after_its_handshake_still_opens_the_breaker() {
        let mut now = Instant::now();
        let mut breaker = Breaker::connecting(now);
        let mut last = None;
        for _ in 0..MAX_ATTEMPTS {
            now = breaker.due().expect("an attempt is scheduled");
            assert!(breaker.attempt(now).0, "the due attempt starts");
            assert_eq!(breaker.connected(now), Some(LinkView::Up));
            last = breaker.failed(now, 0);
        }
        assert_eq!(last, Some(LinkView::Down));
        assert!(breaker.is_open());
    }

    #[test]
    fn probe_delay_stays_within_bounds_for_extreme_inputs() {
        for failures in [0, 1, 3, 4, 31, 32, 64, u32::MAX] {
            for random in [0, 1, u64::MAX / 2, u64::MAX] {
                let delay = probe_delay(failures, random);
                assert!(
                    (PROBE_MIN..=PROBE_MAX).contains(&delay),
                    "{failures} {random}"
                );
            }
        }
    }
}
