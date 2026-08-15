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

/// First version of the platform/logic lifecycle contract.
pub const LOGIC_ABI_VERSION: u32 = 11;
