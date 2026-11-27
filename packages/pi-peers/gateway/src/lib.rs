//! Volatile single-worker routing and explicit resource accounting for session communication.

pub mod breaker;
pub mod budget;
#[expect(
    dead_code,
    reason = "link setup reads caps once the Tailscale identity module lands"
)]
mod caps;
pub mod config;
pub mod daemon;
mod deadline;
mod events;
pub mod intern;
pub mod keys;
pub mod managed;
mod transport;
pub mod wire;

pub mod remote;

mod link;

mod pinned;

mod paths;

pub mod control;
