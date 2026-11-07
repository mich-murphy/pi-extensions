//! Strict raw-byte framing and shallow routing-envelope validation.

use std::collections::HashSet;
use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// Largest permitted JSON body, excluding the four-byte prefix.
pub const MAX_BODY: usize = 32_764;

/// Trust boundary at which an operation is interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Role {
    /// Requests supplied by a Unix client.
    LocalClient,
    /// Authenticated inter-gateway traffic.
    RemoteLink,
    /// Gateway-authenticated forwarding envelopes.
    GatewayForward,
    /// Deliveries and reads directed to an adapter.
    AdapterDelivery,
}

/// Structural failure closes the affected connection without echoing hostile input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError;

impl fmt::Display for DecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid protocol frame")
    }
}
impl std::error::Error for DecodeError {}

struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = Unique;
            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a non-null JSON value with unique object keys")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(value)))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Unique, E> {
                if value > 9_007_199_254_740_991 {
                    return Err(E::custom("integer range"));
                }
                Ok(Unique(Value::from(value)))
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Unique, E> {
                Err(E::custom("negative integer"))
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Unique, E> {
                Err(E::custom("non-integer lexeme"))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Unique, E> {
                Ok(Unique(Value::String(value.to_owned())))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Unique, E> {
                Ok(Unique(Value::String(value)))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Unique, A::Error> {
                let mut values = Vec::new();
                while let Some(Unique(value)) = sequence.next_element()? {
                    if values.len() == 64 {
                        return Err(de::Error::custom("array limit"));
                    }
                    values.push(value);
                }
                Ok(Unique(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut mapping: A) -> Result<Unique, A::Error> {
                let mut values = Map::new();
                while let Some(key) = mapping.next_key::<String>()? {
                    if !key.is_ascii() || values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate or non-ASCII key"));
                    }
                    let Unique(value) = mapping.next_value()?;
                    values.insert(key, value);
                }
                Ok(Unique(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(StrictVisitor)
    }
}

/// Checks a declared body length before any body allocation.
///
/// # Errors
/// Returns an error for zero or an oversized declaration.
pub fn body_length(header: [u8; 4]) -> Result<usize, DecodeError> {
    let length = usize::try_from(u32::from_be_bytes(header)).map_err(|_| DecodeError)?;
    if (1..=MAX_BODY).contains(&length) {
        Ok(length)
    } else {
        Err(DecodeError)
    }
}

/// Decodes exactly one complete length-prefixed routing frame.
///
/// # Errors
/// Rejects framing, strict JSON, generic bounds, and envelope schema violations.
pub fn decode_frame(bytes: &[u8], role: Role) -> Result<Value, DecodeError> {
    let header: [u8; 4] = bytes
        .get(..4)
        .ok_or(DecodeError)?
        .try_into()
        .map_err(|_| DecodeError)?;
    let length = body_length(header)?;
    if bytes.len() != length + 4 {
        return Err(DecodeError);
    }
    decode_body(&bytes[4..], role)
}

/// Decodes a JSON body while preserving duplicate-key and number-lexeme evidence.
///
/// # Errors
/// Rejects invalid strict JSON, generic limits and operation-envelope violations.
pub fn decode_json(bytes: &[u8], _role: Role) -> Result<Value, DecodeError> {
    if bytes.is_empty() || bytes.len() > MAX_BODY {
        return Err(DecodeError);
    }
    // Bound nesting before serde recurses or allocates containers. Outside strings,
    // minus, decimal and exponent tokens are forbidden even when numerically integral.
    let mut quoted = false;
    let mut escaped = false;
    let mut depth = 0_u8;
    for &byte in bytes {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' | b'[' => {
                    depth = depth.checked_add(1).ok_or(DecodeError)?;
                    if depth > 16 {
                        return Err(DecodeError);
                    }
                }
                b'}' | b']' => depth = depth.checked_sub(1).ok_or(DecodeError)?,
                b'-' | b'.' => return Err(DecodeError),
                _ => {}
            }
        }
    }
    let Unique(value) = serde_json::from_slice(bytes).map_err(|_| DecodeError)?;
    if !value.is_object() {
        return Err(DecodeError);
    }
    Ok(value)
}

fn object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, DecodeError> {
    let fields = value.as_object().ok_or(DecodeError)?;
    if required.iter().any(|key| !fields.contains_key(*key))
        || fields
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(DecodeError);
    }
    Ok(fields)
}
fn text(value: &Value, maximum: usize) -> Result<&str, DecodeError> {
    let value = value.as_str().ok_or(DecodeError)?;
    if value.is_empty() || value.len() > maximum {
        return Err(DecodeError);
    }
    Ok(value)
}
fn plain(value: &Value, maximum: usize) -> Result<&str, DecodeError> {
    let value = text(value, maximum)?;
    if value.chars().any(char::is_control) {
        return Err(DecodeError);
    }
    Ok(value)
}
fn identifier(value: &Value) -> Result<(), DecodeError> {
    let value = text(value, 32)?;
    if value.len() != 32
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(DecodeError);
    }
    Ok(())
}
fn machine(value: &Value) -> Result<(), DecodeError> {
    let value = text(value, 32)?;
    if !value.as_bytes()[0].is_ascii_lowercase()
        || !value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(DecodeError);
    }
    Ok(())
}
fn key(value: &Value) -> Result<(), DecodeError> {
    if !text(value, 64)?
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(DecodeError);
    }
    Ok(())
}
fn peer(value: &Value) -> Result<(), DecodeError> {
    object(value, &["machineId", "sessionId", "runtimeNonce"], &[])?;
    machine(&value["machineId"])?;
    plain(&value["sessionId"], 256)?;
    identifier(&value["runtimeNonce"])
}
fn scopes(value: &Value, maximum: usize) -> Result<(), DecodeError> {
    let values = value.as_array().ok_or(DecodeError)?;
    if values.is_empty() || values.len() > maximum {
        return Err(DecodeError);
    }
    let mut unique = HashSet::new();
    for value in values {
        key(value)?;
        if !unique.insert(value.as_str()) {
            return Err(DecodeError);
        }
    }
    Ok(())
}
fn work(value: &Value) -> Result<(), DecodeError> {
    match value["kind"].as_str() {
        Some("request") => {
            object(value, &["kind", "origin", "requestId"], &[])?;
            peer(&value["origin"])?;
            identifier(&value["requestId"])
        }
        Some("publication") => {
            object(value, &["kind", "publisher", "key"], &[])?;
            peer(&value["publisher"])?;
            key(&value["key"])
        }
        _ => Err(DecodeError),
    }
}
fn enum_value(value: &Value, choices: &[&str]) -> Result<(), DecodeError> {
    if value.as_str().is_some_and(|text| choices.contains(&text)) {
        Ok(())
    } else {
        Err(DecodeError)
    }
}
fn message(value: &Value) -> Result<(), DecodeError> {
    object(
        value,
        &["id", "kind", "content", "format"],
        &["work", "replyTo", "status", "refs"],
    )?;
    identifier(&value["id"])?;
    enum_value(&value["kind"], &["request", "reply", "update"])?;
    text(&value["content"], 24576)?;
    enum_value(
        &value["format"],
        &["text", "markdown", "git-diff", "git-format-patch"],
    )?;
    if let Some(value) = value.get("work") {
        work(value)?;
    }
    if let Some(reply) = value.get("replyTo") {
        object(reply, &["sender", "messageId"], &[])?;
        peer(&reply["sender"])?;
        identifier(&reply["messageId"])?;
    } else if value["kind"] == "reply" {
        return Err(DecodeError);
    }
    if let Some(status) = value.get("status") {
        if value["kind"] == "request" {
            return Err(DecodeError);
        }
        enum_value(
            status,
            &[
                "accepted",
                "declined",
                "needs_clarification",
                "planned",
                "in_progress",
                "blocked",
                "completed",
                "failed",
                "cancelled",
            ],
        )?;
    }
    if let Some(refs) = value.get("refs") {
        references(refs)?;
    }
    Ok(())
}
fn references(refs: &Value) -> Result<(), DecodeError> {
    let refs = refs.as_array().ok_or(DecodeError)?;
    if refs.len() > 8 {
        return Err(DecodeError);
    }
    for reference in refs {
        match reference["kind"].as_str() {
            Some("publication") => {
                object(reference, &["kind", "publisher", "key", "revision"], &[])?;
                peer(&reference["publisher"])?;
                key(&reference["key"])?;
                number(&reference["revision"])?;
            }
            Some("resource") => {
                object(reference, &["kind", "machineId", "locator"], &["label"])?;
                machine(&reference["machineId"])?;
                plain(&reference["locator"], 1024)?;
                if let Some(label) = reference.get("label") {
                    plain(label, 128)?;
                }
            }
            _ => return Err(DecodeError),
        }
    }

    Ok(())
}
fn number(value: &Value) -> Result<(), DecodeError> {
    value.as_u64().map(|_| ()).ok_or(DecodeError)
}

