//! Volatile single-worker routing and explicit resource accounting for session communication.

pub mod breaker;
pub mod budget;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "link setup and refresh enforce the caps in the next steps"
    )
)]
mod caps;
pub mod config;
pub mod daemon;
mod deadline;
mod events;
pub mod intern;
pub mod keys;
pub mod managed;
#[expect(
    dead_code,
    reason = "link setup and diagnosis call the CLI in the next steps"
)]
mod tailscale;
mod transport;
pub mod wire;

pub mod remote;

mod link;

mod pinned;

mod paths;

pub mod control;
