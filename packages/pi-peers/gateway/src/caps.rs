//! The `pi-peers` app capability: what one remote node may do to this node's sessions.
//!
//! Tailscale appends the values of every grant that matches into one list, so each entry is read
//! on its own and grants exactly `entry.scopes × entry.allow`. Scopes and verbs are never unioned
//! across entries. Anything unknown or malformed grants nothing; bounds violations grant nothing
//! and close the link.
use std::collections::BTreeSet;

use serde_json::Value;
use serde_json::value::RawValue;

use crate::wire::{self, Role};

/// The app capability name granted in the tailnet policy file.
pub(crate) const CAPABILITY: &str = "github.com/mich-murphy/cap/pi-peers";
const MAX_BYTES: usize = 16 * 1024;
const MAX_ENTRIES: usize = 64;
const MAX_SCOPES: usize = 64;

/// One action a remote node may take on this node's sessions in a scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Verb {
    /// Receive roster entries for this node's sessions.
    Discover,
    /// Deliver `request`, `update` or `reply` to this node's sessions.
    Push,
    /// Deliver `reply`, or `update` with `replyTo`, only for messages this node sent to it.
    Reply,
}
impl Verb {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "discover" => Some(Self::Discover),
            "push" => Some(Self::Push),
            "reply" => Some(Self::Reply),
            _ => None,
        }
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Discover => "discover",
            Self::Push => "push",
            Self::Reply => "reply",
        }
    }
}

/// The granted `(scope, verb)` pairs; `push` always brings `reply` with it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Caps(BTreeSet<(String, Verb)>);

/// The capability value exceeded a bound: it grants nothing and the link closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Bounds;

/// What parsing skipped, for the audit log. Skipping only ever removes privilege.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Ignored {
    pub(crate) entries: usize,
    pub(crate) verbs: usize,
    pub(crate) scopes: usize,
}
impl Ignored {
    pub(crate) fn any(self) -> bool {
        self.entries + self.verbs + self.scopes > 0
    }
}

fn strings(value: &Value) -> Option<Vec<&str>> {
    value.as_array()?.iter().map(Value::as_str).collect()
}

impl Caps {
    /// Reads the raw `pi-peers` capability value from a whois `CapMap`; `None` grants nothing.
    ///
    /// # Errors
    /// More than 16 KiB of JSON, more than 64 entries or an entry with more than 64 scopes.
    pub(crate) fn parse(raw: Option<&RawValue>) -> Result<(Self, Ignored), Bounds> {
        let mut granted = BTreeSet::new();
        let mut ignored = Ignored::default();
        let Some(raw) = raw else {
            return Ok((Self(granted), ignored));
        };
        if raw.get().len() > MAX_BYTES {
            return Err(Bounds);
        }
        let Ok(entries) = serde_json::from_str::<Vec<&RawValue>>(raw.get()) else {
            ignored.entries += 1;
            return Ok((Self(granted), ignored));
        };
        if entries.len() > MAX_ENTRIES {
            return Err(Bounds);
        }
        for entry in entries {
            let Ok(value) = serde_json::from_str::<Value>(entry.get()) else {
                ignored.entries += 1;
                continue;
            };
            if value["scopes"]
                .as_array()
                .is_some_and(|scopes| scopes.len() > MAX_SCOPES)
            {
                return Err(Bounds);
            }
            // Strict decoding refuses duplicate keys, so an entry can never mean two things.
            let strict = wire::decode_json(entry.get().as_bytes(), Role::RemoteLink).is_ok();
            let (true, Some(scopes), Some(allow)) =
                (strict, strings(&value["scopes"]), strings(&value["allow"]))
            else {
                ignored.entries += 1;
                continue;
            };
            let mut verbs = Vec::new();
            for verb in allow {
                match Verb::parse(verb) {
                    Some(Verb::Push) => verbs.extend([Verb::Push, Verb::Reply]),
                    Some(verb) => verbs.push(verb),
                    None => ignored.verbs += 1,
                }
            }
            for scope in scopes {
                if !crate::config::scope(scope) {
                    ignored.scopes += 1;
                    continue;
                }
                for verb in &verbs {
                    granted.insert((scope.to_owned(), *verb));
                }
            }
        }
        Ok((Self(granted), ignored))
    }

