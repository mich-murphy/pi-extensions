//! Bounded retained-buffer accounting including reserved terminal-control headroom.

use std::collections::{HashMap, HashSet};
use std::fmt;

const KIB: usize = 1024;
const GLOBAL_LIMIT: usize = 8 * 1024 * KIB;
const GLOBAL_CONTROL: usize = 256 * KIB;

/// Connection generation; never reused while a gateway process is alive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnectionId(pub u64);

/// Local sockets and remote links have independent C7 byte ceilings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConnectionKind {
    /// User-owned Unix socket connection.
    Local,
    /// Authenticated remote gateway link.
    Remote,
}

impl ConnectionKind {
    const fn ceiling(self) -> usize {
        match self {
            Self::Local => 256 * KIB,
            Self::Remote => 1024 * KIB,
        }
    }

    const fn control(self) -> usize {
        match self {
            Self::Local => 32 * KIB,
            Self::Remote => 128 * KIB,
        }
    }
}

/// Only terminal controls may consume the reserved control headroom.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum BufferClass {
    /// Bodies, snapshots, ordinary watch events and forwarding buffers.
    Data,
    /// Bounded receipts, refusals, invalidations, pings and close signals.
    Control,
}

/// A reservation failure never installs a partial charge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveBufferError;

impl fmt::Display for ReserveBufferError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("buffer capacity unavailable")
    }
}

impl std::error::Error for ReserveBufferError {}

#[derive(Debug)]
struct ConnectionUsage {
    kind: ConnectionKind,
    total: usize,
    data: usize,
}

/// Single-worker ledger; each actual retained allocation owns one reservation.
#[derive(Debug, Default)]
pub struct Buffers {
    connections: HashMap<ConnectionId, ConnectionUsage>,
    total: usize,
    data: usize,
    last_generation: Option<u64>,
    retired: HashSet<ConnectionId>,
}

/// Unique charge token, consumed on release so callers cannot double-release it.
#[derive(Debug)]
pub struct BufferReservation {
    connection: ConnectionId,
    class: BufferClass,
    bytes: usize,
}

impl Buffers {
    /// Creates an empty ledger without reserving any connection entitlement.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a connection without replacing any existing generation's accounting.
    ///
    /// # Errors
    /// Returns an error if this generation already exists.
    pub fn open(
        &mut self,
        connection: ConnectionId,
        kind: ConnectionKind,
    ) -> Result<(), ReserveBufferError> {
        use std::collections::hash_map::Entry;
        if self
            .last_generation
            .is_some_and(|last| connection.0 <= last)
        {
            return Err(ReserveBufferError);
        }
        match self.connections.entry(connection) {
            Entry::Vacant(entry) => {
                entry.insert(ConnectionUsage {
                    kind,
                    total: 0,
                    data: 0,
                });
                self.last_generation = Some(connection.0);
                Ok(())
            }
            Entry::Occupied(_) => Err(ReserveBufferError),
        }
    }

    /// Atomically checks connection and aggregate ceilings before retaining bytes.
    ///
    /// Charge actual temporary copies separately. Shared immutable storage is charged
    /// once by its owner, not once per reference. No producer may wait outside this ledger.
    ///
    /// # Errors
    /// Returns an error for a missing connection or any exceeded byte ceiling.
    pub fn reserve(
        &mut self,
        connection: ConnectionId,
        class: BufferClass,
        bytes: usize,
    ) -> Result<BufferReservation, ReserveBufferError> {
        if self.retired.contains(&connection) {
            return Err(ReserveBufferError);
        }
        let usage = self
            .connections
            .get_mut(&connection)
            .ok_or(ReserveBufferError)?;
        let total = self.total.checked_add(bytes).ok_or(ReserveBufferError)?;
        let connection_total = usage.total.checked_add(bytes).ok_or(ReserveBufferError)?;
        if total > GLOBAL_LIMIT || connection_total > usage.kind.ceiling() {
            return Err(ReserveBufferError);
        }
        if class == BufferClass::Control
            && (self.total - self.data + bytes > GLOBAL_CONTROL
                || usage.total - usage.data + bytes > usage.kind.control())
        {
            return Err(ReserveBufferError);
        }
        if class == BufferClass::Data {
            let data = self.data.checked_add(bytes).ok_or(ReserveBufferError)?;
            let connection_data = usage.data.checked_add(bytes).ok_or(ReserveBufferError)?;
            if data > GLOBAL_LIMIT - GLOBAL_CONTROL
                || connection_data > usage.kind.ceiling() - usage.kind.control()
            {
                return Err(ReserveBufferError);
            }
            self.data = data;
            usage.data = connection_data;
        }
        self.total = total;
        usage.total = connection_total;
        Ok(BufferReservation {
            connection,
            class,
            bytes,
        })
    }

    /// Releases exactly one allocation charge issued by this same ledger.
    ///
    /// Tokens must never be transferred between ledgers. Tokens for connections already
    /// closed in their originating ledger are inert. The daemon owns exactly one ledger.
    ///
    /// # Panics
    /// May panic on accounting underflow if given a token issued by a different ledger.
    #[expect(
        clippy::needless_pass_by_value,
        reason = "consuming a unique charge prevents double release"
    )]
    pub fn release(&mut self, reservation: BufferReservation) {
        if let Some(usage) = self.connections.get_mut(&reservation.connection) {
            usage.total -= reservation.bytes;
            self.total -= reservation.bytes;
            if reservation.class == BufferClass::Data {
                usage.data -= reservation.bytes;
                self.data -= reservation.bytes;
            }
            if usage.total == 0 && self.retired.remove(&reservation.connection) {
                self.connections.remove(&reservation.connection);
            }
        }
    }

    /// Stops new reservations while retaining charges still owned by async buffers.
    pub fn retire(&mut self, connection: ConnectionId) {
        if self
            .connections
            .get(&connection)
            .is_some_and(|usage| usage.total > 0)
        {
            self.retired.insert(connection);
        } else {
            self.close(connection);
        }
    }

    /// Removes a connection and all charges after dropping its retained buffers.
    pub fn close(&mut self, connection: ConnectionId) {
        self.retired.remove(&connection);
        if let Some(usage) = self.connections.remove(&connection) {
            self.total -= usage.total;
            self.data -= usage.data;
        }
    }

    /// Returns current aggregate retained bytes, including terminal controls.
    pub fn retained_bytes(&self) -> usize {
        self.total
    }
}
