//! Remaining-time budgets carried in send and deliver headers, shrunk at every hop.
use std::time::Duration;

use serde_json::Value;

/// Time each hop keeps for itself, so the next hop always gives up first and the
/// answer that comes back is authoritative rather than this hop's own timeout.
pub(crate) const HOP_RESERVE: Duration = Duration::from_millis(250);

/// A hop's own deadline and the budget it hands to the next hop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Hop {
    pub(crate) wait: Duration,
    pub(crate) forward_ms: u64,
}

/// Splits a received budget into this hop's wait and the next hop's budget.
///
/// Returns `None` when the budget is spent: nothing may be forwarded.
pub(crate) fn hop(budget: &Value, cap: Duration) -> Option<Hop> {
    let received = Duration::from_millis(budget.as_u64()?).min(cap);
    let wait = received.checked_sub(HOP_RESERVE)?;
    let forward = wait.checked_sub(HOP_RESERVE)?;
    let forward_ms = u64::try_from(forward.as_millis()).ok()?;
    (forward_ms > 0).then_some(Hop { wait, forward_ms })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CAP: Duration = Duration::from_secs(15);

    #[test]
    fn each_hop_waits_less_than_it_received_and_forwards_less_than_it_waits() {
        let first = hop(&json!(15_000), CAP).expect("fresh budget");
        assert_eq!(first.wait, Duration::from_millis(14_750));
        assert_eq!(first.forward_ms, 14_500);
        let second = hop(&json!(first.forward_ms), CAP).expect("second hop");
        assert!(second.wait < Duration::from_millis(first.forward_ms));
        assert!(second.forward_ms < first.forward_ms);
    }

    #[test]
    fn a_budget_above_the_operation_timeout_is_capped() {
        assert_eq!(
            hop(&json!(60_000), CAP),
            hop(&json!(15_000), CAP),
            "per-hop wait is min(remaining budget, operation timeout)"
        );
    }

    #[test]
    fn a_spent_budget_forwards_nothing() {
        for spent in [0, 1, 250, 500] {
            assert_eq!(hop(&json!(spent), CAP), None, "budget {spent}");
        }
        assert!(hop(&json!(501), CAP).is_some());
        assert_eq!(hop(&Value::Null, CAP), None);
    }
}