pub(crate) fn validate_value(value: &Value, role: Role) -> Result<(), DecodeError> {
    let op = value["op"].as_str().ok_or(DecodeError)?;
    if value["v"] != 1 {
        return Err(DecodeError);
    }
    identifier(&value["rid"])?;
    let (required, optional): (&[&str], &[&str]) = match op {
        "register" if role == Role::LocalClient => {
            (&["sessionId", "runtimeNonce", "scopeIds", "label"], &[])
        }
        "close" if role == Role::LocalClient => (&[], &[]),
        "ping" if role == Role::RemoteLink => (&[], &[]),
        "discover" if matches!(role, Role::LocalClient | Role::RemoteLink) => {
            (&["scopeIds", "watch"], &[])
        }
        "unwatch" if matches!(role, Role::LocalClient | Role::RemoteLink) => (&["watchRid"], &[]),
        "send" if role != Role::AdapterDelivery => (&["to", "scopeId", "message"], &["from"]),
        "deliver" if role == Role::AdapterDelivery => (&["from", "to", "scopeId", "message"], &[]),
        "state.get" => (
            &["publisher", "scopeId", "key"],
            &["from", "expectedRevision"],
        ),
        "state.list" => (&["publisher", "scopeId"], &["from"]),
        "interest.add" | "interest.remove" => (&["publisher", "scopeId", "work"], &["from"]),
        "result" => (&["forOp", "outcome"], &[]),
        "roster.event" => (&["event"], &[]),
        _ => return Err(DecodeError),
    };
    let mut required = required.to_vec();
    required.extend(["v", "op", "rid"]);
    let fields = object(value, &required, optional)?;
    for (name, field) in fields {
        match name.as_str() {
            "to" | "from" | "publisher" => peer(field)?,
            "sessionId" => {
                plain(field, 256)?;
            }
            "runtimeNonce" | "watchRid" => identifier(field)?,
            "scopeId" | "key" => key(field)?,
            "scopeIds" => scopes(field, if op == "register" { 4 } else { 64 })?,
            "label" => {
                plain(field, 128)?;
            }
            "watch" => {
                field.as_bool().ok_or(DecodeError)?;
            }
            "message" => message(field)?,
            "work" => work(field)?,
            "expectedRevision" => number(field)?,
            _ => {}
        }
    }
    if matches!(
        op,
        "send" | "state.get" | "state.list" | "interest.add" | "interest.remove"
    ) && (role == Role::LocalClient) == fields.contains_key("from")
    {
        return Err(DecodeError);
    }
    if op == "result" {
        result(value)?;
    }
    if op == "roster.event" {
        event(&value["event"])?;
    }
    authored_bytes(value)
        .filter(|bytes| *bytes <= 24576)
        .ok_or(DecodeError)?;
    Ok(())
}
fn authored_bytes(value: &Value) -> Option<usize> {
    match value {
        Value::Object(fields) => fields.iter().try_fold(0_usize, |total, (name, value)| {
            let bytes = if matches!(
                name.as_str(),
                "content" | "title" | "summary" | "label" | "locator"
            ) {
                value.as_str()?.len()
            } else {
                authored_bytes(value)?
            };
            total.checked_add(bytes)
        }),
        Value::Array(values) => values.iter().try_fold(0_usize, |total, value| {
            total.checked_add(authored_bytes(value)?)
        }),
        _ => Some(0),
    }
}

