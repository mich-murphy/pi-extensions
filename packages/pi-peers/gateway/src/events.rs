//! Coalesced structured operator events on stderr, without payloads, paths or credentials.
use std::collections::HashMap;
use std::io::Write;
use std::time::Duration;

use serde_json::Value;
use tokio::time::Instant;

/// At most one line per event key in this window; the rest are counted and reported later.
pub(crate) const WINDOW: Duration = Duration::from_secs(30);

#[derive(Debug, Default)]
pub(crate) struct Events {
    last: HashMap<String, (Instant, u64)>,
}
impl Events {
    /// Returns the line to write, or `None` when it is coalesced into a later one.
    pub(crate) fn record(&mut self, key: &str, mut event: Value, now: Instant) -> Option<Value> {
        let previous = self.last.get(key).copied();
        if let Some((at, suppressed)) = previous
            && now.saturating_duration_since(at) < WINDOW
        {
            self.last
                .insert(key.to_owned(), (at, suppressed.saturating_add(1)));
            return None;
        }
        let suppressed = previous.map_or(0, |(_, suppressed)| suppressed);
        self.last.insert(key.to_owned(), (now, 0));
        if suppressed > 0 {
            event["suppressed"] = Value::from(suppressed);
        }
        Some(event)
    }
    pub(crate) fn emit(&mut self, key: &str, event: Value) {
        if let Some(event) = self.record(key, event, Instant::now())
            && let Ok(mut line) = serde_json::to_vec(&event)
        {
            line.push(b'\n');
            let _ = std::io::stderr().write_all(&line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repeated_events_are_coalesced_and_counted() {
        let mut events = Events::default();
        let start = Instant::now();
        let first = events.record("overloaded:buffers", json!({"event":"overloaded"}), start);
        assert_eq!(first, Some(json!({"event":"overloaded"})));
        for offset in 1..=100 {
            let line = events.record(
                "overloaded:buffers",
                json!({"event":"overloaded"}),
                start + Duration::from_millis(offset),
            );
            assert_eq!(line, None, "a flood inside the window writes nothing");
        }
        assert!(
            events
                .record("forward_timeout", json!({"event":"forward_timeout"}), start)
                .is_some(),
            "other keys are independent"
        );
        let later = events.record(
            "overloaded:buffers",
            json!({"event":"overloaded"}),
            start + WINDOW,
        );
        assert_eq!(later, Some(json!({"event":"overloaded","suppressed":100})));
    }
}
