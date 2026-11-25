//! Per-link `PeerRef` interning for gateway-to-gateway `send` frames.
//!
//! Each side numbers the peers it exports, in the order it sends their roster upserts, and the
//! other side numbers them identically as it imports them. Numbers are never reused within one
//! link, and a new link starts with empty tables, so no number outlives its link generation.
use std::collections::HashMap;

use serde_json::Value;

/// Most peers numbered per direction on one link; later peers travel in full.
pub const MAX_REFS: usize = 1024;

#[derive(Debug, Default)]
struct Numbering {
    peers: Vec<Value>,
    index: HashMap<String, u64>,
}
impl Numbering {
    fn add(&mut self, peer: &Value, cap: usize) {
        let key = peer.to_string();
        if self.peers.len() < cap
            && !self.index.contains_key(&key)
            && let Ok(number) = u64::try_from(self.peers.len())
        {
            self.index.insert(key, number);
            self.peers.push(peer.clone());
        }
    }
    fn number(&self, peer: &Value) -> Option<u64> {
        self.index.get(&peer.to_string()).copied()
    }
    fn peer(&self, number: u64) -> Option<&Value> {
        usize::try_from(number)
            .ok()
            .and_then(|index| self.peers.get(index))
    }
}

/// A `send` frame named a number the link never assigned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownRef;

/// The interning tables of one link generation.
#[derive(Debug)]
pub struct Refs {
    cap: usize,
    exported: Numbering,
    imported: Numbering,
}
impl Default for Refs {
    fn default() -> Self {
        Self::new(MAX_REFS)
    }
}
impl Refs {
    /// Empty tables numbering at most `cap` peers per direction.
    #[must_use]
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            exported: Numbering::default(),
            imported: Numbering::default(),
        }
    }
    /// Records a peer this side just sent to the link in a roster upsert or snapshot.
    pub fn exported(&mut self, peer: &Value) {
        self.exported.add(peer, self.cap);
    }
    /// Records a peer this side just accepted from the link in a roster upsert or snapshot.
    pub fn imported(&mut self, peer: &Value) {
        self.imported.add(peer, self.cap);
    }
    /// Numbers held per direction: (exported, imported).
    #[must_use]
    pub fn sizes(&self) -> (usize, usize) {
        (self.exported.peers.len(), self.imported.peers.len())
    }
    /// Replaces a numbered `from` (ours) and `to` (theirs) in an outgoing `send`.
    pub fn compress(&self, frame: &mut Value) {
        if let Some(number) = self.exported.number(&frame["from"]) {
            frame["from"] = Value::from(number);
        }
        if let Some(number) = self.imported.number(&frame["to"]) {
            frame["to"] = Value::from(number);
        }
    }
    /// Restores full `from` (theirs) and `to` (ours) in an incoming `send`.
    ///
    /// # Errors
    /// Returns [`UnknownRef`] when a number was never assigned on this link.
    pub fn expand(&self, frame: &mut Value) -> Result<(), UnknownRef> {
        for (field, table) in [("from", &self.imported), ("to", &self.exported)] {
            if let Some(number) = frame[field].as_u64() {
                frame[field] = table.peer(number).ok_or(UnknownRef)?.clone();
            }
        }
        Ok(())
    }
}
