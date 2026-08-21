//! Outbound HTTP for the daemon and the agent, in one shape.
//!
//! Native is `reqwest`, re-exported unchanged. The WASI guest gets the same
//! surface over `wasi:http`, where TLS, DNS and the socket live in the host and
//! the guest only ever sees the protocol (v2 proposal §6.5).
//!
//! The guest types are `Send`: a `wasi:http` resource is an `AtomicU32` handle,
//! not a `JsValue`. That is why this exists at all — `reqwest`'s own wasm
//! backend targets the browser, and its `!Send` futures cannot cross the
//! `tokio::spawn` the providers stream through.

#[cfg(not(target_family = "wasm"))]
pub use reqwest::{
    get, header, redirect, Client, ClientBuilder, Error, IntoUrl, RequestBuilder, Response,
    StatusCode, Url,
};

#[cfg(target_family = "wasm")]
mod wasi_http;

#[cfg(target_family = "wasm")]
pub use wasi_http::*;
