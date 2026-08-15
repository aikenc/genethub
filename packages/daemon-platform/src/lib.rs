//! Native trust and VM kernel for the daemon's updatable Rust/Wasm application.
//!
//! This crate intentionally knows nothing about sessions, adapters, devices or
//! GeneHub's wire protocol. Its public API is limited to signed artifacts,
//! Wasmtime lifecycle, durable activation slots and recovery.

mod artifact;
mod error;
mod runtime;
mod store;
mod vm;

pub use artifact::{ArtifactEnvelope, ArtifactVerifier, SignedArtifact, VerifiedArtifact};
pub use error::{PlatformError, Result};
pub use runtime::{ActiveLogic, ActiveOrigin, PlatformRuntime};
pub use vm::{
    CapabilityHandler, LogicInstance, LogicVm, VmLimits, VmPolicy, WasiPolicy, WasiPreopen,
};

/// The platform and guest consume one Rust contract crate, so artifact signing
/// and VM admission cannot silently drift to different ABI numbers.
pub use genet_daemon_logic_api::ABI_VERSION as LOGIC_ABI_VERSION;
