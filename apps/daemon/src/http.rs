//! HTTP client used by Hub, updates, providers, and adapters.
//!
//! Native is `reqwest`; the WASI guest gets the same surface over `wasi:http`.
//! Both live in `genet-http` so the agent shares one client with the daemon.

pub use genet_http::*;
