//! What a remote holding only `reply` may answer: messages local sessions sent it on this link.
//!
//! One table per link, so the link's pinned `StableID` is part of every key. An entry is keyed by
//! the exact local sender, the remote recipient (including its runtime nonce), the scope and the
//! message id. It is recorded when the gateway forwards the local message, lives 600 s from the
//! first send (a `retryOf` resend never extends or reopens it), and admits at most 8 `update`s
//! and one `reply`, which closes it. The table holds at most 4096 entries; when it is full new
//! local sends to that remote are refused. Closing the link drops the table.
use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;
use tokio::time::Instant;

/// How long after the first send a remote may still answer.
pub(crate) const TTL: Duration = Duration::from_secs(600);
/// Entries per link, closed ones included until they expire.
pub(crate) const MAX_ENTRIES: usize = 4096;
/// `update`s admitted per entry under `reply`.
pub(crate) const MAX_UPDATES: u8 = 8;

/// A peer as `(machineId, sessionId, runtimeNonce)`.
type PeerKey = (String, String, String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    local: PeerKey,
    remote: PeerKey,
    scope: String,
    message_id: String,
}

#[derive(Debug)]
struct Entry {
    first_sent: Instant,
    updates: u8,
    replied: bool,
}

/// The kind of answer a remote delivers under `reply`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Answer {
    /// `reply`: admitted once, then the entry is closed.
    Reply,
    /// `update` carrying `replyTo`: admitted up to [`MAX_UPDATES`] times.
    Update,
}

/// The table is full of live entries; the send is refused as overloaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Full;

fn peer(value: &Value) -> Option<PeerKey> {
    Some((
        value["machineId"].as_str()?.to_owned(),
        value["sessionId"].as_str()?.to_owned(),
        value["runtimeNonce"].as_str()?.to_owned(),
    ))
}
fn key(local: &Value, remote: &Value, scope: &str, message_id: &str) -> Option<Key> {
    Some(Key {
        local: peer(local)?,
        remote: peer(remote)?,
        scope: scope.to_owned(),
        message_id: message_id.to_owned(),
    })
}

/// One link's record of local messages sent to its remote.
#[derive(Debug, Default)]
pub(crate) struct Replies {
    entries: HashMap<Key, Entry>,
}

impl Replies {
    /// Records that local `sender` sent `message_id` to remote `recipient` in `scope`.
    ///
    /// Returns whether a new entry was made: a resend of a recorded message keeps its first
    /// send time, its update count and whether it was already answered.
    ///
    /// # Errors
    /// [`Full`] when the table holds [`MAX_ENTRIES`] unexpired entries.
    pub(crate) fn sent(
        &mut self,
        sender: &Value,
        recipient: &Value,
        scope: &str,
        message_id: &str,
        now: Instant,
    ) -> Result<bool, Full> {
        let Some(key) = key(sender, recipient, scope, message_id) else {
            return Err(Full);
        };
        if let Some(entry) = self.entries.get(&key)
            && now < entry.first_sent + TTL
        {
            return Ok(false);
        }
        if self.entries.len() >= MAX_ENTRIES {
            self.entries.retain(|_, entry| now < entry.first_sent + TTL);
        }
        if self.entries.len() >= MAX_ENTRIES {
            return Err(Full);
        }
        self.entries.insert(
            key,
            Entry {
                first_sent: now,
                updates: 0,
                replied: false,
            },
        );
        Ok(true)
    }

    /// Undoes a [`Self::sent`] that made a new entry for a message that was not sent after all.
    pub(crate) fn unsent(
        &mut self,
        sender: &Value,
        recipient: &Value,
        scope: &str,
        message_id: &str,
    ) {
        if let Some(key) = key(sender, recipient, scope, message_id) {
            self.entries.remove(&key);
        }
    }

    /// Whether remote `sender` may deliver `answer` to local `recipient` for `message_id` in
    /// `scope`; an admitted answer is counted at once, so it can never be replayed.
    pub(crate) fn answer(
        &mut self,
        sender: &Value,
        recipient: &Value,
        scope: &str,
        message_id: &str,
        answer: Answer,
        now: Instant,
    ) -> bool {
        let Some(key) = key(recipient, sender, scope, message_id) else {
            return false;
        };
        let Some(entry) = self.entries.get_mut(&key) else {
            return false;
        };
        if now >= entry.first_sent + TTL {
            self.entries.remove(&key);
            return false;
        }
        if entry.replied {
            return false;
        }
        match answer {
            Answer::Reply => entry.replied = true,
            Answer::Update if entry.updates >= MAX_UPDATES => return false,
            Answer::Update => entry.updates += 1,
        }
        true
    }

    /// Entries held, closed and expired ones included until they are pruned.
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn local() -> Value {
        json!({"machineId":"alpha","sessionId":"me","runtimeNonce":"00000000000000000000000000000001"})
    }
    fn remote() -> Value {
        json!({"machineId":"beta","sessionId":"you","runtimeNonce":"00000000000000000000000000000002"})
    }
    const ID: &str = "0000000000000000000000000000000a";

