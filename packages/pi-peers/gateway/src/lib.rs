//! Volatile single-worker routing and explicit resource accounting for session communication.

pub mod breaker;
pub mod budget;
mod caps;
pub mod config;
pub mod daemon;
mod deadline;
mod events;
pub mod intern;
pub mod managed;
mod tailscale;
mod transport;
pub mod wire;

mod remote;

mod link;

mod paths;

pub mod control;