    pub(crate) fn allows(&self, scope: &str, verb: Verb) -> bool {
        self.0.contains(&(scope.to_owned(), verb))
    }

    /// The scopes in which `verb` is granted, sorted.
    pub(crate) fn scopes(&self, verb: Verb) -> Vec<String> {
        self.0
            .iter()
            .filter(|(_, granted)| *granted == verb)
            .map(|(scope, _)| scope.clone())
            .collect()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `[{"scope":..,"actions":[..]}]`, sorted, as `--diagnose` reports it.
    pub(crate) fn report(&self) -> Value {
        let mut report: Vec<(String, Vec<&'static str>)> = Vec::new();
        for (scope, verb) in &self.0 {
            match report.last_mut() {
                Some((last, actions)) if last == scope => actions.push(verb.as_str()),
                _ => report.push((scope.clone(), vec![verb.as_str()])),
            }
        }
        Value::Array(
            report
                .into_iter()
                .map(|(scope, actions)| serde_json::json!({"scope":scope,"actions":actions}))
                .collect(),
        )
    }

    /// A short stable digest of the granted set, for audit lines that must not list it.
    pub(crate) fn digest(&self) -> String {
        let text = self.report().to_string();
        let digest = ring::digest::digest(&ring::digest::SHA256, text.as_bytes());
        digest.as_ref()[..8]
            .iter()
            .fold(String::new(), |mut output, byte| {
                use std::fmt::Write;
                write!(output, "{byte:02x}").expect("writing to String cannot fail");
                output
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: &Value) -> Result<(Caps, Ignored), Bounds> {
        let raw = RawValue::from_string(value.to_string()).expect("raw JSON");
        Caps::parse(Some(&raw))
    }
    fn caps(value: &Value) -> Caps {
        parse(value).expect("within bounds").0
    }

    #[test]
    fn entries_never_combine_scopes_and_verbs_across_grants() {
        let granted = caps(&json!([
            {"scopes":["a"],"allow":["push"]},
            {"scopes":["b"],"allow":["discover"]}
        ]));
        assert!(granted.allows("a", Verb::Push));
        assert!(granted.allows("b", Verb::Discover));
        assert!(
            !granted.allows("b", Verb::Push),
            "no cross-entry escalation"
        );
        assert!(
            !granted.allows("b", Verb::Reply),
            "no cross-entry escalation"
        );
        assert!(
            !granted.allows("a", Verb::Discover),
            "no cross-entry escalation"
        );
    }

    #[test]
    fn push_implies_reply_and_discover_is_independent() {
        let granted = caps(&json!([{"scopes":["a"],"allow":["push"]}]));
        assert!(granted.allows("a", Verb::Reply));
        assert!(!granted.allows("a", Verb::Discover));
        let granted = caps(&json!([{"scopes":["a"],"allow":["reply","discover"]}]));
        assert!(!granted.allows("a", Verb::Push), "reply never implies push");
        assert_eq!(
            granted.report(),
            json!([{"scope":"a","actions":["discover","reply"]}])
        );
    }

    #[test]
    fn verbs_are_exact_and_unknown_ones_are_ignored() {
        let (granted, ignored) = parse(&json!([
            {"scopes":["a"],"allow":["Push","PUSH","push ","admin","discover"]}
        ]))
        .expect("bounded");
        assert_eq!(granted.scopes(Verb::Discover), vec!["a".to_owned()]);
        assert!(granted.scopes(Verb::Push).is_empty());
        assert_eq!(ignored.verbs, 4);
    }

    #[test]
    fn wildcard_and_invalid_scopes_grant_nothing() {
        let (granted, ignored) = parse(&json!([
            {"scopes":["*","a b","","x".repeat(65),"ok"],"allow":["push"]}
        ]))
        .expect("bounded");
        assert_eq!(granted.scopes(Verb::Push), vec!["ok".to_owned()]);
        assert_eq!(ignored.scopes, 4);
    }

    #[test]
    fn a_malformed_entry_is_skipped_and_the_others_still_apply() {
        for malformed in [
            json!("push"),
            json!(["a"]),
            json!({"scopes":"a","allow":["push"]}),
            json!({"scopes":["a"],"allow":"push"}),
            json!({"scopes":["a"]}),
            json!({"allow":["push"]}),
            json!({"scopes":[1],"allow":["push"]}),
            json!({"scopes":["a"],"allow":[null]}),
            Value::Null,
        ] {
            let (granted, ignored) =
                parse(&json!([malformed, {"scopes":["b"],"allow":["discover"]}])).expect("bounded");
            assert_eq!(ignored.entries, 1, "{malformed}");
            assert!(!granted.allows("a", Verb::Push), "{malformed}");
            assert!(granted.allows("b", Verb::Discover), "{malformed}");
        }
        let raw = RawValue::from_string(
            r#"[{"scopes":["a"],"scopes":["b"],"allow":["push"]},{"scopes":["c"],"allow":["push"]}]"#
                .to_owned(),
        )
        .expect("raw JSON");
        let (granted, ignored) = Caps::parse(Some(&raw)).expect("bounded");
        assert_eq!(
            ignored.entries, 1,
            "a duplicate key makes an entry ambiguous"
        );
        assert_eq!(granted.scopes(Verb::Push), vec!["c".to_owned()]);
    }

    #[test]
    fn unknown_entry_fields_are_tolerated_for_forward_compatibility() {
        let granted = caps(&json!([{"scopes":["a"],"allow":["push"],"note":"later"}]));
        assert!(granted.allows("a", Verb::Push));
    }

    #[test]
    fn bounds_grant_nothing() {
        let entry = json!({"scopes":["a"],"allow":["discover"]});
        assert!(parse(&Value::Array(vec![entry.clone(); 64])).is_ok());
        assert_eq!(parse(&Value::Array(vec![entry; 65])), Err(Bounds));
        let scopes: Vec<_> = (0..64).map(|n| format!("s{n}")).collect();
        assert!(parse(&json!([{"scopes":scopes,"allow":["push"]}])).is_ok());
        let scopes: Vec<_> = (0..65).map(|n| format!("s{n}")).collect();
        assert_eq!(
            parse(&json!([{"scopes":scopes,"allow":["push"]}])),
            Err(Bounds)
        );
        let large = json!([{"scopes":["a"],"allow":["push"],"pad":"x".repeat(16 * 1024)}]);
        assert_eq!(parse(&large), Err(Bounds));
    }

    #[test]
    fn absent_capability_grants_nothing() {
        let (granted, ignored) = Caps::parse(None).expect("absent is not a bound violation");
        assert!(granted.is_empty());
        assert!(!ignored.any());
        assert_eq!(granted.report(), json!([]));
        assert!(caps(&json!([])).is_empty());
    }

    #[test]
    fn the_digest_follows_the_granted_set_only() {
        let first = caps(&json!([{"scopes":["a","b"],"allow":["discover"]}]));
        let same = caps(&json!([
            {"scopes":["b"],"allow":["discover"]},
            {"scopes":["a"],"allow":["discover","unknown"]}
        ]));
        assert_eq!(first.digest(), same.digest());
        assert_eq!(first.digest().len(), 16);
        let other = caps(&json!([{"scopes":["a"],"allow":["discover"]}]));
        assert_ne!(first.digest(), other.digest());
    }
}
