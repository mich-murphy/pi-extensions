//! Actual-deadline active-link guards; no polling timer or automatic credential renewal.
use std::fmt;
use std::future::Future;
use std::time::{Duration, SystemTime};

use tokio::time::Instant;

const MAX_AGE: Duration = Duration::from_hours(24);

/// A live link's earliest own/peer credential expiry, independently capped at 24 hours.
#[derive(Debug)]
pub struct LinkLease {
    deadline: Instant,
}

/// An invalid/expired wall-clock credential bound cannot create an active link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseError;
impl fmt::Display for LeaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("credential lease expired or invalid")
    }
}
impl std::error::Error for LeaseError {}

/// Reason an active-link future was stopped; no result asserts message non-admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum LinkEnd {
    /// The stream task ended normally or through its own protocol/I/O failure.
    ConnectionEnded,
    /// Earliest verified credential/root/CRL expiry or maximum age was reached.
    Expired,
    /// The enforcing operator applied withdrawal, trust change or shutdown.
    Withdrawn,
}

impl LinkLease {
    /// Converts verified own/peer Unix expiry bounds into one precise monotonic deadline.
    ///
    /// Use a maintained wall-clock sample taken immediately before activating the link.
    /// The fractional second is retained: rounding the sample down would add expiry grace.
    /// The caller must also recheck current wall-clock policy before application I/O;
    /// clock discontinuities require withdrawal/revalidation, not extending this lease.
    ///
    /// # Errors
    /// Rejects elapsed expiry, unrepresentable wall-clock instants and zero remaining time.
    pub fn new(
        own_expiry: u64,
        peer_expiry: u64,
        wall_now: SystemTime,
    ) -> Result<Self, LeaseError> {
        let expiry = SystemTime::UNIX_EPOCH
            .checked_add(Duration::from_secs(own_expiry.min(peer_expiry)))
            .ok_or(LeaseError)?;
        let remaining = expiry
            .duration_since(wall_now)
            .map_err(|_| LeaseError)?
            .min(MAX_AGE);
        if remaining.is_zero() {
            return Err(LeaseError);
        }
        Ok(Self {
            deadline: Instant::now().checked_add(remaining).ok_or(LeaseError)?,
        })
    }

    pub(crate) fn deadline(&self) -> Instant {
        self.deadline
    }

    /// Owns an active stream future until it completes, expires or is explicitly withdrawn.
    ///
    /// Expiry/withdrawal drops the entire future, including its stream and queued buffers.
    /// The route owner must generation-fence withdrawal and preserve unknown for operations
    /// already possibly forwarded. This guard does not retract admitted content.
    pub async fn guard(
        self,
        operation: impl Future<Output = ()>,
        withdrawal: impl Future<Output = ()>,
    ) -> LinkEnd {
        tokio::select! {
            biased;
            () = withdrawal => LinkEnd::Withdrawn,
            () = tokio::time::sleep_until(self.deadline) => LinkEnd::Expired,
            () = operation => LinkEnd::ConnectionEnded,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn fraction_is_not_added_as_expiry_grace_and_age_is_capped() {
        let wall = SystemTime::UNIX_EPOCH + Duration::from_millis(100_750);
        let lease = LinkLease::new(101, 200, wall).expect("250ms credential lease");
        let begin = Instant::now();
        assert_eq!(
            lease
                .guard(std::future::pending(), std::future::pending())
                .await,
            LinkEnd::Expired
        );
        assert_eq!(begin.elapsed(), Duration::from_millis(250));
        let lease = LinkLease::new(1_000_000, 1_000_000, wall).expect("long credential lifetime");
        let begin = Instant::now();
        assert_eq!(
            lease
                .guard(std::future::pending(), std::future::pending())
                .await,
            LinkEnd::Expired
        );
        assert_eq!(
            begin.elapsed(),
            Duration::from_hours(24),
            "an active link never outlives 24 hours, however distant its credentials expire"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn withdrawal_precedes_ready_application_work_and_expiry() {
        let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
        let lease = LinkLease::new(101, 200, wall).expect("valid credential lease");
        assert_eq!(lease.guard(async {}, async {}).await, LinkEnd::Withdrawn);
        assert!(LinkLease::new(100, 200, wall).is_err());
    }
}