fn descriptor(value: &Value) -> Result<(), DecodeError> {
    object(value, &["peer", "label", "scopeIds"], &[])?;
    peer(&value["peer"])?;
    plain(&value["label"], 128)?;
    scopes(&value["scopeIds"], 4)?;
    if serde_json::to_vec(value).map_err(|_| DecodeError)?.len() > 512 {
        return Err(DecodeError);
    }
    Ok(())
}
fn event(value: &Value) -> Result<(), DecodeError> {
    match value["tag"].as_str() {
        Some("upsert") => {
            object(value, &["tag", "peer"], &[])?;
            descriptor(&value["peer"])
        }
        Some("remove") => {
            object(value, &["tag", "peer"], &[])?;
            peer(&value["peer"])
        }
        Some("invalidated") => {
            object(value, &["tag", "reason"], &[])?;
            enum_value(&value["reason"], &["overflow", "policy_changed"])
        }
        _ => Err(DecodeError),
    }
}
fn result(value: &Value) -> Result<(), DecodeError> {
    let op = value["forOp"].as_str().ok_or(DecodeError)?;
    enum_value(
        &value["forOp"],
        &[
            "register",
            "close",
            "ping",
            "discover",
            "unwatch",
            "send",
            "deliver",
            "state.get",
            "state.list",
            "interest.add",
            "interest.remove",
        ],
    )?;
    let outcome = &value["outcome"];
    let tag = outcome["tag"].as_str().ok_or(DecodeError)?;
    if matches!(op, "send" | "deliver") {
        let extra = match tag {
            "admitted" => "correlation",
            "not_admitted" | "unknown" => "code",
            _ => return Err(DecodeError),
        };
        object(
            outcome,
            &["tag", "binding", extra],
            if tag == "not_admitted" {
                &["resource"]
            } else {
                &[]
            },
        )?;
        let binding = &outcome["binding"];
        object(
            binding,
            &["messageId", "sender", "recipient", "scopeId"],
            &[],
        )?;
        identifier(&binding["messageId"])?;
        peer(&binding["sender"])?;
        peer(&binding["recipient"])?;
        key(&binding["scopeId"])?;
        if tag == "admitted" {
            return enum_value(&outcome["correlation"], &["none", "verified", "unresolved"]);
        }
        if tag == "unknown" {
            if op == "deliver" {
                return Err(DecodeError);
            }
            return enum_value(
                &outcome["code"],
                &["unavailable", "protocol_error", "cancelled"],
            );
        }
        return error_outcome(outcome, op);
    }
    match tag {
        "error" => {
            object(outcome, &["tag", "code"], &["resource"])?;
            error_outcome(outcome, op)
        }
        "ok" => {
            object(outcome, &["tag", "value"], &[])?;
            success(&outcome["value"], op)
        }
        _ => Err(DecodeError),
    }
}
fn error_outcome(value: &Value, op: &str) -> Result<(), DecodeError> {
    let code = text(&value["code"], 64)?;
    let allowed = match code {
        "forbidden" | "overloaded" | "unavailable" => true,
        "already_registered" | "descriptor_too_large" => op == "register",
        "no_route" => matches!(
            op,
            "send" | "deliver" | "state.get" | "state.list" | "interest.add" | "interest.remove"
        ),
        "id_conflict" | "invalid_correlation" | "delivery_too_large" => {
            matches!(op, "send" | "deliver")
        }
        "not_found" => matches!(op, "state.get" | "interest.add"),
        "revision_mismatch" => op == "state.get",
        _ => false,
    };
    if !allowed {
        return Err(DecodeError);
    }
    if code == "overloaded" {
        enum_value(
            &value["resource"],
            &[
                "registrations",
                "inbox",
                "receipts",
                "relations",
                "interests",
                "publications",
                "operations",
                "buffers",
                "watch",
            ],
        )?;
    } else if value.get("resource").is_some() {
        return Err(DecodeError);
    }
    Ok(())
}
fn success(value: &Value, op: &str) -> Result<(), DecodeError> {
    match op {
        "register" => {
            object(value, &["peer", "scopeIds"], &[])?;
            peer(&value["peer"])?;
            scopes(&value["scopeIds"], 4)
        }
        "close" | "ping" | "unwatch" => {
            object(value, &[], &[])?;
            Ok(())
        }
        "discover" => {
            object(value, &["peers", "watching"], &[])?;
            value["watching"].as_bool().ok_or(DecodeError)?;
            let peers = value["peers"].as_array().ok_or(DecodeError)?;
            if peers.len() > 60 {
                return Err(DecodeError);
            }
            for peer in peers {
                descriptor(peer)?;
            }
            Ok(())
        }
        // Authored publication/work-state semantics belong to the adapter. These
        // generic routing result bodies still reject unknown outer fields.
        "state.get" => {
            object(value, &["publisher", "scopeId", "publication"], &[])?;
            peer(&value["publisher"])?;
            key(&value["scopeId"])?;
            publication(&value["publication"], PublicationKind::Full)
        }
        "state.list" => {
            object(value, &["publisher", "scopeId", "revision", "items"], &[])?;
            peer(&value["publisher"])?;
            key(&value["scopeId"])?;
            number(&value["revision"])?;
            let items = value["items"].as_array().ok_or(DecodeError)?;
            if items.len() > 16 {
                return Err(DecodeError);
            }
            for item in items {
                publication(item, PublicationKind::Summary)?;
            }
            Ok(())
        }
        "interest.add" | "interest.remove" => {
            object(
                value,
                &["publisher", "scopeId", "work", "active"],
                if op == "interest.add" {
                    &["expiresInMs", "current"]
                } else {
                    &[]
                },
            )?;
            peer(&value["publisher"])?;
            key(&value["scopeId"])?;
            work(&value["work"])?;
            let active = value["active"].as_bool().ok_or(DecodeError)?;
            if active {
                if op == "interest.remove" || value["expiresInMs"] != 86_400_000 {
                    return Err(DecodeError);
                }
            } else if value.get("expiresInMs").is_some() {
                return Err(DecodeError);
            }
            if op == "interest.add"
                && !active
                && !value.get("current").is_some_and(|current| {
                    current["status"].as_str().is_some_and(|status| {
                        ["completed", "failed", "cancelled", "declined"].contains(&status)
                    })
                })
            {
                return Err(DecodeError);
            }
            if let Some(current) = value.get("current") {
                if active
                    && current["status"].as_str().is_some_and(|status| {
                        ["completed", "failed", "cancelled", "declined"].contains(&status)
                    })
                {
                    return Err(DecodeError);
                }
                object(current, &["key", "revision"], &["status"])?;
                key(&current["key"])?;
                number(&current["revision"])?;
                if let Some(status) = current.get("status") {
                    status_value(status)?;
                }
            }
            Ok(())
        }
        _ => Err(DecodeError),
    }
}
#[derive(Clone, Copy)]
enum PublicationKind {
    Full,
    Summary,
}
fn status_value(value: &Value) -> Result<(), DecodeError> {
    enum_value(
        value,
        &[
            "accepted",
            "declined",
            "needs_clarification",
            "planned",
            "in_progress",
            "blocked",
            "completed",
            "failed",
            "cancelled",
        ],
    )
}
fn publication(value: &Value, kind: PublicationKind) -> Result<(), DecodeError> {
    let required: &[&str] = match kind {
        PublicationKind::Full => &[
            "key",
            "revision",
            "category",
            "title",
            "summary",
            "format",
            "preparation",
        ],
        PublicationKind::Summary => &["key", "revision", "category", "title"],
    };
    let optional: &[&str] = match kind {
        PublicationKind::Full => &["content", "work", "status", "refs"],
        PublicationKind::Summary => &["work", "status"],
    };
    object(value, required, optional)?;
    key(&value["key"])?;
    number(&value["revision"])?;
    text(&value["title"], 128)?;
    enum_value(
        &value["category"],
        &["context", "research", "spec", "plan", "finding", "work"],
    )?;
    if let Some(work_ref) = value.get("work") {
        work(work_ref)?;
    }
    if value["category"] == "work" && value.get("work").is_none() {
        return Err(DecodeError);
    }
    if let Some(status) = value.get("status") {
        if value["category"] != "work" {
            return Err(DecodeError);
        }
        status_value(status)?;
    }
    if matches!(kind, PublicationKind::Full) {
        text(&value["summary"], 1024)?;
        if let Some(content) = value.get("content") {
            text(content, 24576)?;
        }
        enum_value(
            &value["format"],
            &["text", "markdown", "git-diff", "git-format-patch"],
        )?;
        if let Some(refs) = value.get("refs") {
            references(refs)?;
        }
        enum_value(
            &value["preparation"],
            &["authored", "summarized", "curated"],
        )?;
    }
    Ok(())
}