    fn table(now: Instant) -> Replies {
        let mut replies = Replies::default();
        assert_eq!(replies.sent(&local(), &remote(), "team", ID, now), Ok(true));
        replies
    }

    #[test]
    fn forged_replies_never_match_another_sender_recipient_scope_or_message() {
        let now = Instant::now();
        let mut replies = table(now);
        let mut other_nonce = remote();
        other_nonce["runtimeNonce"] = json!("00000000000000000000000000000003");
        let mut other_local = local();
        other_local["sessionId"] = json!("someone-else");
        for (sender, recipient, scope, id) in [
            (other_nonce, local(), "team", ID),
            (remote(), other_local, "team", ID),
            (remote(), local(), "other", ID),
            (
                remote(),
                local(),
                "team",
                "0000000000000000000000000000000b",
            ),
            (local(), remote(), "team", ID),
            (json!(null), local(), "team", ID),
        ] {
            assert!(
                !replies.answer(&sender, &recipient, scope, id, Answer::Reply, now),
                "{sender} -> {recipient} {scope} {id}"
            );
        }
        assert!(replies.answer(&remote(), &local(), "team", ID, Answer::Reply, now));
    }

    #[test]
    fn a_reply_closes_the_entry_so_it_cannot_be_replayed() {
        let now = Instant::now();
        let mut replies = table(now);
        assert!(replies.answer(&remote(), &local(), "team", ID, Answer::Reply, now));
        assert!(!replies.answer(&remote(), &local(), "team", ID, Answer::Reply, now));
        assert!(!replies.answer(&remote(), &local(), "team", ID, Answer::Update, now));
    }

    #[test]
    fn at_most_eight_updates_then_still_one_reply() {
        let now = Instant::now();
        let mut replies = table(now);
        for n in 0..MAX_UPDATES {
            assert!(
                replies.answer(&remote(), &local(), "team", ID, Answer::Update, now),
                "update {n}"
            );
        }
        assert!(!replies.answer(&remote(), &local(), "team", ID, Answer::Update, now));
        assert!(replies.answer(&remote(), &local(), "team", ID, Answer::Reply, now));
    }

    #[test]
    fn entries_expire_600_seconds_after_the_first_send() {
        let now = Instant::now();
        let mut replies = table(now);
        let late = now + TTL - Duration::from_millis(1);
        assert!(replies.answer(&remote(), &local(), "team", ID, Answer::Update, late));
        assert!(!replies.answer(&remote(), &local(), "team", ID, Answer::Reply, now + TTL));
        assert_eq!(replies.len(), 0, "an expired entry is dropped when found");
    }

    #[test]
    fn a_retry_of_resend_never_extends_resets_or_reopens_an_entry() {
        let now = Instant::now();
        let mut replies = table(now);
        for _ in 0..MAX_UPDATES {
            assert!(replies.answer(&remote(), &local(), "team", ID, Answer::Update, now));
        }
        let resend = now + Duration::from_secs(300);
        assert_eq!(
            replies.sent(&local(), &remote(), "team", ID, resend),
            Ok(false)
        );
        assert!(
            !replies.answer(&remote(), &local(), "team", ID, Answer::Update, resend),
            "the update count is not reset"
        );
        assert!(replies.answer(&remote(), &local(), "team", ID, Answer::Reply, resend));
        assert_eq!(
            replies.sent(&local(), &remote(), "team", ID, resend),
            Ok(false)
        );
        assert!(
            !replies.answer(&remote(), &local(), "team", ID, Answer::Reply, resend),
            "a resend does not reopen an answered entry"
        );
        let mut replies = table(now);
        assert_eq!(
            replies.sent(&local(), &remote(), "team", ID, resend),
            Ok(false)
        );
        assert!(
            !replies.answer(&remote(), &local(), "team", ID, Answer::Reply, now + TTL),
            "TTL counts from the first send, not the resend"
        );
    }

    #[test]
    fn a_full_table_refuses_new_sends_until_entries_expire() {
        let now = Instant::now();
        let mut replies = Replies::default();
        let id = |n: usize| format!("{n:032x}");
        for n in 0..MAX_ENTRIES {
            assert_eq!(
                replies.sent(&local(), &remote(), "team", &id(n), now),
                Ok(true)
            );
        }
        assert_eq!(
            replies.sent(&local(), &remote(), "team", &id(MAX_ENTRIES), now),
            Err(Full)
        );
        assert_eq!(
            replies.sent(&local(), &remote(), "team", &id(0), now),
            Ok(false),
            "a resend of a recorded message still goes"
        );
        assert!(
            replies.answer(&remote(), &local(), "team", &id(0), Answer::Reply, now),
            "answered entries still count until they expire"
        );
        assert_eq!(
            replies.sent(&local(), &remote(), "team", &id(MAX_ENTRIES), now),
            Err(Full)
        );
        assert_eq!(
            replies.sent(&local(), &remote(), "team", &id(MAX_ENTRIES), now + TTL),
            Ok(true),
            "expired entries make room"
        );
        assert_eq!(replies.len(), 1);
        replies.unsent(&local(), &remote(), "team", &id(MAX_ENTRIES));
        assert_eq!(replies.len(), 0);
    }
}
