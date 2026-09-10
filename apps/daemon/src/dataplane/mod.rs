//! Endpoint-neutral E2EE logical streams.

mod authenticated_channel;
pub mod client;
pub mod endpoint;
pub mod exec;
pub mod frame;
pub mod handshake;
pub mod preview;
pub mod rtc;
pub mod service_preview;

mod logical_connection;
pub(crate) mod logical_registry;
mod logical_wire;