/// Decodes a complete JSON body at the routing boundary, including encoded descriptor spans.
///
/// # Errors
/// Rejects all generic, schema, role and descriptor-encoding violations.
pub fn decode_body(bytes: &[u8], role: Role) -> Result<Value, DecodeError> {
    let value = decode_json(bytes, role)?;
    validate_value(&value, role)?;
    if value["op"] == "roster.event" && value["event"]["tag"] == "upsert" {
        let event = raw_field(bytes, "event")?;
        let peer = raw_field(event.get().as_bytes(), "peer")?;
        if peer.get().len() > 512 {
            return Err(DecodeError);
        }
    }
    if value["op"] == "result" && value["forOp"] == "discover" && value["outcome"]["tag"] == "ok" {
        let outcome = raw_field(bytes, "outcome")?;
        let result = raw_field(outcome.get().as_bytes(), "value")?;
        let peers = raw_field(result.get().as_bytes(), "peers")?;
        let peers: Vec<&serde_json::value::RawValue> =
            serde_json::from_str(peers.get()).map_err(|_| DecodeError)?;
        if peers.iter().any(|peer| peer.get().len() > 512) {
            return Err(DecodeError);
        }
    }
    Ok(value)
}
fn raw_field<'a>(
    bytes: &'a [u8],
    key: &str,
) -> Result<&'a serde_json::value::RawValue, DecodeError> {
    let mut fields: std::collections::BTreeMap<String, &serde_json::value::RawValue> =
        serde_json::from_slice(bytes).map_err(|_| DecodeError)?;
    fields.remove(key).ok_or(DecodeError)
}
